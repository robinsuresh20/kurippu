import { IStorageAdapter, DriveFolderInfo, NoteDocument, PersistenceState, SyncJob } from '../../types/storage';
import {
  peekNextPendingJob,
  removeSyncJob,
  removePendingJobsForNote,
  updateSyncJob,
  getPendingJobCount,
  saveNoteLocal,
  getNoteLocal,
  listNotesLocal,
  saveManifestLocal,
  getManifestLocal,
  hasPendingJobForNote,
  enqueueOrCoalesceSyncJob,
} from '../../lib/indexeddb/cache';
import { resolveNoteConflict } from '../../lib/concurrency/conflictResolver';
import { computeContentHash } from '../../lib/storage/hash';
import { threeWayManifestMerge } from '../../lib/concurrency/threeWayMerge';
import { reconstructManifestFromNotes } from '../../lib/storage/reconciliation';
import { getClientDeviceId } from '../../lib/storage/deviceId';
import { nanoid } from 'nanoid';

export interface SyncEngineListener {
  onStateChange: (state: PersistenceState, message?: string) => void;
  onJobCompleted: (job: SyncJob) => void;
  onConflictDetected: (originalNote: NoteDocument, conflictCopy: NoteDocument) => void;
}

export class SyncEngine {
  private adapter: IStorageAdapter;
  private folderInfo: DriveFolderInfo | null = null;
  private initFoldersPromise: Promise<DriveFolderInfo> | null = null;
  private currentProcessPromise: Promise<void> | null = null;
  private currentHydratePromise: Promise<{
    importedNotesCount: number;
    updatedNotesCount: number;
    conflictNotesCount: number;
  }> | null = null;
  private pollIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 30000;
  private isPollingActive = false;
  private lastReconcileTime = 0;
  private isOffline = false;
  private isAuthRequired = false;
  private state: PersistenceState = 'IDLE';
  private listeners = new Set<SyncEngineListener>();

  constructor(adapter: IStorageAdapter) {
    this.adapter = adapter;
  }

  setAdapter(adapter: IStorageAdapter) {
    if (this.adapter === adapter) {
      return; // Do NOT reset folderInfo or state if it's the exact same adapter instance
    }
    this.adapter = adapter;
    this.folderInfo = null; // Reset folder info so it rediscovers with new adapter/token
    this.initFoldersPromise = null;
  }

  getState(): PersistenceState {
    return this.state;
  }

  setOffline(offline: boolean) {
    this.isOffline = offline;
    if (offline) {
      this.setState('OFFLINE', 'Offline mode enabled');
    } else if (this.isAuthRequired) {
      this.setState('AUTH_REQUIRED', 'Google Drive authorization required');
    } else {
      this.setState('IDLE', 'Online');
    }
  }

  setAuthRequired(required: boolean) {
    this.isAuthRequired = required;
    if (required) {
      this.setState('AUTH_REQUIRED', 'Google Drive authorization required');
    } else if (this.isOffline) {
      this.setState('OFFLINE', 'Offline mode enabled');
    } else {
      this.setState('IDLE', 'Online');
    }
  }

  subscribe(listener: SyncEngineListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts periodic background polling to detect and pull remote changes from Google Drive.
   * Skips when offline, unauthorized, or already polling.
   */
  startAutoPoll(
    intervalMs = 30000,
    onReconciled?: (result: { importedNotesCount: number; updatedNotesCount: number; conflictNotesCount: number }) => void | Promise<void>
  ): void {
    this.stopAutoPoll();
    this.pollIntervalMs = intervalMs;
    this.isPollingActive = true;

    this.pollIntervalTimer = setInterval(async () => {
      if (!this.isPollingActive || this.isOffline || this.isAuthRequired) {
        return;
      }
      try {
        const result = await this.hydrateAndReconcileFromDrive();
        if (onReconciled) {
          await onReconciled(result);
        }
      } catch (err: any) {
        console.warn('[SyncEngine] Background poll error:', err.message || err);
      }
    }, this.pollIntervalMs);
  }

  stopAutoPoll(): void {
    this.isPollingActive = false;
    if (this.pollIntervalTimer) {
      clearInterval(this.pollIntervalTimer);
      this.pollIntervalTimer = null;
    }
  }

  isAutoPollingActive(): boolean {
    return this.isPollingActive && this.pollIntervalTimer !== null;
  }

  getLastReconcileTime(): number {
    return this.lastReconcileTime;
  }

  private setState(state: PersistenceState, message?: string) {
    this.state = state;
    for (const l of this.listeners) {
      l.onStateChange(state, message);
    }
  }

  async initializeFolders(): Promise<DriveFolderInfo> {
    if (this.isAuthRequired) {
      throw new Error('Cannot initialize Drive folders: authorization required');
    }
    if (this.folderInfo) {
      return this.folderInfo;
    }
    if (this.initFoldersPromise) {
      return this.initFoldersPromise;
    }

    this.setState('SYNCING', 'Discovering application storage folders...');
    this.initFoldersPromise = (async () => {
      try {
        this.folderInfo = await this.adapter.discoverOrCreateAppFolders();
        this.setState('IDLE', 'Storage folders ready');
        return this.folderInfo;
      } catch (err: any) {
        if (err.message?.includes('401') || err.message?.includes('authorization') || err.status === 401) {
          this.setAuthRequired(true);
        } else {
          this.setState('ERROR', `Folder discovery failed: ${err.message}`);
        }
        throw err;
      } finally {
        this.initFoldersPromise = null;
      }
    })();

    return this.initFoldersPromise;
  }

  /**
   * Hydrates the local cache from Google Drive:
   * 1. Fetches the remote manifest (or reconstructs it from Drive files if missing).
   * 2. Downloads all remote notes into IndexedDB when local cache is empty or missing notes.
   * 3. Reconciles differences safely without overwriting newer local edits, forking conflicts when both local and remote changed.
   */
  async hydrateAndReconcileFromDrive(): Promise<{
    importedNotesCount: number;
    updatedNotesCount: number;
    conflictNotesCount: number;
  }> {
    if (this.isOffline) {
      return { importedNotesCount: 0, updatedNotesCount: 0, conflictNotesCount: 0 };
    }
    if (this.isAuthRequired) {
      this.setState('AUTH_REQUIRED', 'Google Drive authorization required');
      return { importedNotesCount: 0, updatedNotesCount: 0, conflictNotesCount: 0 };
    }

    // Reuse in-flight promise to prevent overlapping hydration operations
    if (this.currentHydratePromise) {
      return this.currentHydratePromise;
    }

    // If sync queue is actively uploading, await it first
    if (this.currentProcessPromise) {
      try {
        await this.currentProcessPromise;
      } catch {
        // Queue error handled by processQueue
      }
    }

    this.currentHydratePromise = this._runHydrateAndReconcile().finally(() => {
      this.currentHydratePromise = null;
    });

    return this.currentHydratePromise;
  }

  private async _runHydrateAndReconcile(): Promise<{
    importedNotesCount: number;
    updatedNotesCount: number;
    conflictNotesCount: number;
  }> {
    this.setState('SYNCING', 'Hydrating notes and manifest from Google Drive...');
    try {
      if (!this.folderInfo) {
        await this.initializeFolders();
      }
      const folderInfo = this.folderInfo!;
      if (!folderInfo.notesFolderId || !folderInfo.notesFolderId.trim()) {
        throw new Error('Hydration failed: notesFolderId was not resolved during folder discovery.');
      }

      let importedNotesCount = 0;
      let updatedNotesCount = 0;
      let conflictNotesCount = 0;

      // 1. Fetch remote manifest
      const remoteManifestData = await this.adapter.getManifest(folderInfo);
      let remoteManifest = remoteManifestData?.manifest;

      // 2. If remote manifest is missing on Drive, try to reconstruct from Drive note files
      if (!remoteManifest) {
        const driveFiles = await this.adapter.listDriveNotes(folderInfo);
        if (driveFiles.length > 0) {
          const downloadedNotes: NoteDocument[] = [];
          for (const df of driveFiles) {
            const noteId = df.appProperties?.['kurippuNoteId'] || df.name.replace(/\.json$/, '');
            const fetched = await this.adapter.getNote(noteId, folderInfo);
            if (fetched) downloadedNotes.push(fetched.note);
          }
          if (downloadedNotes.length > 0) {
            remoteManifest = await reconstructManifestFromNotes(downloadedNotes);
            const saved = await this.adapter.saveManifest(folderInfo, remoteManifest);
            folderInfo.manifestFileId = saved.fileId;
          }
        }
      }

      // If still no remote manifest (fresh empty Drive), initialize empty manifest
      if (!remoteManifest) {
        const localNotes = await listNotesLocal();
        if (localNotes.length > 0) {
          remoteManifest = await reconstructManifestFromNotes(localNotes);
        } else {
          remoteManifest = {
            schemaVersion: 1,
            workspaceId: 'default',
            rootNoteId: 'root',
            lastModified: new Date().toISOString(),
            revisionSequence: 1,
            notes: {},
            branches: [],
          };
        }
        const saved = await this.adapter.saveManifest(folderInfo, remoteManifest);
        folderInfo.manifestFileId = saved.fileId;
      }

      // 3. Reconcile remote notes with local notes
      const localNotes = await listNotesLocal();
      const localNotesMap = new Map(localNotes.map(n => [n.id, n]));
      const localManifest = await getManifestLocal();

      for (const [noteId, remoteHeader] of Object.entries(remoteManifest.notes || {})) {
        if (remoteHeader.isDeleted) continue;

        const localNote = localNotesMap.get(noteId);
        if (!localNote) {
          // Local cache does not have this note! Hydrate from Drive using driveFileId directly!
          const fetched = await this.adapter.getNote(noteId, folderInfo, remoteHeader.driveFileId);
          if (fetched) {
            fetched.note.driveFileId = fetched.note.driveFileId || remoteHeader.driveFileId;
            fetched.note.baseDriveVersion = fetched.version || remoteHeader.driveVersion;
            await saveNoteLocal(fetched.note);
            importedNotesCount++;
          }
        } else {
          // Local cache already has note! Compare contentHash
          const localHash = localNote.contentHash || (await computeContentHash(localNote.content));
          if (localHash === remoteHeader.contentHash) {
            // Content matches: ensure driveFileId and version are preserved
            let updated = false;
            if (!localNote.driveFileId && remoteHeader.driveFileId) {
              localNote.driveFileId = remoteHeader.driveFileId;
              updated = true;
            }
            if (localNote.baseDriveVersion !== remoteHeader.driveVersion) {
              localNote.baseDriveVersion = remoteHeader.driveVersion;
              updated = true;
            }
            if (updated) await saveNoteLocal(localNote);
          } else {
            // Content differs! Check if local note has pending offline changes
            const hasPending = await hasPendingJobForNote(noteId);
            if (!hasPending) {
              // Local note was NOT edited offline; remote note has newer edits from another device!
              const fetched = await this.adapter.getNote(noteId, folderInfo, remoteHeader.driveFileId || localNote.driveFileId);
              if (fetched) {
                fetched.note.driveFileId = fetched.note.driveFileId || remoteHeader.driveFileId;
                fetched.note.baseDriveVersion = fetched.version || remoteHeader.driveVersion;
                await saveNoteLocal(fetched.note);
                updatedNotesCount++;
              }
            } else {
              // Local has pending offline changes. Check if local note is a direct linear descendant of remote note or same device
              const fetched = await this.adapter.getNote(noteId, folderInfo, remoteHeader.driveFileId || localNote.driveFileId);
              if (fetched) {
                const thisDeviceId = getClientDeviceId();
                const isSameDevice = Boolean(fetched.note.clientDeviceId && fetched.note.clientDeviceId === thisDeviceId);
                const isDirectDescendant = Boolean(
                  localNote.baseRevisionId &&
                  fetched.note.revisionId &&
                  fetched.note.revisionId === localNote.baseRevisionId &&
                  localNote.revisionId !== fetched.note.revisionId
                );

                if (isSameDevice || isDirectDescendant) {
                  // Not a conflict: local has clean pending linear edits from this device or based on this remote revision!
                  localNote.driveFileId = localNote.driveFileId || remoteHeader.driveFileId;
                  localNote.baseDriveVersion = fetched.version || remoteHeader.driveVersion;
                  await saveNoteLocal(localNote);
                } else {
                  // CONFLICT: Local has pending offline edits AND remote has different edits from another device!
                  // Fork conflict copy to preserve both versions
                  const conflictRes = await resolveNoteConflict(localNote, fetched.note, 'Local Device');
                  const conflictNote = conflictRes.forkedConflictNote;

                  // 1. Preserve divergent local version as conflict copy and queue for sync
                  await saveNoteLocal(conflictNote);
                  await enqueueOrCoalesceSyncJob({
                    jobId: `job_${nanoid(8)}`,
                    type: 'SAVE_NOTE',
                    targetId: conflictNote.id,
                    payload: conflictNote,
                    clientTimestamp: Date.now(),
                    retryCount: 0,
                    status: 'pending',
                  });

                  // 2. Rebase original local note onto canonical remote note and remove superseded pending job
                  const rebasedOriginal: NoteDocument = {
                    ...fetched.note,
                    driveFileId: fetched.note.driveFileId || remoteHeader.driveFileId,
                    baseDriveVersion: fetched.version || remoteHeader.driveVersion,
                    baseRevisionId: undefined,
                  };
                  await saveNoteLocal(rebasedOriginal);
                  await removePendingJobsForNote(noteId);

                  conflictNotesCount++;
                  for (const l of this.listeners) {
                    l.onConflictDetected(rebasedOriginal, conflictNote);
                  }
                }
              }
            }
          }
        }
      }

      // 4. Save merged manifest locally
      if (localManifest && Object.keys(localManifest.notes).length > 0) {
        const mergeResult = threeWayManifestMerge(localManifest, localManifest, remoteManifest);
        await saveManifestLocal(mergeResult.mergedManifest);
        const hasManifestDivergence =
          conflictNotesCount > 0 ||
          mergeResult.conflictNotes.length > 0 ||
          mergeResult.resurrectedNotes.length > 0 ||
          Object.keys(mergeResult.mergedManifest.notes).length !== Object.keys(remoteManifest.notes).length;

        if (hasManifestDivergence) {
          const manifestSaved = await this.adapter.saveManifest(folderInfo, mergeResult.mergedManifest);
          folderInfo.manifestFileId = manifestSaved.fileId;
        }
      } else {
        await saveManifestLocal(remoteManifest);
      }

      this.lastReconcileTime = Date.now();
      this.setState('IDLE', `Hydration complete (${importedNotesCount} imported, ${updatedNotesCount} updated, ${conflictNotesCount} conflicts)`);
      return { importedNotesCount, updatedNotesCount, conflictNotesCount };
    } catch (err: any) {
      if (err.message?.includes('401') || err.message?.includes('authorization') || err.status === 401) {
        this.setAuthRequired(true);
      } else {
        this.setState('ERROR', `Hydration failed: ${err.message}`);
      }
      throw err;
    }
  }

  async processQueue(): Promise<void> {
    if (this.isOffline || this.isAuthRequired) return;
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
      // If hydration is actively running, await it first
      if (this.currentHydratePromise) {
        try {
          await this.currentHydratePromise;
        } catch {
          // Hydration error handled
        }
      }

      if (!this.folderInfo) {
        await this.initializeFolders();
      }

      let job = await peekNextPendingJob();
      while (job && !this.isOffline && !this.isAuthRequired) {
        this.setState('SYNCING', `Processing sync job ${job.jobId} (${job.type})...`);
        job.status = 'in_flight';
        if (job.id !== undefined) await updateSyncJob(job);

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

          if (jobErr.message?.includes('401') || jobErr.message?.includes('authorization') || jobErr.status === 401) {
            this.setAuthRequired(true);
            job.status = 'pending';
            job.lastError = jobErr.message;
            if (job.id !== undefined) await updateSyncJob(job);
            break;
          }

          if (jobErr.message?.includes('Network') || jobErr.message?.includes('offline')) {
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
          this.setState('ERROR', `Job ${job.jobId} failed: ${jobErr.message}`);
          break;
        }

        job = await peekNextPendingJob();
      }

      const pendingCount = await getPendingJobCount();
      if (pendingCount === 0 && !this.isOffline && !this.isAuthRequired && this.state !== 'ERROR') {
        this.setState('COMMITTED_REMOTE', 'All changes committed to Google Drive');
      }
    } catch (err: any) {
      console.error('[SyncEngine] Error in _runProcessQueue:', err);
      if (err.message?.includes('401') || err.message?.includes('authorization') || err.status === 401) {
        this.setAuthRequired(true);
      } else if (err.message?.includes('Network') || err.message?.includes('offline')) {
        this.setState('OFFLINE', 'Network failure. Changes buffered locally.');
      } else {
        this.setState('ERROR', err.message || 'Sync queue execution failed');
      }
    }
  }

  private async processSaveNoteJob(job: SyncJob): Promise<void> {
    const noteId = job.targetId;
    const folderInfo = this.folderInfo!;

    // 1. Fetch latest note from local IndexedDB (to get latest content and ensure driveFileId is preserved)
    const currentLocal = await getNoteLocal(noteId);
    let note: NoteDocument = currentLocal || (job.payload as NoteDocument);
    const thisDeviceId = getClientDeviceId();
    if (!note.clientDeviceId) {
      note.clientDeviceId = thisDeviceId;
    }

    // 2. If driveFileId or baseDriveVersion is missing, check manifest
    const localManifest = await getManifestLocal();
    if (localManifest?.notes[noteId]) {
      if (!note.driveFileId && localManifest.notes[noteId].driveFileId) {
        note.driveFileId = localManifest.notes[noteId].driveFileId;
      }
      if (!note.baseDriveVersion && localManifest.notes[noteId].driveVersion) {
        note.baseDriveVersion = localManifest.notes[noteId].driveVersion;
      }
    }

    // 3. Preflight Concurrency & Content Verification on Drive
    const remote = await this.adapter.getNote(note.id, folderInfo, note.driveFileId);

    if (remote) {
      // If note.driveFileId was not set, adopt remote canonical fileId
      if (!note.driveFileId && remote.note.driveFileId) {
        note.driveFileId = remote.note.driveFileId;
      }
      if (remote.duplicates && remote.duplicates.length > 0) {
        note.duplicateDriveFileIds = remote.duplicates.map(d => d.fileId);
      }

      const localHash = note.contentHash || (await computeContentHash(note.content));
      const remoteHash = remote.note.contentHash || (await computeContentHash(remote.note.content));
      const hashDiffer = localHash !== remoteHash;
      const isSameDevice = Boolean(remote.note.clientDeviceId && remote.note.clientDeviceId === thisDeviceId);
      const isDirectDescendant = Boolean(
        note.baseRevisionId &&
        remote.note.revisionId &&
        remote.note.revisionId === note.baseRevisionId &&
        note.revisionId !== remote.note.revisionId
      );
      const isSafeLinearSuccessor = isSameDevice || isDirectDescendant;

      const preflightDiag = {
        noteId: note.id,
        title: note.title,
        clientDeviceId: thisDeviceId,
        remoteClientDeviceId: remote.note.clientDeviceId,
        isSameDevice,
        localDriveFileId: note.driveFileId,
        remoteDriveFileId: remote.note.driveFileId,
        localBaseDriveVersion: note.baseDriveVersion,
        remoteVersion: remote.version,
        versionDiverged: Boolean(remote.version && note.baseDriveVersion && remote.version > note.baseDriveVersion),
        localHash,
        remoteHash,
        hashDiffer,
        localRevisionId: note.revisionId,
        localBaseRevisionId: note.baseRevisionId,
        remoteRevisionId: remote.note.revisionId,
        remoteBaseRevisionId: remote.note.baseRevisionId,
        isDirectDescendant,
        isSafeLinearSuccessor,
      };

      console.log(`[SyncEngine:PreflightDiagnostic]\n${JSON.stringify(preflightDiag, null, 2)}`);

      // Check if remote version diverged from local baseDriveVersion
      if (remote.version && note.baseDriveVersion && remote.version > note.baseDriveVersion) {
        if (hashDiffer) {
          if (isSafeLinearSuccessor) {
            // Not a conflict! Linear successor on same device or direct descendant across devices.
            // Adopt remote version as baseDriveVersion and proceed with clean save.
            console.log(
              `[SyncEngine] Safe linear succession detected for "${note.title}". isSameDevice=${isSameDevice}, isDirectDescendant=${isDirectDescendant}. Adopting remote version ${remote.version} as baseDriveVersion and proceeding with clean save.`
            );
            note.baseDriveVersion = remote.version;
            if (!note.driveFileId && remote.note.driveFileId) {
              note.driveFileId = remote.note.driveFileId;
            }
          } else {
            // Concurrency Divergence Detected! Fork conflict copy
            console.warn(`[SyncEngine] Remote version diverged (${remote.version} > base ${note.baseDriveVersion}) from another client (${remote.note.clientDeviceId || 'unknown'}). Forking conflict copy.`);
            this.setState('CONFLICT_DIVERGED', `Conflict detected on "${note.title}". Preserving both versions.`);

            const conflictRes = await resolveNoteConflict(note, remote.note, 'Current Device');
            const conflictNote = conflictRes.forkedConflictNote;

            // 1. Save divergent local version as conflict copy to Drive before modifying original
            const forkDriveResult = await this.adapter.saveNote(conflictNote, folderInfo);
            conflictNote.driveFileId = forkDriveResult.fileId;
            conflictNote.baseDriveVersion = forkDriveResult.version;
            await saveNoteLocal(conflictNote);

            // 2. Rebase the original local note onto the canonical remote note
            const rebasedOriginal: NoteDocument = {
              ...remote.note,
              driveFileId: remote.note.driveFileId || note.driveFileId,
              baseDriveVersion: remote.version,
              baseRevisionId: undefined, // Reset baseline so subsequent local edits branch from this committed version
            };
            if (remote.duplicates && remote.duplicates.length > 0) {
              rebasedOriginal.duplicateDriveFileIds = remote.duplicates.map(d => d.fileId);
            }

            // Edge-case safeguard: Check if the user made additional local edits while the conflict save was in flight
            const freshLocal = await getNoteLocal(note.id);
            if (freshLocal && freshLocal.revisionId !== note.revisionId) {
              // User typed additional keystrokes while the conflict was being uploaded.
              // Do not discard their unsaved keystrokes; rebase freshLocal's baseDriveVersion and baseRevisionId onto remote:
              freshLocal.baseDriveVersion = remote.version;
              freshLocal.baseRevisionId = remote.note.revisionId;
              await saveNoteLocal(freshLocal);
            } else {
              await saveNoteLocal(rebasedOriginal);
            }

            // 3. Update Manifest to include BOTH conflict note and canonical remote note header
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

            // Update original note header in manifest with remote canonical version & content hash
            manifest.notes[note.id] = {
              id: note.id,
              title: rebasedOriginal.title,
              type: rebasedOriginal.type,
              attributes: rebasedOriginal.attributes,
              contentHash: rebasedOriginal.contentHash,
              driveFileId: rebasedOriginal.driveFileId,
              driveVersion: rebasedOriginal.baseDriveVersion,
              updatedAt: rebasedOriginal.updatedAt,
              isDeleted: rebasedOriginal.isDeleted || false,
            };

            // Add conflict note header in manifest
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
            const savedManifest = await this.adapter.saveManifest(folderInfo, manifest);
            folderInfo.manifestFileId = savedManifest.fileId;
            await saveManifestLocal(manifest);

            for (const l of this.listeners) {
              l.onConflictDetected(rebasedOriginal, conflictNote);
            }
            return;
          }
        }
      }
    }

    // 4. Clean write to Drive (updates existing file if driveFileId exists, or searches Drive by kurippuNoteId)
    const saveResult = await this.adapter.saveNote(note, folderInfo);

    // Check if local note was modified in IndexedDB while save was in flight
    const freshLocal = await getNoteLocal(note.id);
    if (freshLocal) {
      freshLocal.driveFileId = saveResult.fileId;
      freshLocal.baseDriveVersion = saveResult.version;
      if (freshLocal.revisionId === note.revisionId) {
        freshLocal.contentHash = saveResult.contentHash;
        freshLocal.baseRevisionId = undefined; // Committed! Draft baseline reset for subsequent new edits
      } else {
        freshLocal.baseRevisionId = note.revisionId; // Base for edits made while in flight is the newly committed revision
      }
      await saveNoteLocal(freshLocal);
      note = freshLocal;
    } else {
      note.driveFileId = saveResult.fileId;
      note.baseDriveVersion = saveResult.version;
      note.contentHash = saveResult.contentHash;
      note.baseRevisionId = undefined;
      await saveNoteLocal(note);
    }

    // 5. Update manifest header with stable driveFileId and version
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
      duplicateDriveFileIds: note.duplicateDriveFileIds,
      updatedAt: note.updatedAt,
      isDeleted: note.isDeleted ?? false,
    };
    const manifestSaveRes = await this.adapter.saveManifest(folderInfo, manifest);
    folderInfo.manifestFileId = manifestSaveRes.fileId;
    await saveManifestLocal(manifest);
  }
}
