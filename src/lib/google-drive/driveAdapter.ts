import { IStorageAdapter, DriveFolderInfo, ApplicationManifest, NoteDocument } from '../../types/storage';
import { computeContentHash } from '../storage/hash';

export class GoogleDriveStorageAdapter implements IStorageAdapter {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  setAccessToken(token: string) {
    this.accessToken = token;
  }

  private async fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 4, baseDelay = 500): Promise<Response> {
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${this.accessToken}`);

        const response = await fetch(url, { ...options, headers });

        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          attempt++;
          if (attempt > maxRetries) return response;
          const jitter = Math.random() * 200;
          const delay = baseDelay * Math.pow(2, attempt) + jitter;
          console.warn(`[DriveAPI] Rate limited (${response.status}). Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        return response;
      } catch (err) {
        attempt++;
        if (attempt > maxRetries) throw err;
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[DriveAPI] Network failure. Retrying in ${delay}ms...`, err);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error(`Drive request failed after ${maxRetries} retries.`);
  }

  async discoverOrCreateAppFolders(): Promise<DriveFolderInfo> {
    // 1. Search for root folder via appProperties
    const rootQuery = encodeURIComponent("appProperties has { key='kurippuRole' and value='root' } and trashed=false");
    const rootRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files?q=${rootQuery}&fields=files(id,name,appProperties)`);
    if (!rootRes.ok) {
      throw new Error(`Failed to query root folder: ${rootRes.status} ${rootRes.statusText}`);
    }
    const rootData = await rootRes.json();
    let rootFolderId = rootData.files?.[0]?.id;

    if (!rootFolderId) {
      // Create root folder
      const createRes = await this.fetchWithRetry('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Kurippu Knowledge Base',
          mimeType: 'application/vnd.google-apps.folder',
          appProperties: {
            kurippuApp: 'true',
            kurippuRole: 'root',
            kurippuWorkspaceId: 'default',
            kurippuSchemaVersion: '1',
          },
        }),
      });
      if (!createRes.ok) throw new Error(`Failed to create root folder: ${createRes.status}`);
      const created = await createRes.json();
      rootFolderId = created.id;
    }

    // 2. Search for notes subfolder
    const notesQuery = encodeURIComponent(`'${rootFolderId}' in parents and appProperties has { key='kurippuRole' and value='notesFolder' } and trashed=false`);
    const notesRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files?q=${notesQuery}&fields=files(id,name)`);
    const notesData = await notesRes.json();
    let notesFolderId = notesData.files?.[0]?.id;

    if (!notesFolderId) {
      const createNotesRes = await this.fetchWithRetry('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'notes',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootFolderId],
          appProperties: {
            kurippuApp: 'true',
            kurippuRole: 'notesFolder',
          },
        }),
      });
      const createdNotes = await createNotesRes.json();
      notesFolderId = createdNotes.id;
    }

    // 3. Search for manifest file
    const manifestQuery = encodeURIComponent(`'${rootFolderId}' in parents and appProperties has { key='kurippuRole' and value='manifest' } and trashed=false`);
    const manifestRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files?q=${manifestQuery}&fields=files(id,name)`);
    const manifestData = await manifestRes.json();
    const manifestFileId = manifestData.files?.[0]?.id;

    return {
      rootFolderId,
      notesFolderId,
      manifestFileId,
    };
  }

  async getManifest(folderInfo: DriveFolderInfo): Promise<{ manifest: ApplicationManifest; version?: number } | null> {
    if (!folderInfo.manifestFileId) return null;

    const res = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${folderInfo.manifestFileId}?alt=media`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);

    const metaRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${folderInfo.manifestFileId}?fields=version`);
    const meta = metaRes.ok ? await metaRes.json() : {};

    const manifest = await res.json();
    return { manifest, version: meta.version ? parseInt(meta.version, 10) : undefined };
  }

  async saveManifest(folderInfo: DriveFolderInfo, manifest: ApplicationManifest): Promise<{ fileId: string; version: number }> {
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadata = {
      name: 'manifest.json',
      mimeType: 'application/json',
      ...(!folderInfo.manifestFileId ? { parents: [folderInfo.rootFolderId] } : {}),
      appProperties: {
        kurippuApp: 'true',
        kurippuRole: 'manifest',
        kurippuWorkspaceId: manifest.workspaceId,
      },
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(manifest) +
      closeDelimiter;

    const url = folderInfo.manifestFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${folderInfo.manifestFileId}?uploadType=multipart&fields=id,version`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version';

    const res = await this.fetchWithRetry(url, {
      method: folderInfo.manifestFileId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    });

    if (!res.ok) {
      throw new Error(`Failed to upload manifest: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return { fileId: data.id, version: parseInt(data.version || '1', 10) };
  }

  async getNote(noteId: string, folderInfo: DriveFolderInfo): Promise<{ note: NoteDocument; version?: number } | null> {
    const q = encodeURIComponent(`'${folderInfo.notesFolderId}' in parents and appProperties has { key='kurippuNoteId' and value='${noteId}' } and trashed=false`);
    const searchRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,version)`);
    if (!searchRes.ok) return null;

    const data = await searchRes.json();
    const file = data.files?.[0];
    if (!file) return null;

    const contentRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
    if (!contentRes.ok) return null;

    const note = await contentRes.json();
    note.driveFileId = file.id;
    return { note, version: parseInt(file.version || '1', 10) };
  }

  async saveNote(note: NoteDocument, folderInfo: DriveFolderInfo): Promise<{ fileId: string; version: number; contentHash: string }> {
    const hash = note.contentHash || (await computeContentHash(note.content));
    const payload = { ...note, contentHash: hash };

    const boundary = '-------kurippuboundary4920';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadata = {
      name: `${note.id}.json`,
      mimeType: 'application/json',
      ...(!note.driveFileId ? { parents: [folderInfo.notesFolderId] } : {}),
      appProperties: {
        kurippuApp: 'true',
        kurippuRole: 'note',
        kurippuNoteId: note.id,
      },
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(payload) +
      closeDelimiter;

    const url = note.driveFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${note.driveFileId}?uploadType=multipart&fields=id,version`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version';

    const res = await this.fetchWithRetry(url, {
      method: note.driveFileId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    });

    if (!res.ok) {
      throw new Error(`Failed to save note ${note.id}: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return { fileId: data.id, version: parseInt(data.version || '1', 10), contentHash: hash };
  }

  async listDriveNotes(folderInfo: DriveFolderInfo): Promise<{ fileId: string; name: string; appProperties?: Record<string, string>; version?: number }[]> {
    const q = encodeURIComponent(`'${folderInfo.notesFolderId}' in parents and appProperties has { key='kurippuRole' and value='note' } and trashed=false`);
    const res = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,appProperties,version)`);
    if (!res.ok) throw new Error(`Failed to list note files: ${res.status}`);
    const data = await res.json();
    return (data.files || []).map((f: any) => ({
      fileId: f.id,
      name: f.name,
      appProperties: f.appProperties,
      version: f.version ? parseInt(f.version, 10) : undefined,
    }));
  }

  async deleteNoteFile(fileId: string): Promise<void> {
    const res = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete file ${fileId}: ${res.status}`);
    }
  }
}
