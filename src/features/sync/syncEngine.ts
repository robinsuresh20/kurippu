import { IStorageAdapter, DriveFolderInfo, NoteDocument, PersistenceState, SyncJob, ApplicationManifest, BranchRecord } from '../../types/storage';
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
  getActiveAccountId,
  getActiveAccountSessionId,
  recoverInterruptedJobs,
} from '../../lib/indexeddb/cache';
import { resolveNoteConflict } from '../../lib/concurrency/conflictResolver';
import { computeContentHash } from '../../lib/storage/hash';
import { threeWayManifestMerge } from '../../lib/concurrency/threeWayMerge';
import { reconstructManifestFromNotes } from '../../lib/storage/reconciliation';
import { getClientDeviceId } from '../../lib/storage/deviceId';
import { nanoid } from 'nanoid';

export class SyncSessionAbortedError extends Error {
  constructor(public accountId: string, public sessionId: number) {
    super(`Sync operation aborted: session ${sessionId} for account "${accountId}" is no longer active.`);
    this.name = 'SyncSessionAbortedError';
  }
}

export interface SyncSessionContext {
  readonly accountId: string;
  readonly sessionId: number;
  readonly adapter: IStorageAdapter;
  folderInfo: DriveFolderInfo;
  readonly abortController: AbortController;
}

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
  private activeSessionContext: SyncSessionContext | null = null;
  private pollIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 30000;
  private isPollingActive = false;
  private lastReconcileTime = 0;
  private isOffline = false;
  private isAuthRequired = false;
  private state: PersistenceState = 'IDLE';
  private listeners = new Set<SyncEngineListener>();
  private activeAccountId: string | null = null;

  constructor(adapter: IStorageAdapter, accountId?: string | null) {
    this.adapter = adapter;
    this.activeAccountId = accountId !== undefined ? accountId : getActiveAccountId();
  }

  setAdapter(adapter: IStorageAdapter, accountId?: string | null) {
    const targetAccount = accountId !== undefined ? accountId : getActiveAccountId();
    if (this.adapter === adapter && this.activeAccountId === targetAccount) {
      return;
    }
    this.stopAutoPoll();
    this.abortActiveOperations();
    this.adapter = adapter;
    this.activeAccountId = targetAccount;
    this.folderInfo = null;
    this.initFoldersPromise = null;
    this.currentProcessPromise = null;
    this.currentHydratePromise = null;
    this.lastReconcileTime = 0;
  }

  private abortActiveOperations(): void {
    if (this.activeSessionContext) {
      this.activeSessionContext.abortController.abort();
      this.activeSessionContext = null;
    }
  }

  private assertSessionValid(context: SyncSessionContext): void {
    if (
      context.abortController.signal.aborted ||
      this.activeAccountId !== context.accountId ||
      getActiveAccountId() !== context.accountId ||
      getActiveAccountSessionId() !== context.sessionId ||
      this.adapter !== context.adapter
    ) {
      throw new SyncSessionAbortedError(context.accountId, context.sessionId);
    }
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
        if (err instanceof SyncSessionAbortedError || err.name === 'AbortError') {
          return;
        }
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

  async initializeFolders(signal?: AbortSignal): Promise<DriveFolderInfo> {
    if (this.isAuthRequired) {
      throw new Error('Cannot initialize Drive folders: authorization required');
    }
    if (signal?.aborted) {
      throw new Error('Folder initialization aborted');
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
        const folderInfo = await this.adapter.discoverOrCreateAppFolders();
        if (signal?.aborted) {
          throw new Error('Folder initialization aborted');
        }
        this.folderInfo = folderInfo;
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

    if (this.currentHydratePromise) {
      return this.currentHydratePromise;
    }

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
    const startSession = getActiveAccountSessionId();
    const startAccount = getActiveAccountId();
    if (!startAccount || this.activeAccountId !== startAccount) {
      return { importedNotesCount: 0, updatedNotesCount: 0, conflictNotesCount: 0 };
    }

    const abortController = new AbortController();
    const context: SyncSessionContext = {
      accountId: startAccount,
      sessionId: startSession,
      adapter: this.adapter,
      folderInfo: this.folderInfo || { rootFolderId: '', notesFolderId: '' },
      abortController,
    };
    this.activeSessionContext = context;

    this.setState('SYNCING', 'Hydrating notes and manifest from Google Drive...');
    try {
      if (!this.folderInfo) {
        context.folderInfo = await this.initializeFolders(abortController.signal);
      } else {
        context.folderInfo = this.folderInfo;
      }
      this.assertSessionValid(context);

      const folderInfo = context.folderInfo;
      if (!folderInfo.notesFolderId || !folderInfo.notesFolderId.trim()) {
        throw new Error('Hydration failed: notesFolderId was not resolved during folder discovery.');
      }

      let importedNotesCount = 0;
      let updatedNotesCount = 0;
      let conflictNotesCount = 0;

      // 1. Fetch remote manifest
      const remoteManifestData = await context.adapter.getManifest(folderInfo);
      this.assertSessionValid(context);
      let remoteManifest = remoteManifestData?.manifest;

      // 2. If remote manifest is missing on Drive, try to reconstruct from Drive note files
      if (!remoteManifest) {
        const driveFiles = await context.adapter.listDriveNotes(folderInfo);
        this.assertSessionValid(context);
        if (driveFiles.length > 0) {
          const downloadedNotes: NoteDocument[] = [];
          for (const df of driveFiles) {
            this.assertSessionValid(context);
            const noteId = df.appProperties?.['kurippuNoteId'] || df.name.replace(/\.json$/, '');
            const fetched = await context.adapter.getNote(noteId, folderInfo);
            if (fetched) downloadedNotes.push(fetched.note);
          }
          this.assertSessionValid(context);
          if (downloadedNotes.length > 0) {
            remoteManifest = await reconstructManifestFromNotes(downloadedNotes);
            const saved = await context.adapter.saveManifest(folderInfo, remoteManifest);
            folderInfo.manifestFileId = saved.fileId;
          }
        }
      }

      // If still no remote manifest (fresh empty Drive), initialize empty manifest
      if (!remoteManifest) {
        const localNotes = await listNotesLocal(context.accountId, false, context.sessionId);
        this.assertSessionValid(context);
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
        const saved = await context.adapter.saveManifest(folderInfo, remoteManifest);
        this.assertSessionValid(context);
        folderInfo.manifestFileId = saved.fileId;
      }

      // 3. Reconcile remote notes with local notes in this account's partition
      const localNotes = await listNotesLocal(context.accountId, true, context.sessionId);
      this.assertSessionValid(context);
      const localNotesMap = new Map(localNotes.map(n => [n.id, n]));
      const localManifest = await getManifestLocal(context.accountId, context.sessionId);
      this.assertSessionValid(context);

      for (const [noteId, remoteHeader] of Object.entries(remoteManifest.notes || {})) {
        this.assertSessionValid(context);

        if (remoteHeader.isDeleted) {
          // Check if local active note needs to be marked as deleted (tombstone synchronization)
          const localNote = localNotesMap.get(noteId);
          if (localNote && !localNote.isDeleted) {
            const hasPending = await hasPendingJobForNote(noteId, context.accountId, context.sessionId);
            this.assertSessionValid(context);
            if (!hasPending) {
              // No local offline edits; apply remote deletion cleanly to prevent resurrection
              localNote.isDeleted = true;
              localNote.deletedAt = remoteHeader.deletedAt || new Date().toISOString();
              await saveNoteLocal(localNote, context.accountId, context.sessionId);
            }
          }
          continue;
        }

        const localNote = localNotesMap.get(noteId);
        if (!localNote || localNote.isDeleted) {
          // Local cache does not have active note; hydrate from Drive
          const fetched = await context.adapter.getNote(noteId, folderInfo, remoteHeader.driveFileId);
          this.assertSessionValid(context);
          if (fetched) {
            fetched.note.driveFileId = fetched.note.driveFileId || remoteHeader.driveFileId;
            fetched.note.baseDriveVersion = fetched.version || remoteHeader.driveVersion;
            fetched.note.isDeleted = false;
            await saveNoteLocal(fetched.note, context.accountId, context.sessionId);
            importedNotesCount++;
          }
        } else {
          // Local cache already has note! Compare contentHash
          const localHash = localNote.contentHash || (await computeContentHash(localNote.content));
          if (localHash === remoteHeader.contentHash) {
            let updated = false;
            if (!localNote.driveFileId && remoteHeader.driveFileId) {
              localNote.driveFileId = remoteHeader.driveFileId;
              updated = true;
            }
            if (localNote.baseDriveVersion !== remoteHeader.driveVersion) {
              localNote.baseDriveVersion = remoteHeader.driveVersion;
              updated = true;
            }
            if (updated) {
              await saveNoteLocal(localNote, context.accountId, context.sessionId);
            }
          } else {
            // Content differs! Check if local note has pending offline changes
            const hasPending = await hasPendingJobForNote(noteId, context.accountId, context.sessionId);
            this.assertSessionValid(context);
            if (!hasPending) {
              const fetched = await context.adapter.getNote(noteId, folderInfo, remoteHeader.driveFileId || localNote.driveFileId);
              this.assertSessionValid(context);
              if (fetched) {
                fetched.note.driveFileId = fetched.note.driveFileId || remoteHeader.driveFileId;
                fetched.note.baseDriveVersion = fetched.version || remoteHeader.driveVersion;
                await saveNoteLocal(fetched.note, context.accountId, context.sessionId);
                updatedNotesCount++;
              }
            } else {
              const fetched = await context.adapter.getNote(noteId, folderInfo, remoteHeader.driveFileId || localNote.driveFileId);
              this.assertSessionValid(context);
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
                  localNote.driveFileId = localNote.driveFileId || remoteHeader.driveFileId;
                  localNote.baseDriveVersion = fetched.version || remoteHeader.driveVersion;
                  await saveNoteLocal(localNote, context.accountId, context.sessionId);
                } else {
                  // Concurrency Divergence: Fork conflict copy
                  const conflictRes = await resolveNoteConflict(localNote, fetched.note, 'Local Device');
                  const conflictNote = conflictRes.forkedConflictNote;

                  await saveNoteLocal(conflictNote, context.accountId, context.sessionId);
                  await enqueueOrCoalesceSyncJob({
                    jobId: `job_${nanoid(8)}`,
                    type: 'SAVE_NOTE',
                    targetId: conflictNote.id,
                    payload: conflictNote,
                    clientTimestamp: Date.now(),
                    retryCount: 0,
                    status: 'pending',
                  }, context.accountId, context.sessionId);

                  const rebasedOriginal: NoteDocument = {
                    ...fetched.note,
                    driveFileId: fetched.note.driveFileId || remoteHeader.driveFileId,
                    baseDriveVersion: fetched.version || remoteHeader.driveVersion,
                    baseRevisionId: undefined,
                  };
                  await saveNoteLocal(rebasedOriginal, context.accountId, context.sessionId);
                  await removePendingJobsForNote(noteId, context.accountId, context.sessionId);

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

      // 4. Save merged manifest locally and remotely
      this.assertSessionValid(context);
      if (localManifest && Object.keys(localManifest.notes).length > 0) {
        const mergeResult = threeWayManifestMerge(localManifest, localManifest, remoteManifest);
        await saveManifestLocal(mergeResult.mergedManifest, context.accountId, context.sessionId);
        const hasManifestDivergence =
          conflictNotesCount > 0 ||
          mergeResult.conflictNotes.length > 0 ||
          mergeResult.resurrectedNotes.length > 0 ||
          Object.keys(mergeResult.mergedManifest.notes).length !== Object.keys(remoteManifest.notes).length;

        if (hasManifestDivergence) {
          const manifestSaved = await context.adapter.saveManifest(folderInfo, mergeResult.mergedManifest);
          this.assertSessionValid(context);
          folderInfo.manifestFileId = manifestSaved.fileId;
        }
      } else {
        await saveManifestLocal(remoteManifest, context.accountId, context.sessionId);
      }

      this.lastReconcileTime = Date.now();
      this.setState('IDLE', `Hydration complete (${importedNotesCount} imported, ${updatedNotesCount} updated, ${conflictNotesCount} conflicts)`);
      return { importedNotesCount, updatedNotesCount, conflictNotesCount };
    } catch (err: any) {
      if (
        err instanceof SyncSessionAbortedError ||
        err?.name === 'AbortError' ||
        err?.name === 'InvalidStateError' ||
        err?.name === 'AccountMismatchError' ||
        err?.name === 'StaleSessionError'
      ) {
        return { importedNotesCount: 0, updatedNotesCount: 0, conflictNotesCount: 0 };
      }
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
    const startSession = getActiveAccountSessionId();
    const startAccount = getActiveAccountId();
    if (!startAccount || this.activeAccountId !== startAccount) return;

    const abortController = new AbortController();
    const context: SyncSessionContext = {
      accountId: startAccount,
      sessionId: startSession,
      adapter: this.adapter,
      folderInfo: this.folderInfo || { rootFolderId: '', notesFolderId: '' },
      abortController,
    };
    this.activeSessionContext = context;

    try {
      // 1. Recover any interrupted in-flight jobs for this account
      await recoverInterruptedJobs(context.accountId, context.sessionId);
      this.assertSessionValid(context);

      if (this.currentHydratePromise) {
        try {
          await this.currentHydratePromise;
        } catch {
          // Hydration error handled
        }
      }
      this.assertSessionValid(context);

      if (!this.folderInfo) {
        context.folderInfo = await this.initializeFolders(abortController.signal);
      } else {
        context.folderInfo = this.folderInfo;
      }
      this.assertSessionValid(context);

      let job = await peekNextPendingJob(context.accountId, context.sessionId);
      while (job && !this.isOffline && !this.isAuthRequired) {
        this.assertSessionValid(context);

        this.setState('SYNCING', `Processing sync job ${job.jobId} (${job.type})...`);
        job.status = 'in_flight';
        if (job.id !== undefined) {
          await updateSyncJob(job, context.accountId, context.sessionId);
        }

        try {
          if (job.type === 'SAVE_NOTE') {
            await this.processSaveNoteJob(job, context);
          } else if (job.type === 'DELETE_NOTE') {
            await this.processDeleteNoteJob(job, context);
          }

          this.assertSessionValid(context);

          if (job.id !== undefined) {
            await removeSyncJob(job.id, context.accountId, context.sessionId);
          }

          for (const l of this.listeners) {
            l.onJobCompleted(job);
          }
        } catch (jobErr: any) {
          if (
            jobErr instanceof SyncSessionAbortedError ||
            jobErr?.name === 'AbortError' ||
            jobErr?.name === 'InvalidStateError' ||
            jobErr?.name === 'AccountMismatchError' ||
            jobErr?.name === 'StaleSessionError'
          ) {
            return;
          }

          console.error(`[SyncEngine] Job ${job.jobId} error:`, jobErr);

          if (jobErr.message?.includes('401') || jobErr.message?.includes('authorization') || jobErr.status === 401) {
            this.setAuthRequired(true);
            job.status = 'pending';
            job.lastError = jobErr.message;
            if (job.id !== undefined) await updateSyncJob(job, context.accountId, context.sessionId);
            break;
          }

          if (jobErr.message?.includes('Network') || jobErr.message?.includes('offline')) {
            this.setState('OFFLINE', `Network failure during job ${job.jobId}. Changes buffered locally.`);
            job.status = 'pending';
            job.lastError = jobErr.message;
            if (job.id !== undefined) await updateSyncJob(job, context.accountId, context.sessionId);
            break;
          }

          job.retryCount = (job.retryCount || 0) + 1;
          job.lastError = jobErr.message;
          if (job.retryCount > 4) {
            job.status = 'failed';
          }
          if (job.id !== undefined) await updateSyncJob(job, context.accountId, context.sessionId);
          this.setState('ERROR', `Job ${job.jobId} failed: ${jobErr.message}`);
          break;
        }

        job = await peekNextPendingJob(context.accountId, context.sessionId);
      }

      this.assertSessionValid(context);
      const pendingCount = await getPendingJobCount(context.accountId, context.sessionId);
      if (pendingCount === 0 && !this.isOffline && !this.isAuthRequired && this.state !== 'ERROR') {
        this.setState('COMMITTED_REMOTE', 'All changes committed to Google Drive');
      }
    } catch (err: any) {
      if (
        err instanceof SyncSessionAbortedError ||
        err?.name === 'AbortError' ||
        err?.name === 'InvalidStateError' ||
        err?.name === 'AccountMismatchError' ||
        err?.name === 'StaleSessionError'
      ) {
        return;
      }
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

  private async processSaveNoteJob(job: SyncJob, context: SyncSessionContext): Promise<void> {
    const noteId = job.targetId;
    const folderInfo = context.folderInfo;

    // 1. Fetch latest note from this account's local IndexedDB
    const currentLocal = await getNoteLocal(noteId, context.accountId, context.sessionId);
    let note: NoteDocument = currentLocal || (job.payload as NoteDocument);
    const thisDeviceId = getClientDeviceId();
    if (!note.clientDeviceId) {
      note.clientDeviceId = thisDeviceId;
    }

    // 2. Check manifest for driveFileId and version
    const localManifest = await getManifestLocal(context.accountId, context.sessionId);
    if (localManifest?.notes[noteId]) {
      if (!note.driveFileId && localManifest.notes[noteId].driveFileId) {
        note.driveFileId = localManifest.notes[noteId].driveFileId;
      }
      if (!note.baseDriveVersion && localManifest.notes[noteId].driveVersion) {
        note.baseDriveVersion = localManifest.notes[noteId].driveVersion;
      }
    }

    // 3. Preflight Concurrency & Content Verification on Drive
    const remote = await context.adapter.getNote(note.id, folderInfo, note.driveFileId);
    this.assertSessionValid(context);

    if (remote) {
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

      if (remote.version && note.baseDriveVersion && remote.version > note.baseDriveVersion) {
        if (hashDiffer) {
          if (isSafeLinearSuccessor) {
            note.baseDriveVersion = remote.version;
            if (!note.driveFileId && remote.note.driveFileId) {
              note.driveFileId = remote.note.driveFileId;
            }
          } else {
            // Divergence Detected: Fork conflict copy
            this.setState('CONFLICT_DIVERGED', `Conflict detected on "${note.title}". Preserving both versions.`);

            const conflictRes = await resolveNoteConflict(note, remote.note, 'Current Device');
            const conflictNote = conflictRes.forkedConflictNote;

            // Save conflict copy to Drive
            const forkDriveResult = await context.adapter.saveNote(conflictNote, folderInfo);
            this.assertSessionValid(context);
            conflictNote.driveFileId = forkDriveResult.fileId;
            conflictNote.baseDriveVersion = forkDriveResult.version;
            await saveNoteLocal(conflictNote, context.accountId, context.sessionId);
            this.assertSessionValid(context);

            // Rebase original local note onto canonical remote note
            const rebasedOriginal: NoteDocument = {
              ...remote.note,
              driveFileId: remote.note.driveFileId || note.driveFileId,
              baseDriveVersion: remote.version,
              baseRevisionId: undefined,
            };
            if (remote.duplicates && remote.duplicates.length > 0) {
              rebasedOriginal.duplicateDriveFileIds = remote.duplicates.map(d => d.fileId);
            }

            const freshLocal = await getNoteLocal(note.id, context.accountId, context.sessionId);
            this.assertSessionValid(context);
            if (freshLocal && freshLocal.revisionId !== note.revisionId) {
              freshLocal.baseDriveVersion = remote.version;
              freshLocal.baseRevisionId = remote.note.revisionId;
              await saveNoteLocal(freshLocal, context.accountId, context.sessionId);
            } else {
              await saveNoteLocal(rebasedOriginal, context.accountId, context.sessionId);
            }

            // Update Manifest
            let manifest = (await getManifestLocal(context.accountId, context.sessionId)) || (await context.adapter.getManifest(folderInfo))?.manifest;
            this.assertSessionValid(context);
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
              title: rebasedOriginal.title,
              type: rebasedOriginal.type,
              attributes: rebasedOriginal.attributes,
              contentHash: rebasedOriginal.contentHash,
              driveFileId: rebasedOriginal.driveFileId,
              driveVersion: rebasedOriginal.baseDriveVersion,
              updatedAt: rebasedOriginal.updatedAt,
              isDeleted: rebasedOriginal.isDeleted || false,
            };

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
            const savedManifest = await context.adapter.saveManifest(folderInfo, manifest);
            this.assertSessionValid(context);
            folderInfo.manifestFileId = savedManifest.fileId;
            await saveManifestLocal(manifest, context.accountId, context.sessionId);

            for (const l of this.listeners) {
              l.onConflictDetected(rebasedOriginal, conflictNote);
            }
            return;
          }
        }
      }
    }

    // 4. Clean write to Drive
    const saveResult = await context.adapter.saveNote(note, folderInfo);
    this.assertSessionValid(context);

    // Update local cache in this account's partition
    const freshLocal = await getNoteLocal(note.id, context.accountId, context.sessionId);
    this.assertSessionValid(context);
    if (freshLocal) {
      freshLocal.driveFileId = saveResult.fileId;
      freshLocal.baseDriveVersion = saveResult.version;
      if (freshLocal.revisionId === note.revisionId) {
        freshLocal.contentHash = saveResult.contentHash;
        freshLocal.baseRevisionId = undefined;
      } else {
        freshLocal.baseRevisionId = note.revisionId;
      }
      await saveNoteLocal(freshLocal, context.accountId, context.sessionId);
      note = freshLocal;
    } else {
      note.driveFileId = saveResult.fileId;
      note.baseDriveVersion = saveResult.version;
      note.contentHash = saveResult.contentHash;
      note.baseRevisionId = undefined;
      await saveNoteLocal(note, context.accountId, context.sessionId);
    }
    this.assertSessionValid(context);

    // 5. Update Manifest
    let manifest = (await getManifestLocal(context.accountId, context.sessionId)) || (await context.adapter.getManifest(folderInfo))?.manifest;
    this.assertSessionValid(context);
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
      deletedAt: note.deletedAt,
    };
    const manifestSaveRes = await context.adapter.saveManifest(folderInfo, manifest);
    this.assertSessionValid(context);
    folderInfo.manifestFileId = manifestSaveRes.fileId;
    await saveManifestLocal(manifest, context.accountId, context.sessionId);
  }

  private async processDeleteNoteJob(job: SyncJob, context: SyncSessionContext): Promise<void> {
    const noteId = job.targetId;
    const folderInfo = context.folderInfo;

    // 1. Locate local note and local manifest metadata (for driveFileId fallback and tombstone details)
    const localNote = await getNoteLocal(noteId, context.accountId, context.sessionId);
    const localManifest = await getManifestLocal(context.accountId, context.sessionId);
    this.assertSessionValid(context);

    // 2. Retrieve latest available remote manifest before preparing deletion to prevent overwriting newer remote metadata.
    // If the network or auth fails, getManifest throws so the job remains retryable without clobbering remote state.
    const remoteManifestRes = await context.adapter.getManifest(folderInfo);
    this.assertSessionValid(context);

    let manifest: ApplicationManifest;
    if (remoteManifestRes?.manifest) {
      manifest = remoteManifestRes.manifest;
    } else if (localManifest) {
      manifest = { ...localManifest, notes: { ...localManifest.notes } };
    } else {
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

    // 3. Locate driveFileId from localNote, remote manifest, or local manifest
    const driveFileId =
      localNote?.driveFileId ||
      manifest.notes?.[noteId]?.driveFileId ||
      localManifest?.notes?.[noteId]?.driveFileId;

    // 4. Delete remote Drive file if it exists; 404 is swallowed so retries after partial failure succeed
    if (driveFileId) {
      try {
        await context.adapter.deleteNoteFile(driveFileId);
      } catch (err: any) {
        if (!err.message?.includes('404')) {
          throw err;
        }
      }
    }
    this.assertSessionValid(context);

    // 5. Mark tombstone in manifest while preserving all other remote notes, branches, and metadata
    const now = new Date().toISOString();
    manifest.lastModified = now;
    manifest.revisionSequence = (manifest.revisionSequence || 0) + 1;

    if (manifest.notes[noteId]) {
      manifest.notes[noteId] = {
        ...manifest.notes[noteId],
        isDeleted: true,
        deletedAt: now,
      };
    } else {
      manifest.notes[noteId] = {
        id: noteId,
        title: localNote?.title || 'Deleted Note',
        type: localNote?.type || 'text',
        attributes: localNote?.attributes || [],
        contentHash: '',
        driveFileId: undefined,
        updatedAt: now,
        isDeleted: true,
        deletedAt: now,
      };
    }
    // Remove branches only for this note, preserving all unrelated branches
    manifest.branches = (manifest.branches || []).filter((b: BranchRecord) => b.noteId !== noteId);

    // 6. Save reconciled manifest to Drive
    const savedManifest = await context.adapter.saveManifest(folderInfo, manifest);
    this.assertSessionValid(context);
    folderInfo.manifestFileId = savedManifest.fileId;

    // 7. Update local manifest only after remote update succeeds and session is still valid
    await saveManifestLocal(manifest, context.accountId, context.sessionId);

    // 8. Update local note tombstone
    if (localNote) {
      localNote.isDeleted = true;
      localNote.deletedAt = now;
      await saveNoteLocal(localNote, context.accountId, context.sessionId);
    }
  }
}
