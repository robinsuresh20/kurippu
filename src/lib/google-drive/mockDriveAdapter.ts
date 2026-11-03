import { IStorageAdapter, DriveFolderInfo, ApplicationManifest, NoteDocument, DuplicateFileRecord } from '../../types/storage';
import { computeContentHash } from '../storage/hash';

export interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: string;
  version: number;
  appProperties: Record<string, string>;
  trashed: boolean;
  modifiedTime?: string;
}

export class MockDriveAdapter implements IStorageAdapter {
  public files = new Map<string, MockFile>();
  public shouldFailNext = false;
  public failWithStatus = 500;
  public simulateRateLimitCount = 0;
  public networkConnected = true;
  private idCounter = 1000;

  private generateId(prefix = 'mock_file_') {
    return `${prefix}${++this.idCounter}`;
  }

  reset() {
    this.files.clear();
    this.shouldFailNext = false;
    this.simulateRateLimitCount = 0;
    this.networkConnected = true;
  }

  private checkNetwork() {
    if (!this.networkConnected) {
      throw new Error('Network error: Device is offline');
    }
    if (this.simulateRateLimitCount > 0) {
      this.simulateRateLimitCount--;
      const err: any = new Error('Rate limit exceeded (HTTP 429)');
      err.status = 429;
      throw err;
    }
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      const err: any = new Error(`Simulated Drive error (${this.failWithStatus})`);
      err.status = this.failWithStatus;
      throw err;
    }
  }

  async discoverOrCreateAppFolders(): Promise<DriveFolderInfo> {
    this.checkNetwork();

    const rootFiles = Array.from(this.files.values())
      .filter(f => (f.appProperties['kurippuRole'] === 'root' || f.name === 'Kurippu Knowledge Base') && !f.trashed)
      .sort((a, b) => (b.version || 0) - (a.version || 0));

    let root = rootFiles[0];

    if (!root) {
      const rootId = this.generateId('folder_root_');
      root = {
        id: rootId,
        name: 'Kurippu Knowledge Base',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [],
        content: '',
        version: 1,
        appProperties: { kurippuApp: 'true', kurippuRole: 'root' },
        trashed: false,
        modifiedTime: new Date().toISOString(),
      };
      this.files.set(rootId, root);
    }

    const notesFiles = Array.from(this.files.values())
      .filter(f => f.parents.includes(root!.id) && (f.appProperties['kurippuRole'] === 'notesFolder' || f.name === 'notes') && !f.trashed)
      .sort((a, b) => (b.version || 0) - (a.version || 0));

    let notes = notesFiles[0];

    if (!notes) {
      const notesId = this.generateId('folder_notes_');
      notes = {
        id: notesId,
        name: 'notes',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [root.id],
        content: '',
        version: 1,
        appProperties: { kurippuApp: 'true', kurippuRole: 'notesFolder' },
        trashed: false,
        modifiedTime: new Date().toISOString(),
      };
      this.files.set(notesId, notes);
    }

    const manifestFiles = Array.from(this.files.values())
      .filter(f => f.parents.includes(root!.id) && (f.appProperties['kurippuRole'] === 'manifest' || f.name === 'manifest.json') && !f.trashed)
      .sort((a, b) => (b.version || 0) - (a.version || 0));

    const manifest = manifestFiles[0];
    const duplicateManifestFileIds = manifestFiles.length > 1 ? manifestFiles.slice(1).map(f => f.id) : undefined;

    return {
      rootFolderId: root.id,
      notesFolderId: notes.id,
      manifestFileId: manifest?.id,
      duplicateManifestFileIds,
    };
  }

  async getManifest(folderInfo: DriveFolderInfo): Promise<{ manifest: ApplicationManifest; version?: number } | null> {
    this.checkNetwork();

    if (!folderInfo.manifestFileId) {
      const manifest = Array.from(this.files.values()).find(
        f => f.parents.includes(folderInfo.rootFolderId) && (f.appProperties['kurippuRole'] === 'manifest' || f.name === 'manifest.json') && !f.trashed
      );
      if (manifest) {
        folderInfo.manifestFileId = manifest.id;
      }
    }

    if (!folderInfo.manifestFileId) return null;
    const file = this.files.get(folderInfo.manifestFileId);
    if (!file || file.trashed) return null;

    const manifest: ApplicationManifest = JSON.parse(file.content);
    if (folderInfo.duplicateManifestFileIds && folderInfo.duplicateManifestFileIds.length > 0) {
      manifest.duplicateManifestFileIds = folderInfo.duplicateManifestFileIds;
    }

    return {
      manifest,
      version: file.version,
    };
  }

  async saveManifest(folderInfo: DriveFolderInfo, manifest: ApplicationManifest): Promise<{ fileId: string; version: number }> {
    this.checkNetwork();

    if (folderInfo.duplicateManifestFileIds && (!manifest.duplicateManifestFileIds || manifest.duplicateManifestFileIds.length === 0)) {
      manifest.duplicateManifestFileIds = folderInfo.duplicateManifestFileIds;
    }

    let file: MockFile | undefined;
    if (folderInfo.manifestFileId && this.files.has(folderInfo.manifestFileId)) {
      file = this.files.get(folderInfo.manifestFileId)!;
    } else {
      // Search if manifest already exists in rootFolderId, selecting newest by version
      const existingManifests = Array.from(this.files.values())
        .filter(f => f.parents.includes(folderInfo.rootFolderId) && f.appProperties['kurippuRole'] === 'manifest' && !f.trashed)
        .sort((a, b) => (b.version || 0) - (a.version || 0));
      file = existingManifests[0];
    }

    if (file) {
      file.content = JSON.stringify(manifest);
      file.version += 1;
      file.modifiedTime = new Date().toISOString();
      folderInfo.manifestFileId = file.id;
    } else {
      const id = this.generateId('file_manifest_');
      file = {
        id,
        name: 'manifest.json',
        mimeType: 'application/json',
        parents: [folderInfo.rootFolderId],
        content: JSON.stringify(manifest),
        version: 1,
        appProperties: { kurippuApp: 'true', kurippuRole: 'manifest' },
        trashed: false,
        modifiedTime: new Date().toISOString(),
      };
      this.files.set(id, file);
      folderInfo.manifestFileId = id;
    }

    return { fileId: file.id, version: file.version };
  }

  async getNote(
    noteId: string,
    folderInfo: DriveFolderInfo,
    driveFileId?: string
  ): Promise<{ note: NoteDocument; version?: number; duplicates?: DuplicateFileRecord[] } | null> {
    this.checkNetwork();

    let canonical: MockFile | undefined;
    let duplicates: DuplicateFileRecord[] = [];

    if (driveFileId && this.files.has(driveFileId)) {
      const file = this.files.get(driveFileId)!;
      if (!file.trashed) {
        canonical = file;
      }
    }

    if (!canonical) {
      const matchingFiles = Array.from(this.files.values())
        .filter(f => f.parents.includes(folderInfo.notesFolderId) && f.appProperties['kurippuNoteId'] === noteId && !f.trashed)
        .sort((a, b) => (b.version || 0) - (a.version || 0));

      if (matchingFiles.length === 0) return null;

      canonical = matchingFiles[0];
      duplicates = matchingFiles.slice(1).map(f => ({
        fileId: f.id,
        version: f.version,
        modifiedTime: f.modifiedTime,
      }));
    }

    const note = JSON.parse(canonical.content) as NoteDocument;
    note.driveFileId = canonical.id;
    if (duplicates.length > 0) {
      note.duplicateDriveFileIds = duplicates.map(d => d.fileId);
    }

    return {
      note,
      version: canonical.version,
      duplicates: duplicates.length > 0 ? duplicates : undefined,
    };
  }

  async saveNote(note: NoteDocument, folderInfo: DriveFolderInfo): Promise<{ fileId: string; version: number; contentHash: string }> {
    this.checkNetwork();

    const hash = note.contentHash || (await computeContentHash(note.content));
    const payload = { ...note, contentHash: hash };

    // Find file by note.driveFileId first, or by appProperties.kurippuNoteId
    let file = note.driveFileId ? this.files.get(note.driveFileId) : undefined;
    if (!file) {
      const matching = Array.from(this.files.values())
        .filter(f => f.parents.includes(folderInfo.notesFolderId) && f.appProperties['kurippuNoteId'] === note.id && !f.trashed)
        .sort((a, b) => (b.version || 0) - (a.version || 0));
      file = matching[0];
      if (matching.length > 1) {
        note.duplicateDriveFileIds = matching.slice(1).map(f => f.id);
      }
    }

    if (file) {
      file.content = JSON.stringify(payload);
      file.version += 1;
      file.modifiedTime = new Date().toISOString();
      note.driveFileId = file.id;
    } else {
      const id = this.generateId(`file_note_${note.id}_`);
      file = {
        id,
        name: `${note.id}.json`,
        mimeType: 'application/json',
        parents: [folderInfo.notesFolderId],
        content: JSON.stringify(payload),
        version: 1,
        appProperties: { kurippuApp: 'true', kurippuRole: 'note', kurippuNoteId: note.id },
        trashed: false,
        modifiedTime: new Date().toISOString(),
      };
      this.files.set(id, file);
      note.driveFileId = id;
    }

    return { fileId: file.id, version: file.version, contentHash: hash };
  }

  async listDriveNotes(
    folderInfo: DriveFolderInfo
  ): Promise<{ fileId: string; name: string; appProperties?: Record<string, string>; version?: number; modifiedTime?: string }[]> {
    this.checkNetwork();

    if (!folderInfo?.notesFolderId || !folderInfo.notesFolderId.trim()) {
      throw new Error('Cannot list Drive notes: notesFolderId is missing or uninitialized.');
    }

    return Array.from(this.files.values())
      .filter(f => f.parents.includes(folderInfo.notesFolderId) && f.appProperties['kurippuRole'] === 'note' && !f.trashed)
      .map(f => ({
        fileId: f.id,
        name: f.name,
        appProperties: f.appProperties,
        version: f.version,
        modifiedTime: f.modifiedTime,
      }));
  }

  async deleteNoteFile(fileId: string): Promise<void> {
    this.checkNetwork();
    const file = this.files.get(fileId);
    if (file) {
      file.trashed = true;
    }
  }
}
