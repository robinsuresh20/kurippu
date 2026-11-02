import { IStorageAdapter, DriveFolderInfo, ApplicationManifest, NoteDocument } from '../../types/storage';
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

    let root = Array.from(this.files.values()).find(
      f => f.appProperties['kurippuRole'] === 'root' && !f.trashed
    );

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
      };
      this.files.set(rootId, root);
    }

    let notes = Array.from(this.files.values()).find(
      f => f.parents.includes(root!.id) && f.appProperties['kurippuRole'] === 'notesFolder' && !f.trashed
    );

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
      };
      this.files.set(notesId, notes);
    }

    const manifest = Array.from(this.files.values()).find(
      f => f.parents.includes(root!.id) && f.appProperties['kurippuRole'] === 'manifest' && !f.trashed
    );

    return {
      rootFolderId: root.id,
      notesFolderId: notes.id,
      manifestFileId: manifest?.id,
    };
  }

  async getManifest(folderInfo: DriveFolderInfo): Promise<{ manifest: ApplicationManifest; version?: number } | null> {
    this.checkNetwork();

    if (!folderInfo.manifestFileId) return null;
    const file = this.files.get(folderInfo.manifestFileId);
    if (!file || file.trashed) return null;

    return {
      manifest: JSON.parse(file.content),
      version: file.version,
    };
  }

  async saveManifest(folderInfo: DriveFolderInfo, manifest: ApplicationManifest): Promise<{ fileId: string; version: number }> {
    this.checkNetwork();

    let file: MockFile | undefined;
    if (folderInfo.manifestFileId && this.files.has(folderInfo.manifestFileId)) {
      file = this.files.get(folderInfo.manifestFileId)!;
      file.content = JSON.stringify(manifest);
      file.version += 1;
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
      };
      this.files.set(id, file);
      folderInfo.manifestFileId = id;
    }

    return { fileId: file.id, version: file.version };
  }

  async getNote(noteId: string, folderInfo: DriveFolderInfo): Promise<{ note: NoteDocument; version?: number } | null> {
    this.checkNetwork();

    const file = Array.from(this.files.values()).find(
      f => f.parents.includes(folderInfo.notesFolderId) && f.appProperties['kurippuNoteId'] === noteId && !f.trashed
    );
    if (!file) return null;

    const note = JSON.parse(file.content) as NoteDocument;
    note.driveFileId = file.id;
    return { note, version: file.version };
  }

  async saveNote(note: NoteDocument, folderInfo: DriveFolderInfo): Promise<{ fileId: string; version: number; contentHash: string }> {
    this.checkNetwork();

    const hash = note.contentHash || (await computeContentHash(note.content));
    const payload = { ...note, contentHash: hash };

    let file = Array.from(this.files.values()).find(
      f => f.parents.includes(folderInfo.notesFolderId) && f.appProperties['kurippuNoteId'] === note.id && !f.trashed
    );

    if (file) {
      file.content = JSON.stringify(payload);
      file.version += 1;
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
      };
      this.files.set(id, file);
    }

    return { fileId: file.id, version: file.version, contentHash: hash };
  }

  async listDriveNotes(folderInfo: DriveFolderInfo): Promise<{ fileId: string; name: string; appProperties?: Record<string, string>; version?: number }[]> {
    this.checkNetwork();

    return Array.from(this.files.values())
      .filter(f => f.parents.includes(folderInfo.notesFolderId) && f.appProperties['kurippuRole'] === 'note' && !f.trashed)
      .map(f => ({
        fileId: f.id,
        name: f.name,
        appProperties: f.appProperties,
        version: f.version,
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
