import { IStorageAdapter, DriveFolderInfo, NoteDocument, PersistenceState, SyncJob } from '../../types/storage';
import {
  peekNextPendingJob,
  removeSyncJob,
  updateSyncJob,
  getPendingJobCount,
  saveNoteLocal,
  saveManifestLocal,
  getManifestLocal,
} from '../../lib/indexeddb/cache';
import { resolveNoteConflict } from '../../lib/concurrency/conflictResolver';
import { computeContentHash } from '../../lib/storage/hash';

export interface SyncEngineListener {
  onStateChange: (state: PersistenceState, message?: string) => void;
  onJobCompleted: (job: SyncJob) => void;
  onConflictDetected: (originalNote: NoteDocument, conflictCopy: NoteDocument) => void;
}

export class SyncEngine {
  private adapter: IStorageAdapter;
  private folderInfo: DriveFolderInfo | null = null;
  private currentProcessPromise: Promise<void> | null = null;
  private isOffline = false;
  private state: PersistenceState = 'IDLE';
  private listeners = new Set<SyncEngineListener>();

  constructor(adapter: IStorageAdapter) {
    this.adapter = adapter;
  }

  setAdapter(adapter: IStorageAdapter) {
    this.adapter = adapter;
  }

  getState(): PersistenceState {
    return this.state;
  }

  setOffline(offline: boolean) {
    this.isOffline = offline;
    this.setState(offline ? 'OFFLINE' : 'IDLE', offline ? 'Offline mode enabled' : 'Online');
  }

  subscribe(listener: SyncEngineListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: PersistenceState, message?: string) {
    this.state = state;
    for (const l of this.listeners) {
      l.onStateChange(state, message);
    }
  }

  async initializeFolders(): Promise<DriveFolderInfo> {
    this.setState('SYNCING', 'Discovering application storage folders...');
    try {
      this.folderInfo = await this.adapter.discoverOrCreateAppFolders();
      this.setState('IDLE', 'Storage folders ready');
      return this.folderInfo;
    } catch (err: any) {
      this.setState('ERROR', `Folder discovery failed: ${err.message}`);
      throw err;
    }
  }

  async processQueue(): Promise<void> {
    if (this.isOffline) return;
    if (this.currentProcessPromise) {
      return this.currentProcessPromise;
    }

    this.currentProcessPromise = this._runProcessQueue().finally(() => {
      this.currentProcessPromise = null;
    });

    return this.currentProcessPromise;
  }

  private async _runProcessQueue(): Promise<void> {
    try {
      if (!this.folderInfo) {
        await this.initializeFolders();
      }

      let job = await peekNextPendingJob();
      while (job && !this.isOffline) {
        this.setState('SYNCING', `Processing sync job ${job.jobId} (${job.type})...`);

        try {
          if (job.type === 'SAVE_NOTE') {
            await this.processSaveNoteJob(job);
          }

          if (job.id !== undefined) {
            await removeSyncJob(job.id);
          }

          for (const l of this.listeners) {
            l.onJobCompleted(job);
          }
        } catch (jobErr: any) {
          console.error(`[SyncEngine] Job ${job.jobId} error:`, jobErr);

          if (jobErr.message?.includes('Network') || jobErr.message?.includes('offline') || jobErr.status === 401) {
            this.setState('OFFLINE', `Network failure during job ${job.jobId}. Changes buffered locally.`);
            job.status = 'pending';
            job.lastError = jobErr.message;
            if (job.id !== undefined) await updateSyncJob(job);
            break;
          }

          job.retryCount = (job.retryCount || 0) + 1;
          job.lastError = jobErr.message;
          if (job.retryCount > 4) {
            job.status = 'failed';
          }
          if (job.id !== undefined) await updateSyncJob(job);
          break;
        }

        job = await peekNextPendingJob();
      }

      const pendingCount = await getPendingJobCount();
      if (pendingCount === 0 && !this.isOffline) {
        this.setState('COMMITTED_REMOTE', 'All changes committed to Google Drive');
      }
    } catch (err) {
      console.error('[SyncEngine] Error in _runProcessQueue:', err);
    }
  }

  private async processSaveNoteJob(job: SyncJob): Promise<void> {
    const note: NoteDocument = job.payload;
    const folderInfo = this.folderInfo!;

    // Preflight Concurrency & Content Verification
    const remote = await this.adapter.getNote(note.id, folderInfo);

    if (remote && remote.version && note.baseDriveVersion && remote.version > note.baseDriveVersion) {
      const localHash = note.contentHash || (await computeContentHash(note.content));
      const remoteHash = remote.note.contentHash || (await computeContentHash(remote.note.content));

      if (localHash !== remoteHash) {
        // Concurrency Divergence Detected! Fork conflict copy
        console.warn(`[SyncEngine] Remote version diverged (${remote.version} > base ${note.baseDriveVersion}). Forking conflict copy.`);
        this.setState('CONFLICT_DIVERGED', `Conflict detected on "${note.title}". Preserving both versions.`);

        const conflictRes = await resolveNoteConflict(note, remote.note, 'Current Device');
        const conflictNote = conflictRes.forkedConflictNote;

        // Save conflict copy to Drive
        const forkDriveResult = await this.adapter.saveNote(conflictNote, folderInfo);
        conflictNote.driveFileId = forkDriveResult.fileId;
        conflictNote.baseDriveVersion = forkDriveResult.version;
        await saveNoteLocal(conflictNote);

        // Update Manifest to include conflict note
        let manifest = (await getManifestLocal()) || (await this.adapter.getManifest(folderInfo))?.manifest;
        if (!manifest) {
          manifest = {
            schemaVersion: 1,
            workspaceId: 'default',
            rootNoteId: 'root',
            lastModified: new Date().toISOString(),
            revisionSequence: 1,
            notes: {},
            branches: [],
          };
        }

        manifest.notes[conflictNote.id] = {
          id: conflictNote.id,
          title: conflictNote.title,
          type: conflictNote.type,
          attributes: conflictNote.attributes,
          contentHash: conflictNote.contentHash,
          driveFileId: conflictNote.driveFileId,
          driveVersion: conflictNote.baseDriveVersion,
          updatedAt: conflictNote.updatedAt,
          isDeleted: false,
        };
        for (const b of conflictNote.branches) {
          manifest.branches.push({
            branchId: `${b.parentNoteId}_${conflictNote.id}`,
            noteId: conflictNote.id,
            parentNoteId: b.parentNoteId,
            position: b.position,
            prefix: b.prefix,
          });
        }
        await this.adapter.saveManifest(folderInfo, manifest);
        await saveManifestLocal(manifest);

        for (const l of this.listeners) {
          l.onConflictDetected(remote.note, conflictNote);
        }
        return;
      }
    }

    // Clean write to Drive
    const saveResult = await this.adapter.saveNote(note, folderInfo);
    note.driveFileId = saveResult.fileId;
    note.baseDriveVersion = saveResult.version;
    note.contentHash = saveResult.contentHash;
    await saveNoteLocal(note);

    // Update manifest header
    let manifest = (await getManifestLocal()) || (await this.adapter.getManifest(folderInfo))?.manifest;
    if (!manifest) {
      manifest = {
        schemaVersion: 1,
        workspaceId: 'default',
        rootNoteId: 'root',
        lastModified: new Date().toISOString(),
        revisionSequence: 1,
        notes: {},
        branches: [],
      };
    }

    manifest.notes[note.id] = {
      id: note.id,
      title: note.title,
      type: note.type,
      icon: note.icon,
      attributes: note.attributes,
      contentHash: note.contentHash,
      driveFileId: note.driveFileId,
      driveVersion: note.baseDriveVersion,
      updatedAt: note.updatedAt,
      isDeleted: note.isDeleted ?? false,
    };
    await this.adapter.saveManifest(folderInfo, manifest);
    await saveManifestLocal(manifest);
  }
}
