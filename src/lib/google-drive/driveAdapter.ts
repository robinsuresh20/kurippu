import { IStorageAdapter, DriveFolderInfo, ApplicationManifest, NoteDocument, DuplicateFileRecord, GoogleUserProfile } from '../../types/storage';
import { computeContentHash } from '../storage/hash';

export class GoogleDriveStorageAdapter implements IStorageAdapter {
  private accessToken: string;
  private cachedFolderInfo: DriveFolderInfo | null = null;
  public readonly accountId?: string;

  constructor(accessToken: string, accountId?: string) {
    this.accessToken = accessToken;
    this.accountId = accountId;
  }

  setAccessToken(token: string, forAccountId?: string) {
    if (forAccountId && this.accountId && forAccountId !== this.accountId) {
      throw new Error(`Cannot assign token for account "${forAccountId}" to adapter bound to "${this.accountId}".`);
    }
    if (this.accessToken !== token) {
      this.cachedFolderInfo = null;
    }
    this.accessToken = token;
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  async getUserProfile(): Promise<GoogleUserProfile> {
    const res = await this.fetchWithRetry(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId,photoLink)'
    );
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to fetch Google user profile');
    }
    const data = await res.json();
    const user = data.user;
    if (!user || !user.permissionId || typeof user.permissionId !== 'string' || !user.permissionId.trim()) {
      throw new Error('Google Drive API response did not contain a valid user permissionId.');
    }
    return {
      displayName: user.displayName || 'Google Drive User',
      emailAddress: user.emailAddress || 'Unknown Email',
      permissionId: user.permissionId.trim(),
      photoLink: user.photoLink,
    };
  }

  private async fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 4, baseDelay = 500): Promise<Response> {
    const tokenForRequest = this.accessToken;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const headers = new Headers(options.headers || {});
        if (tokenForRequest) {
          headers.set('Authorization', `Bearer ${tokenForRequest}`);
        }

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
      } catch (err: any) {
        attempt++;
        if (attempt > maxRetries) throw err;
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[DriveAPI] Network failure. Retrying in ${delay}ms...`, err);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error(`Drive request failed after ${maxRetries} retries.`);
  }

  private async parseErrorResponse(res: Response, fallbackPrefix: string): Promise<Error> {
    let errorDetails = '';
    try {
      const errJson = await res.json();
      errorDetails = errJson.error?.message || JSON.stringify(errJson.error) || '';
    } catch {
      errorDetails = await res.text().catch(() => '');
    }
    // Redact tokens
    errorDetails = errorDetails.replace(/ya29\.[a-zA-Z0-9_\-]+/g, '[REDACTED_TOKEN]');
    return new Error(`${fallbackPrefix}: ${res.status} ${res.statusText}${errorDetails ? ` - ${errorDetails}` : ''}`);
  }

  async discoverOrCreateAppFolders(forceRefresh = false): Promise<DriveFolderInfo> {
    if (this.cachedFolderInfo && !forceRefresh) {
      return this.cachedFolderInfo;
    }

    // 1. Search for root folder via appProperties, ordered by newest first
    const rootQuery = encodeURIComponent("appProperties has { key='kurippuRole' and value='root' } and trashed=false");
    const rootRes = await this.fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files?q=${rootQuery}&orderBy=modifiedTime desc&fields=files(id,name,appProperties,version,modifiedTime)`
    );
    if (!rootRes.ok) {
      throw await this.parseErrorResponse(rootRes, 'Failed to query root folder');
    }
    const rootData = await rootRes.json();
    let rootFiles = rootData.files || [];
    let rootFolderId = rootFiles[0]?.id;

    // Fallback: Query by folder name and MIME type if appProperties search returns empty (e.g. cross-session indexing latency)
    if (!rootFolderId) {
      const nameQuery = encodeURIComponent("name = 'Kurippu Knowledge Base' and mimeType = 'application/vnd.google-apps.folder' and trashed=false");
      const nameRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${nameQuery}&orderBy=modifiedTime desc&fields=files(id,name,appProperties,version,modifiedTime)`
      );
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        rootFiles = nameData.files || [];
        rootFolderId = rootFiles[0]?.id;
        if (rootFolderId) {
          console.log(`[DriveAdapter] Found existing root folder via name fallback: ${rootFolderId}`);
        }
      }
    }

    if (rootFiles.length > 1) {
      console.warn(`[DriveAdapter] Multiple root folders detected (${rootFiles.length}). Using newest canonical root: ${rootFolderId}`);
    }

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
      if (!createRes.ok) throw await this.parseErrorResponse(createRes, 'Failed to create root folder');
      const created = await createRes.json();
      rootFolderId = created.id;
    }

    // 2. Search for notes subfolder
    const notesQuery = encodeURIComponent(
      `'${rootFolderId}' in parents and appProperties has { key='kurippuRole' and value='notesFolder' } and trashed=false`
    );
    const notesRes = await this.fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files?q=${notesQuery}&orderBy=modifiedTime desc&fields=files(id,name,version,modifiedTime)`
    );
    if (!notesRes.ok) throw await this.parseErrorResponse(notesRes, 'Failed to query notes folder');
    const notesData = await notesRes.json();
    let notesFiles = notesData.files || [];
    let notesFolderId = notesFiles[0]?.id;

    // Fallback: Query notes subfolder by name if appProperties search returns empty
    if (!notesFolderId) {
      const nameQuery = encodeURIComponent(
        `'${rootFolderId}' in parents and name = 'notes' and mimeType = 'application/vnd.google-apps.folder' and trashed=false`
      );
      const nameRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${nameQuery}&orderBy=modifiedTime desc&fields=files(id,name,version,modifiedTime)`
      );
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        notesFiles = nameData.files || [];
        notesFolderId = notesFiles[0]?.id;
        if (notesFolderId) {
          console.log(`[DriveAdapter] Found existing notes folder via name fallback: ${notesFolderId}`);
        }
      }
    }

    if (notesFiles.length > 1) {
      console.warn(`[DriveAdapter] Multiple notes folders detected (${notesFiles.length}). Using newest canonical: ${notesFolderId}`);
    }

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
      if (!createNotesRes.ok) throw await this.parseErrorResponse(createNotesRes, 'Failed to create notes folder');
      const createdNotes = await createNotesRes.json();
      notesFolderId = createdNotes.id;
    }

    // 3. Search for manifest file
    const manifestQuery = encodeURIComponent(
      `'${rootFolderId}' in parents and appProperties has { key='kurippuRole' and value='manifest' } and trashed=false`
    );
    const manifestRes = await this.fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files?q=${manifestQuery}&orderBy=modifiedTime desc&fields=files(id,name,version,modifiedTime)`
    );
    if (!manifestRes.ok) throw await this.parseErrorResponse(manifestRes, 'Failed to query manifest file');
    const manifestData = await manifestRes.json();
    let manifestFiles = manifestData.files || [];
    let manifestFileId = manifestFiles[0]?.id;

    // Fallback: Query manifest file by name if appProperties search returns empty
    if (!manifestFileId) {
      const nameQuery = encodeURIComponent(
        `'${rootFolderId}' in parents and name = 'manifest.json' and trashed=false`
      );
      const nameRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${nameQuery}&orderBy=modifiedTime desc&fields=files(id,name,version,modifiedTime)`
      );
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        manifestFiles = nameData.files || [];
        manifestFileId = manifestFiles[0]?.id;
        if (manifestFileId) {
          console.log(`[DriveAdapter] Found existing manifest file via name fallback: ${manifestFileId}`);
        }
      }
    }

    const duplicateManifestFileIds = manifestFiles.length > 1 ? manifestFiles.slice(1).map((f: any) => f.id) : undefined;

    if (manifestFiles.length > 1) {
      console.warn(
        `[DriveAdapter] Multiple manifest files detected (${manifestFiles.length}). Using newest: ${manifestFileId}. Preserving duplicates.`
      );
    }

    this.cachedFolderInfo = {
      rootFolderId,
      notesFolderId,
      manifestFileId,
      duplicateManifestFileIds,
    };

    return this.cachedFolderInfo;
  }

  async getManifest(folderInfo: DriveFolderInfo): Promise<{ manifest: ApplicationManifest; version?: number } | null> {
    // If manifestFileId is missing, attempt to discover it
    if (!folderInfo.manifestFileId) {
      const manifestQuery = encodeURIComponent(
        `'${folderInfo.rootFolderId}' in parents and appProperties has { key='kurippuRole' and value='manifest' } and trashed=false`
      );
      const manifestRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${manifestQuery}&orderBy=modifiedTime desc&fields=files(id,name,version)`
      );
      if (manifestRes.ok) {
        const manifestData = await manifestRes.json();
        if (manifestData.files && manifestData.files.length > 0) {
          folderInfo.manifestFileId = manifestData.files[0].id;
          if (this.cachedFolderInfo) this.cachedFolderInfo.manifestFileId = manifestData.files[0].id;
        }
      }
      // Fallback search by name if appProperties didn't match
      if (!folderInfo.manifestFileId) {
        const nameQuery = encodeURIComponent(
          `'${folderInfo.rootFolderId}' in parents and name = 'manifest.json' and trashed=false`
        );
        const nameRes = await this.fetchWithRetry(
          `https://www.googleapis.com/drive/v3/files?q=${nameQuery}&orderBy=modifiedTime desc&fields=files(id,name,version)`
        );
        if (nameRes.ok) {
          const nameData = await nameRes.json();
          if (nameData.files && nameData.files.length > 0) {
            folderInfo.manifestFileId = nameData.files[0].id;
            if (this.cachedFolderInfo) this.cachedFolderInfo.manifestFileId = nameData.files[0].id;
          }
        }
      }
    }

    if (!folderInfo.manifestFileId) return null;

    const res = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${folderInfo.manifestFileId}?alt=media`);
    if (res.status === 404) {
      folderInfo.manifestFileId = undefined;
      if (this.cachedFolderInfo) this.cachedFolderInfo.manifestFileId = undefined;
      return null;
    }
    if (!res.ok) throw await this.parseErrorResponse(res, `Failed to fetch manifest ${folderInfo.manifestFileId}`);

    const metaRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${folderInfo.manifestFileId}?fields=version`);
    const meta = metaRes.ok ? await metaRes.json() : {};

    const manifest: ApplicationManifest = await res.json();
    if (folderInfo.duplicateManifestFileIds && folderInfo.duplicateManifestFileIds.length > 0) {
      manifest.duplicateManifestFileIds = folderInfo.duplicateManifestFileIds;
    }

    return { manifest, version: meta.version ? parseInt(meta.version, 10) : undefined };
  }

  async saveManifest(folderInfo: DriveFolderInfo, manifest: ApplicationManifest): Promise<{ fileId: string; version: number }> {
    // Defensive check: If manifestFileId is undefined, search Drive first to avoid creating duplicate manifest files
    if (!folderInfo.manifestFileId) {
      const manifestQuery = encodeURIComponent(
        `'${folderInfo.rootFolderId}' in parents and appProperties has { key='kurippuRole' and value='manifest' } and trashed=false`
      );
      const searchRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${manifestQuery}&orderBy=modifiedTime desc&fields=files(id,name,version)`
      );
      if (searchRes.ok) {
        const data = await searchRes.json();
        if (data.files && data.files.length > 0) {
          folderInfo.manifestFileId = data.files[0].id;
          if (this.cachedFolderInfo) this.cachedFolderInfo.manifestFileId = data.files[0].id;
          if (data.files.length > 1) {
            folderInfo.duplicateManifestFileIds = data.files.slice(1).map((f: any) => f.id);
            console.warn(`[DriveAdapter] Multiple manifest files found. Reusing newest: ${folderInfo.manifestFileId}`);
          }
        }
      }
      if (!folderInfo.manifestFileId) {
        const nameQuery = encodeURIComponent(
          `'${folderInfo.rootFolderId}' in parents and name = 'manifest.json' and trashed=false`
        );
        const nameRes = await this.fetchWithRetry(
          `https://www.googleapis.com/drive/v3/files?q=${nameQuery}&orderBy=modifiedTime desc&fields=files(id,name,version)`
        );
        if (nameRes.ok) {
          const nameData = await nameRes.json();
          if (nameData.files && nameData.files.length > 0) {
            folderInfo.manifestFileId = nameData.files[0].id;
            if (this.cachedFolderInfo) this.cachedFolderInfo.manifestFileId = nameData.files[0].id;
            if (nameData.files.length > 1) {
              folderInfo.duplicateManifestFileIds = nameData.files.slice(1).map((f: any) => f.id);
              console.warn(`[DriveAdapter] Multiple manifest files found via name fallback. Reusing newest: ${folderInfo.manifestFileId}`);
            }
          }
        }
      }
    }

    if (folderInfo.duplicateManifestFileIds && (!manifest.duplicateManifestFileIds || manifest.duplicateManifestFileIds.length === 0)) {
      manifest.duplicateManifestFileIds = folderInfo.duplicateManifestFileIds;
    }

    const boundary = '-------kurippumanifestboundary7823';
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
      throw await this.parseErrorResponse(res, 'Failed to upload manifest');
    }

    const data = await res.json();
    // Always persist manifestFileId onto folderInfo to ensure subsequent saves use PATCH!
    folderInfo.manifestFileId = data.id;
    if (this.cachedFolderInfo) {
      this.cachedFolderInfo.manifestFileId = data.id;
    }
    return { fileId: data.id, version: parseInt(data.version || '1', 10) };
  }

  async getNote(
    noteId: string,
    folderInfo: DriveFolderInfo,
    driveFileId?: string
  ): Promise<{ note: NoteDocument; version?: number; duplicates?: DuplicateFileRecord[] } | null> {
    let canonicalFile: any;
    let duplicates: DuplicateFileRecord[] = [];

    // 1. If driveFileId is provided, attempt direct fetch for strong consistency and fast lookup
    if (driveFileId) {
      const directRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?fields=id,name,version,modifiedTime,createdTime,appProperties,trashed`
      );
      if (directRes.ok) {
        const fileData = await directRes.json();
        if (!fileData.trashed) {
          canonicalFile = fileData;
        }
      }
    }

    // 2. Fall back to search query if not directly fetched
    if (!canonicalFile) {
      if (!folderInfo?.notesFolderId || !folderInfo.notesFolderId.trim()) {
        throw new Error('Cannot query note file: notesFolderId is missing or uninitialized.');
      }
      const q = encodeURIComponent(
        `'${folderInfo.notesFolderId}' in parents and appProperties has { key='kurippuNoteId' and value='${noteId}' } and trashed=false`
      );
      const searchRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,version,modifiedTime,createdTime,appProperties)`
      );
      if (!searchRes.ok) return null;

      const data = await searchRes.json();
      const files = data.files || [];
      if (files.length === 0) return null;

      canonicalFile = files[0];
      duplicates = files.slice(1).map((f: any) => ({
        fileId: f.id,
        version: f.version ? parseInt(f.version, 10) : undefined,
        modifiedTime: f.modifiedTime,
      }));

      if (files.length > 1) {
        console.warn(
          `[DriveAdapter] Found ${files.length} duplicate files for noteId "${noteId}". Selecting newest canonical: ${canonicalFile.id} (v${canonicalFile.version}, modified: ${canonicalFile.modifiedTime}). Preserving other ${duplicates.length} duplicate(s) without deleting.`
        );
      }
    }

    const contentRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${canonicalFile.id}?alt=media`);
    if (!contentRes.ok) return null;

    const note = (await contentRes.json()) as NoteDocument;
    note.driveFileId = canonicalFile.id;
    if (duplicates.length > 0) {
      note.duplicateDriveFileIds = duplicates.map(d => d.fileId);
    }

    return {
      note,
      version: parseInt(canonicalFile.version || '1', 10),
      duplicates: duplicates.length > 0 ? duplicates : undefined,
    };
  }

  async saveNote(
    note: NoteDocument,
    folderInfo: DriveFolderInfo
  ): Promise<{ fileId: string; version: number; contentHash: string }> {
    const hash = note.contentHash || (await computeContentHash(note.content));
    const payload = { ...note, contentHash: hash };

    // Defensive check: If note.driveFileId is missing, search Drive to see if file already exists
    let targetFileId = note.driveFileId;
    if (!targetFileId) {
      const q = encodeURIComponent(
        `'${folderInfo.notesFolderId}' in parents and appProperties has { key='kurippuNoteId' and value='${note.id}' } and trashed=false`
      );
      const searchRes = await this.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,version,modifiedTime)`
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const existingFiles = searchData.files || [];
        if (existingFiles.length > 0) {
          targetFileId = existingFiles[0].id;
          note.driveFileId = targetFileId;
          if (existingFiles.length > 1) {
            note.duplicateDriveFileIds = existingFiles.slice(1).map((f: any) => f.id);
            console.warn(
              `[DriveAdapter] Found ${existingFiles.length} existing files for note "${note.id}". Reusing newest canonical file ${targetFileId}. Preserving duplicates.`
            );
          }
        }
      }
    }

    const boundary = '-------kurippunoteboundary4920';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    if (!targetFileId && (!folderInfo?.notesFolderId || !folderInfo.notesFolderId.trim())) {
      throw new Error('Cannot save note file: notesFolderId is missing or uninitialized.');
    }

    const metadata = {
      name: `${note.id}.json`,
      mimeType: 'application/json',
      ...(!targetFileId ? { parents: [folderInfo.notesFolderId] } : {}),
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

    const url = targetFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${targetFileId}?uploadType=multipart&fields=id,version`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version';

    const res = await this.fetchWithRetry(url, {
      method: targetFileId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    });

    if (!res.ok) {
      throw await this.parseErrorResponse(res, `Failed to save note ${note.id}`);
    }

    const data = await res.json();
    note.driveFileId = data.id;

    let version = data.version ? parseInt(data.version, 10) : undefined;
    if (version === undefined || isNaN(version)) {
      const metaRes = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${data.id}?fields=version`);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta.version) {
          version = parseInt(meta.version, 10);
        }
      }
    }

    return { fileId: data.id, version: version || 1, contentHash: hash };
  }

  async listDriveNotes(
    folderInfo: DriveFolderInfo
  ): Promise<{ fileId: string; name: string; appProperties?: Record<string, string>; version?: number; modifiedTime?: string }[]> {
    if (!folderInfo?.notesFolderId || !folderInfo.notesFolderId.trim()) {
      throw new Error('Cannot list Drive notes: notesFolderId is missing or uninitialized.');
    }
    const q = encodeURIComponent(
      `'${folderInfo.notesFolderId}' in parents and appProperties has { key='kurippuRole' and value='note' } and trashed=false`
    );
    const res = await this.fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,appProperties,version,modifiedTime)`
    );
    if (!res.ok) throw await this.parseErrorResponse(res, 'Failed to list note files');
    const data = await res.json();
    return (data.files || []).map((f: any) => ({
      fileId: f.id,
      name: f.name,
      appProperties: f.appProperties,
      version: f.version ? parseInt(f.version, 10) : undefined,
      modifiedTime: f.modifiedTime,
    }));
  }

  async deleteNoteFile(fileId: string): Promise<void> {
    const res = await this.fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw await this.parseErrorResponse(res, `Failed to delete file ${fileId}`);
    }
  }
}
