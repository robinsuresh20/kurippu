import React, { useState, useEffect, useRef } from 'react';
import { useAuthStore } from './features/auth/authStore';
import { NoteDocument, PersistenceState, SyncJob, GoogleUserProfile } from './types/storage';
import { GoogleDriveStorageAdapter } from './lib/google-drive/driveAdapter';
import { MockDriveAdapter } from './lib/google-drive/mockDriveAdapter';
import { SyncEngine } from './features/sync/syncEngine';
import {
  saveNoteLocal,
  getNoteLocal,
  listNotesLocal,
  getManifestLocal,
  saveManifestLocal,
  enqueueOrCoalesceSyncJob,
  getAllQueueJobs,
  clearLocalDatabase,
  requestPersistentStorage,
  setActiveAccount,
  getActiveAccountId,
  getActiveAccountSessionId,
  StaleSessionError,
  AccountMismatchError,
  inspectLegacyCache,
  importLegacyCacheToActiveAccount,
  LegacyCacheSummary,
  LegacyCacheImportResult,
} from './lib/indexeddb/cache';
import { reconstructManifestFromNotes } from './lib/storage/reconciliation';
import { computeContentHash } from './lib/storage/hash';
import { getClientDeviceId } from './lib/storage/deviceId';
import { nanoid } from 'nanoid';
import {
  Cloud,
  HardDrive,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Wifi,
  WifiOff,
  FileText,
  Shield,
  Trash2,
  GitBranch,
  DownloadCloud,
  Layers,
} from 'lucide-react';

declare global {
  interface Window {
    google?: any;
  }
}

export interface LegacyImportWorkflowParams {
  targetAccountId: string;
  migrationSessionId: number;
  getActiveAccountId: () => string | null;
  getActiveAccountSessionId: () => number;
  importLegacyCache: (accountId: string) => Promise<LegacyCacheImportResult>;
  refreshLocalData: () => Promise<void>;
  processQueue: () => Promise<void>;
  setLegacyCacheInfo: (info: LegacyCacheSummary | null) => void;
  setIsMigratingLegacy: (loading: boolean) => void;
  addLog?: (msg: string) => void;
  inspectLegacyCache?: (accountId?: string | null, sessionId?: number) => Promise<LegacyCacheSummary>;
}

/**
 * Production helper that coordinates legacy cache import, session-currency validation,
 * UI updates, and subsequent sync queue processing.
 * Returns true if migration and subsequent steps completed for the active session, false if cancelled.
 */
export async function executeLegacyImportWorkflow(params: LegacyImportWorkflowParams): Promise<boolean> {
  const {
    targetAccountId,
    migrationSessionId,
    getActiveAccountId,
    getActiveAccountSessionId,
    importLegacyCache,
    refreshLocalData,
    processQueue,
    setLegacyCacheInfo,
    setIsMigratingLegacy,
    addLog = () => {},
  } = params;

  if (getActiveAccountId() !== targetAccountId || getActiveAccountSessionId() !== migrationSessionId) {
    return false;
  }

  setIsMigratingLegacy(true);
  try {
    addLog(`Importing unassigned legacy cache into ${targetAccountId}...`);
    const res = await importLegacyCache(targetAccountId);

    // Verify session currency before updating UI state or starting follow-up operations
    if (getActiveAccountId() !== targetAccountId || getActiveAccountSessionId() !== migrationSessionId) {
      return false;
    }

    if (res.skippedNotesCount > 0) {
      addLog(
        `Legacy import complete: ${res.importedNotesCount} imported, ${res.skippedNotesCount} already in account (skipped), ${res.importedJobsCount} jobs imported.`
      );
    } else {
      addLog(`Legacy import complete: ${res.importedNotesCount} notes and ${res.importedJobsCount} jobs imported.`);
    }
    setLegacyCacheInfo(null);

    await refreshLocalData();
    if (getActiveAccountId() !== targetAccountId || getActiveAccountSessionId() !== migrationSessionId) {
      return false;
    }

    await processQueue();

    const inspectFn = params.inspectLegacyCache || inspectLegacyCache;
    try {
      const updatedSummary = await inspectFn(targetAccountId, migrationSessionId);
      if (getActiveAccountId() === targetAccountId && getActiveAccountSessionId() === migrationSessionId) {
        if (updatedSummary.exists && !updatedSummary.allAlreadyImported) {
          setLegacyCacheInfo(updatedSummary);
        } else {
          setLegacyCacheInfo(null);
        }
      }
    } catch {
      setLegacyCacheInfo(null);
    }
    return true;
  } catch (err: any) {
    if (
      err instanceof StaleSessionError ||
      err?.name === 'StaleSessionError' ||
      err instanceof AccountMismatchError ||
      err?.name === 'AccountMismatchError'
    ) {
      // Expected cancellation caused by account switch or sign-out
      return false;
    }
    addLog(`Legacy import failed: ${err.message}`);
    throw err;
  } finally {
    // Only reset spinner if the session that started it is still current
    if (getActiveAccountId() === targetAccountId && getActiveAccountSessionId() === migrationSessionId) {
      setIsMigratingLegacy(false);
    }
  }
}

export const App: React.FC = () => {
  const {
    user,
    storageMode,
    accessToken,
    tokenExpiresAt,
    isDriveAuthorized,
    setUser,
    setStorageMode,
    setAccessToken,
    signOut,
  } = useAuthStore();

  const [clientId, setClientId] = useState(() => localStorage.getItem('kurippu_gcp_client_id') || '');
  const [persistenceState, setPersistenceState] = useState<PersistenceState>('IDLE');
  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [logs, setLogs] = useState<string[]>([]);
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [activeNote, setActiveNote] = useState<NoteDocument | null>(null);
  const activeNoteRef = useRef<NoteDocument | null>(null);
  activeNoteRef.current = activeNote;
  const [queueJobs, setQueueJobs] = useState<SyncJob[]>([]);
  const [isOffline, setIsOffline] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ persisted: boolean; quota?: number; usage?: number }>({ persisted: false });
  const [legacyCacheInfo, setLegacyCacheInfo] = useState<LegacyCacheSummary | null>(null);
  const [isMigratingLegacy, setIsMigratingLegacy] = useState(false);

  const mockAdapterRef = useRef(new MockDriveAdapter());
  const driveAdapterRef = useRef<GoogleDriveStorageAdapter | null>(null);
  const syncEngineRef = useRef<SyncEngine>(new SyncEngine(mockAdapterRef.current, 'mock'));
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 99)]);
  };

  // Initialize persistent storage and sync engine subscriptions
  useEffect(() => {
    requestPersistentStorage().then(info => {
      setStorageInfo(info);
      addLog(`Persistent storage granted: ${info.persisted} (quota: ${Math.round((info.quota || 0) / 1024 / 1024)} MB)`);
    });

    const unsubscribe = syncEngineRef.current.subscribe({
      onStateChange: (state, message) => {
        setPersistenceState(state);
        if (message) setStatusMessage(message);
        addLog(`State -> ${state}: ${message || ''}`);
      },
      onJobCompleted: (job) => {
        addLog(`Sync Job Completed: ${job.jobId} (${job.type})`);
        refreshLocalData();
      },
      onConflictDetected: (original, conflict) => {
        addLog(`CONFLICT PRESERVED: Forked copy "${conflict.title}" (Original: ${original.title})`);
        refreshLocalData();
      },
    });

    return () => {
      unsubscribe();
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  // Manage adapter routing and account partition activation
  useEffect(() => {
    setIsMigratingLegacy(false);
    if (storageMode === 'mock') {
      setActiveAccount('mock');
      syncEngineRef.current.setAuthRequired(false);
      syncEngineRef.current.setAdapter(mockAdapterRef.current, 'mock');
      addLog('Storage Target: In-Memory Mock Drive (Partition: mock)');
      refreshLocalData();
    } else {
      if (accessToken && user?.sub) {
        setActiveAccount(user.sub);
        if (!driveAdapterRef.current || driveAdapterRef.current.accountId !== user.sub) {
          driveAdapterRef.current = new GoogleDriveStorageAdapter(accessToken, user.sub);
        } else {
          driveAdapterRef.current.setAccessToken(accessToken, user.sub);
        }
        syncEngineRef.current.setAdapter(driveAdapterRef.current, user.sub);
        syncEngineRef.current.setAuthRequired(false);
        addLog(`Storage Target: Live Google Drive (${user.email} - Partition: ${user.sub})`);
        refreshLocalData();

        inspectLegacyCache(user.sub).then(summary => {
          if (summary.exists && !summary.allAlreadyImported) setLegacyCacheInfo(summary);
          else setLegacyCacheInfo(null);
        }).catch(() => {});
      } else {
        setActiveAccount(null);
        syncEngineRef.current.setAdapter(mockAdapterRef.current, null);
        syncEngineRef.current.setAuthRequired(true);
        addLog('Storage Target: Live Google Drive (Authorization Required — Disconnected)');
        refreshLocalData();
      }
    }
  }, [storageMode, accessToken]);

  // Auto-sync background polling and window focus/visibility listeners
  useEffect(() => {
    const isDriveActive = storageMode === 'drive' && Boolean(accessToken) && !isOffline;
    if (!isDriveActive) {
      syncEngineRef.current.stopAutoPoll();
      return;
    }

    // 1. Start configurable 30-second background polling
    syncEngineRef.current.startAutoPoll(30000, async (result) => {
      if (result.importedNotesCount > 0 || result.updatedNotesCount > 0 || result.conflictNotesCount > 0) {
        addLog(`Background sync: ${result.importedNotesCount} imported, ${result.updatedNotesCount} updated, ${result.conflictNotesCount} conflicts.`);
        await refreshLocalData();
      }
    });

    // 2. Debounced focus and visibilitychange listener
    let focusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handleFocusOrVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      if (focusDebounceTimer) {
        clearTimeout(focusDebounceTimer);
      }

      focusDebounceTimer = setTimeout(async () => {
        // Skip if a recent poll/reconciliation ran within the last 10 seconds
        const timeSinceLastReconcile = Date.now() - syncEngineRef.current.getLastReconcileTime();
        if (timeSinceLastReconcile < 10000) {
          return;
        }

        try {
          const result = await syncEngineRef.current.hydrateAndReconcileFromDrive();
          if (result.importedNotesCount > 0 || result.updatedNotesCount > 0 || result.conflictNotesCount > 0) {
            addLog(`Focus sync: ${result.importedNotesCount} imported, ${result.updatedNotesCount} updated, ${result.conflictNotesCount} conflicts.`);
            await refreshLocalData();
          }
        } catch (err: any) {
          console.warn('[App] Focus reconciliation error:', err.message || err);
        }
      }, 1000);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocusOrVisibility);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleFocusOrVisibility);
    }

    return () => {
      syncEngineRef.current.stopAutoPoll();
      if (focusDebounceTimer) clearTimeout(focusDebounceTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocusOrVisibility);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleFocusOrVisibility);
      }
    };
  }, [storageMode, accessToken, isOffline]);

  const refreshLocalData = async () => {
    const accountId = getActiveAccountId();
    const sessionId = getActiveAccountSessionId();

    if (!accountId) {
      setNotes([]);
      setQueueJobs([]);
      setActiveNote(null);
      activeNoteRef.current = null;
      return;
    }

    try {
      const localNotes = await listNotesLocal(accountId, false, sessionId);
      if (getActiveAccountId() !== accountId || getActiveAccountSessionId() !== sessionId) {
        return;
      }

      const jobs = await getAllQueueJobs(accountId, sessionId);
      if (getActiveAccountId() !== accountId || getActiveAccountSessionId() !== sessionId) {
        return;
      }

      // Update state only if session is still current
      setNotes(localNotes);
      setQueueJobs(jobs);

      const currentActive = activeNoteRef.current;
      if (currentActive) {
        if (getActiveAccountId() !== accountId || getActiveAccountSessionId() !== sessionId) {
          return;
        }
        const updated = localNotes.find(n => n.id === currentActive.id);
        if (updated) {
          activeNoteRef.current = updated;
          setActiveNote(updated);
        }
      }
    } catch (err: any) {
      if (
        err instanceof StaleSessionError ||
        err?.name === 'StaleSessionError' ||
        err instanceof AccountMismatchError ||
        err?.name === 'AccountMismatchError'
      ) {
        // Expected cancellation caused by account switching or sign-out
        return;
      }
      console.warn('[App] Failed to refresh local data:', err.message);
    }
  };

  // Google Sign-In & Drive Authorization handlers
  const handleClientAuth = () => {
    if (!clientId) {
      alert('Please enter a Google Cloud OAuth Client ID');
      return;
    }
    localStorage.setItem('kurippu_gcp_client_id', clientId);

    if (!window.google?.accounts?.oauth2) {
      alert('Google Identity Services SDK not loaded yet. Check your internet connection.');
      return;
    }

    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: async (resp: any) => {
        if (resp.error) {
          addLog(`Auth Error: ${resp.error} - ${resp.error_description || ''}`);
          return;
        }

        // 1. Fetch real Google identity via about.get
        const adapter = new GoogleDriveStorageAdapter(resp.access_token);
        let profile: GoogleUserProfile;
        try {
          profile = await adapter.getUserProfile();
        } catch (err: any) {
          addLog(`Authentication failed: Could not verify Google user identity (${err.message})`);
          alert(`Google Authentication failed: Could not establish verified identity.\n${err.message}`);
          return;
        }

        // 2. Select account partition in IndexedDB BEFORE loading notes or syncing
        setActiveAccount(profile.permissionId);

        // 3. Update auth store with verified Google profile
        setUser({
          email: profile.emailAddress,
          name: profile.displayName,
          sub: profile.permissionId,
          picture: profile.photoLink,
        });
        setAccessToken(resp.access_token, parseInt(resp.expires_in || '3600', 10));
        setStorageMode('drive');
        addLog(`Google Drive Authorization Successful for ${profile.emailAddress} (Account: ${profile.permissionId})`);

        const boundAdapter = new GoogleDriveStorageAdapter(resp.access_token, profile.permissionId);
        driveAdapterRef.current = boundAdapter;
        syncEngineRef.current.setAdapter(boundAdapter, profile.permissionId);
        syncEngineRef.current.setAuthRequired(false);

        // 4. Load notes from this account's partition into UI
        await refreshLocalData();

        // 5. Inspect if unassigned legacy data exists in kurippu_local_cache
        try {
          const legacySummary = await inspectLegacyCache(profile.permissionId);
          if (legacySummary.exists && !legacySummary.allAlreadyImported) {
            setLegacyCacheInfo(legacySummary);
          } else {
            setLegacyCacheInfo(null);
          }
        } catch (e) {
          console.warn('[App] Error inspecting legacy cache:', e);
        }

        // 6. Automatically hydrate and reconcile notes from Google Drive
        try {
          addLog('Hydrating and reconciling notes from Google Drive...');
          await syncEngineRef.current.hydrateAndReconcileFromDrive();
          await refreshLocalData();
          await syncEngineRef.current.processQueue();
        } catch (err: any) {
          addLog(`Hydration notice: ${err.message}`);
        }
      },
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  };

  const handleSimulateToken = async () => {
    const simSub = 'local_test_sub';
    setActiveAccount(simSub);
    setAccessToken('mock_token_' + nanoid(10), 3600);
    setUser({
      email: 'tester@kurippu.local',
      name: 'Local Test Account',
      sub: simSub,
    });
    setStorageMode('drive');
    addLog('Simulated test token initialized for Drive mode (1 hour validity)');
    await refreshLocalData();
  };

  const handleSignOut = () => {
    // 1. Stop background sync and active polling
    syncEngineRef.current.stopAutoPoll();

    // 2. Clear drive adapter reference so old instance is never reused
    driveAdapterRef.current = null;

    // 3. Switch sync engine to mock adapter and reset
    syncEngineRef.current.setAdapter(mockAdapterRef.current, null);
    syncEngineRef.current.setAuthRequired(true);

    // 4. Close active account partition in IndexedDB
    setActiveAccount(null);

    // 5. Clear all account-specific in-memory React state
    setNotes([]);
    setActiveNote(null);
    activeNoteRef.current = null;
    setQueueJobs([]);
    setLegacyCacheInfo(null);
    setIsMigratingLegacy(false);

    // 6. Update auth store
    signOut();
    addLog('Disconnected from Google Drive. Active account partition closed.');
  };

  const handleImportLegacyCache = async () => {
    if (!user?.sub) return;
    const targetAccountId = user.sub;
    const migrationSessionId = getActiveAccountSessionId();

    await executeLegacyImportWorkflow({
      targetAccountId,
      migrationSessionId,
      getActiveAccountId,
      getActiveAccountSessionId,
      importLegacyCache: importLegacyCacheToActiveAccount,
      refreshLocalData,
      processQueue: () => syncEngineRef.current.processQueue(),
      setLegacyCacheInfo,
      setIsMigratingLegacy,
      addLog,
      inspectLegacyCache,
    });
  };

  const handleManualHydrate = async () => {
    addLog('Manual Hydration triggered: checking Google Drive for updates...');
    try {
      const result = await syncEngineRef.current.hydrateAndReconcileFromDrive();
      await refreshLocalData();
      addLog(`Hydration finished: ${result.importedNotesCount} imported, ${result.updatedNotesCount} updated, ${result.conflictNotesCount} conflicts.`);
    } catch (err: any) {
      addLog(`Manual Hydration failed: ${err.message}`);
    }
  };

  // Note CRUD actions
  const handleCreateNote = async () => {
    const id = nanoid(21);
    const newNote: NoteDocument = {
      id,
      schemaVersion: 1,
      title: `Note ${notes.length + 1} (${nanoid(4)})`,
      type: 'text',
      branches: [{ parentNoteId: 'root', position: notes.length }],
      attributes: [{ type: 'label', name: 'status', value: 'draft' }],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            text: `This is a test note created at ${new Date().toLocaleTimeString()}.`,
          },
        ],
      },
      plainTextPreview: 'This is a test note.',
      outlinks: [],
      attachmentIds: [],
      contentHash: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revisionId: nanoid(),
      baseRevisionId: undefined,
      clientTimestamp: Date.now(),
      clientDeviceId: getClientDeviceId(),
      isDeleted: false,
    };
    newNote.contentHash = await computeContentHash(newNote.content);

    // 1. Synchronously commit to local IndexedDB
    await saveNoteLocal(newNote);

    // 2. Update local manifest
    let manifest = await getManifestLocal();
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
    manifest.notes[newNote.id] = {
      id: newNote.id,
      title: newNote.title,
      type: newNote.type,
      attributes: newNote.attributes,
      contentHash: newNote.contentHash,
      updatedAt: newNote.updatedAt,
      isDeleted: false,
    };
    manifest.branches.push({
      branchId: `root_${newNote.id}`,
      noteId: newNote.id,
      parentNoteId: 'root',
      position: newNote.branches[0].position,
    });
    await saveManifestLocal(manifest);

    // 3. Queue coalesced sync job
    await enqueueOrCoalesceSyncJob({
      jobId: `job_${nanoid(8)}`,
      type: 'SAVE_NOTE',
      targetId: newNote.id,
      payload: newNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    addLog(`Note "${newNote.title}" saved locally to IndexedDB & queued for sync`);
    activeNoteRef.current = newNote;
    setActiveNote(newNote);
    await refreshLocalData();
    syncEngineRef.current.processQueue();
  };

  const handleUpdateActiveNote = async (newTitle: string, newBody: string) => {
    if (!activeNote) return;

    // Look up current note in DB to get ground truth Drive metadata and revision lineage
    const currentNoteInDb = await getNoteLocal(activeNote.id);
    const driveFileId = currentNoteInDb?.driveFileId || activeNote.driveFileId;
    const baseDriveVersion = Math.max(currentNoteInDb?.baseDriveVersion || 0, activeNote.baseDriveVersion || 0) || undefined;
    // Maintain stable baseline revision across keystrokes during this draft editing session:
    // If currentNoteInDb has baseRevisionId === undefined, previous save was committed cleanly to Drive,
    // so currentNoteInDb.revisionId becomes the new baseline.
    // If currentNoteInDb has a baseRevisionId (save still pending/in flight), maintain that baseRevisionId.
    const baseRevisionId =
      currentNoteInDb && currentNoteInDb.baseRevisionId === undefined
        ? currentNoteInDb.revisionId
        : (currentNoteInDb?.baseRevisionId || activeNote.baseRevisionId || activeNote.revisionId);

    const updatedNote: NoteDocument = {
      ...activeNote,
      driveFileId,
      baseDriveVersion,
      baseRevisionId,
      duplicateDriveFileIds: activeNote.duplicateDriveFileIds || currentNoteInDb?.duplicateDriveFileIds,
      title: newTitle,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', text: newBody }],
      },
      plainTextPreview: newBody.slice(0, 100),
      updatedAt: new Date().toISOString(),
      revisionId: nanoid(),
      clientTimestamp: Date.now(),
      clientDeviceId: getClientDeviceId(),
    };
    updatedNote.contentHash = await computeContentHash(updatedNote.content);

    // 1. Commit immediately to local IndexedDB (<5ms)
    await saveNoteLocal(updatedNote);

    // 2. Coalesce into sync queue (at most one pending save job per note)
    await enqueueOrCoalesceSyncJob({
      jobId: `job_${nanoid(8)}`,
      type: 'SAVE_NOTE',
      targetId: updatedNote.id,
      payload: updatedNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    activeNoteRef.current = updatedNote;
    setActiveNote(updatedNote);
    await refreshLocalData();

    // 3. Debounce background queue dispatch by 1000ms to prevent network thrashing while typing
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(() => {
      syncEngineRef.current.processQueue();
    }, 1000);
  };

  // Concurrency & Divergence Simulator
  const handleSimulateRemoteConflict = async () => {
    if (!activeNote) {
      alert('Select a note first.');
      return;
    }

    if (storageMode === 'mock') {
      const targetNote = activeNote;
      const file = Array.from(mockAdapterRef.current.files.values()).find(
        f => f.appProperties['kurippuNoteId'] === targetNote.id
      );

      if (file) {
        const remoteDoc = JSON.parse(file.content) as NoteDocument;
        remoteDoc.content = {
          type: 'doc',
          content: [{ type: 'paragraph', text: `Remote device conflict edit at ${new Date().toLocaleTimeString()}!` }],
        };
        remoteDoc.contentHash = await computeContentHash(remoteDoc.content);
        remoteDoc.baseDriveVersion = file.version + 1;
        file.content = JSON.stringify(remoteDoc);
        file.version += 1;
        addLog(`[Simulator] Simulated remote device edit on "${targetNote.title}" -> Remote Drive version is now ${file.version}`);
      } else {
        alert('Note not yet synced to mock Drive. Save it first.');
        return;
      }
    } else {
      alert('Conflict simulation is supported in Mock Drive mode.');
      return;
    }

    handleUpdateActiveNote(activeNote.title, `Local divergent edit at ${new Date().toLocaleTimeString()}`);
  };

  const handleToggleOffline = () => {
    const next = !isOffline;
    setIsOffline(next);
    syncEngineRef.current.setOffline(next);
    addLog(next ? 'Simulated network offline (Sync paused)' : 'Network reconnected (Sync resumed)');
  };

  const handleReconstructManifest = async () => {
    addLog('Executing Automated Manifest Reconstruction Scanner...');
    const localNotes = await listNotesLocal();
    const reconstructed = await reconstructManifestFromNotes(localNotes);
    await saveManifestLocal(reconstructed);
    addLog(`Reconstructed manifest with ${Object.keys(reconstructed.notes).length} notes and ${reconstructed.branches.length} branches.`);
    await refreshLocalData();
  };

  const handleClearLocal = async () => {
    if (confirm('Clear local IndexedDB cache? (Simulates clean browser / new device to test recovery)')) {
      await clearLocalDatabase();
      setActiveNote(null);
      await refreshLocalData();
      addLog('Local IndexedDB database cleared. Click "Hydrate / Sync from Drive" to test cloud recovery.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-blue-600/20 text-blue-400 rounded-lg border border-blue-500/30">
            <GitBranch className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              Kurippu <span className="text-xs bg-blue-950 text-blue-300 px-2 py-0.5 rounded border border-blue-800">Drive Sync PoC</span>
            </h1>
            <p className="text-xs text-slate-400">Google Drive Persistence, Idempotency & Concurrency Verification</p>
          </div>
        </div>

        {/* Persistence Status Badge */}
        <div className="flex items-center gap-3">
          <div className={`px-3 py-1.5 rounded-full border text-xs font-semibold flex items-center gap-2 ${
            persistenceState === 'COMMITTED_REMOTE' ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300' :
            persistenceState === 'SYNCING' ? 'bg-blue-950/60 border-blue-700/60 text-blue-300 animate-pulse' :
            persistenceState === 'AUTH_REQUIRED' ? 'bg-amber-950/80 border-amber-600 text-amber-200 animate-bounce' :
            persistenceState === 'CONFLICT_DIVERGED' ? 'bg-purple-950/60 border-purple-700/60 text-purple-300' :
            persistenceState === 'OFFLINE' ? 'bg-yellow-950/60 border-yellow-700/60 text-yellow-300' :
            'bg-slate-800 border-slate-700 text-slate-300'
          }`}>
            {persistenceState === 'COMMITTED_REMOTE' ? <CheckCircle className="w-3.5 h-3.5" /> :
             persistenceState === 'AUTH_REQUIRED' ? <Shield className="w-3.5 h-3.5 text-amber-400" /> :
             persistenceState === 'CONFLICT_DIVERGED' ? <AlertTriangle className="w-3.5 h-3.5" /> :
             persistenceState === 'OFFLINE' ? <WifiOff className="w-3.5 h-3.5" /> :
             <RefreshCw className={`w-3.5 h-3.5 ${persistenceState === 'SYNCING' ? 'animate-spin' : ''}`} />}
            <span>{persistenceState}: {statusMessage}</span>
          </div>

          <button
            onClick={handleToggleOffline}
            className={`px-3 py-1.5 rounded text-xs font-medium border flex items-center gap-1.5 ${
              isOffline ? 'bg-yellow-600/20 border-yellow-500 text-yellow-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {isOffline ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5" />}
            {isOffline ? 'Offline Active' : 'Simulate Offline'}
          </button>
        </div>
      </header>

      {/* Legacy Data Isolation & Recovery Banner */}
      {legacyCacheInfo && legacyCacheInfo.exists && !legacyCacheInfo.allAlreadyImported && (
        <div className="bg-amber-950/40 border-b border-amber-800/60 px-6 py-3 flex items-center justify-between text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <div>
              <span className="font-semibold">Unassigned Legacy Cache Detected:</span>{' '}
              {legacyCacheInfo.unimportedNotesCount !== undefined && legacyCacheInfo.unimportedNotesCount < legacyCacheInfo.notesCount ? (
                <>
                  {legacyCacheInfo.unimportedNotesCount} unimported of {legacyCacheInfo.notesCount} note(s)
                  {legacyCacheInfo.pendingJobsCount > 0 ? `, ${legacyCacheInfo.pendingJobsCount} pending job(s)` : ''} found in <code>kurippu_local_cache</code>.
                </>
              ) : (
                <>
                  {legacyCacheInfo.notesCount} note(s), {legacyCacheInfo.pendingJobsCount} pending job(s) found in <code>kurippu_local_cache</code> from before account isolation.
                </>
              )}
              Preserved safely and unassigned.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {user?.sub && (
              <button
                onClick={handleImportLegacyCache}
                disabled={isMigratingLegacy}
                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded font-medium disabled:opacity-50"
              >
                {isMigratingLegacy ? 'Importing...' : `Import into ${user.email}`}
              </button>
            )}
            <button
              onClick={() => setLegacyCacheInfo(null)}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-medium"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Grid Content */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto w-full">
        {/* Left Column: Auth, Mode & Storage Info (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Storage Adapter Mode */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-blue-400" /> Storage Engine Target
            </h2>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                onClick={() => setStorageMode('drive')}
                className={`py-2 px-3 text-xs rounded-lg font-medium border text-center transition ${
                  storageMode === 'drive' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                Live Google Drive
              </button>
              <button
                onClick={() => setStorageMode('mock')}
                className={`py-2 px-3 text-xs rounded-lg font-medium border text-center transition ${
                  storageMode === 'mock' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                In-Memory Mock
              </button>
            </div>
            <div className="text-xs text-slate-400">
              {storageMode === 'drive' ? (
                <div className="p-2 bg-blue-950/40 rounded border border-blue-900/50">
                  <span className="font-semibold text-blue-300">Live Drive Mode:</span> Persists to real user Google Drive. If unauthorized, edits buffer in local IndexedDB.
                </div>
              ) : (
                <div className="p-2 bg-slate-800/40 rounded border border-slate-700/50">
                  <span className="font-semibold text-slate-300">Mock Mode:</span> Completely in-memory simulation. Zero external network calls.
                </div>
              )}
            </div>
          </div>

          {/* Authentication & Authorization */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" /> Google Identity & Authorization
            </h2>

            {user ? (
              <div className="space-y-3">
                <div className="p-3 bg-slate-800/80 rounded-lg border border-slate-700 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-white">{user.name}</div>
                    <div className="text-xs text-slate-400">{user.email}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded border ${
                    isDriveAuthorized ? 'bg-emerald-950 text-emerald-400 border-emerald-800' : 'bg-amber-950 text-amber-400 border-amber-800'
                  }`}>
                    {isDriveAuthorized ? 'Drive Authorized' : 'Authorization Required'}
                  </span>
                </div>

                {!isDriveAuthorized && (
                  <div className="p-2.5 bg-amber-950/60 border border-amber-700/60 rounded text-xs text-amber-200">
                    <p className="font-medium mb-1.5">Session expired or unauthorized:</p>
                    <button
                      onClick={handleClientAuth}
                      className="w-full py-1.5 px-3 bg-amber-600 hover:bg-amber-500 text-white rounded font-semibold text-xs"
                    >
                      Authorize Google Drive Now
                    </button>
                  </div>
                )}

                <div className="text-xs text-slate-400 space-y-1">
                  <div>Token Expiry: {tokenExpiresAt ? new Date(tokenExpiresAt).toLocaleTimeString() : 'Expired / Not Loaded'}</div>
                  <div className="font-mono truncate text-[11px] text-slate-500">Token: {accessToken ? `${accessToken.slice(0, 20)}...` : 'None (In-Memory)'}</div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleManualHydrate}
                    className="flex-1 py-1.5 px-3 bg-blue-900/40 hover:bg-blue-800/60 border border-blue-700 text-blue-200 rounded text-xs font-medium flex items-center justify-center gap-1.5"
                  >
                    <DownloadCloud className="w-3.5 h-3.5" /> Hydrate from Drive
                  </button>
                  <button
                    onClick={handleSignOut}
                    className="py-1.5 px-3 bg-red-950/60 hover:bg-red-900/60 border border-red-800 text-red-300 rounded text-xs font-medium"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">GCP OAuth 2.0 Web Client ID:</label>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="123456789-xxx.apps.googleusercontent.com"
                    className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <button
                  onClick={handleClientAuth}
                  className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold flex items-center justify-center gap-2"
                >
                  <Cloud className="w-4 h-4" /> Authorize with Google Identity (GIS)
                </button>

                <button
                  onClick={handleSimulateToken}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded text-xs font-medium"
                >
                  Use Mock Test Token (Headless)
                </button>
              </div>
            )}
          </div>

          {/* Local Storage & Recovery Tools */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-purple-400" /> Local Cache & Integrity
            </h2>
            <div className="text-xs text-slate-400 space-y-1">
              <div>IndexedDB Notes Count: <span className="font-semibold text-white">{notes.length}</span></div>
              <div>Write-Ahead Sync Queue: <span className="font-semibold text-white">{queueJobs.length}</span> pending jobs</div>
              <div>Storage Persistence: <span className="text-emerald-400">{storageInfo.persisted ? 'Granted' : 'Standard'}</span></div>
            </div>

            <div className="pt-2 flex flex-col gap-2">
              <button
                onClick={handleManualHydrate}
                className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-xs text-slate-200 font-medium text-left flex items-center gap-2"
              >
                <DownloadCloud className="w-3.5 h-3.5 text-emerald-400" /> Hydrate / Restore from Google Drive
              </button>
              <button
                onClick={handleReconstructManifest}
                className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-xs text-slate-200 font-medium text-left flex items-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5 text-blue-400" /> Rebuild Manifest from Notes
              </button>
              <button
                onClick={handleClearLocal}
                className="py-1.5 px-3 bg-slate-800 hover:bg-red-950 border border-slate-700 hover:border-red-800 rounded text-xs text-slate-400 hover:text-red-300 font-medium text-left flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5" /> Clear Local IndexedDB (Simulate Clean Device)
              </button>
            </div>
          </div>
        </div>

        {/* Center & Right Column: Notes CRUD & Concurrency Testing (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Notes Management Panel */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-400" /> Self-Describing Notes CRUD
              </h2>
              <button
                onClick={handleCreateNote}
                className="py-1.5 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold flex items-center gap-1.5"
              >
                + Create Note
              </button>
            </div>

            {/* Note Selector / Table */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="border border-slate-800 rounded-lg p-2 max-h-48 overflow-y-auto space-y-1 bg-slate-950">
                {notes.length === 0 ? (
                  <div className="text-xs text-slate-500 p-3 text-center">No notes in local cache. Click "+ Create Note" or "Hydrate from Drive".</div>
                ) : (
                  notes.map(n => (
                    <div
                      key={n.id}
                      onClick={() => {
                        activeNoteRef.current = n;
                        setActiveNote(n);
                      }}
                      className={`p-2 rounded text-xs cursor-pointer flex items-center justify-between ${
                        activeNote?.id === n.id ? 'bg-blue-600/20 border border-blue-500/50 text-white' : 'hover:bg-slate-800/60 text-slate-300'
                      }`}
                    >
                      <div className="truncate font-medium flex items-center gap-1.5">
                        {n.duplicateDriveFileIds && n.duplicateDriveFileIds.length > 0 && (
                          <span title={`Has ${n.duplicateDriveFileIds.length} duplicate file(s) on Drive`}>
                            <Layers className="w-3 h-3 text-amber-400 flex-shrink-0" />
                          </span>
                        )}
                        <span>{n.title}</span>
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">v{n.baseDriveVersion || 0}</div>
                    </div>
                  ))
                )}
              </div>

              {/* Concurrency Simulator Actions */}
              <div className="border border-slate-800 rounded-lg p-3 bg-slate-950 flex flex-col justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Concurrency & Conflict Simulator
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                    Simulates a second device writing a newer version with divergent text to Drive before local save. Verifies that the conflict is preserved as a sibling copy without lost updates.
                  </p>
                </div>
                <button
                  disabled={!activeNote || storageMode !== 'mock'}
                  onClick={handleSimulateRemoteConflict}
                  className="py-1.5 px-3 bg-amber-950/70 hover:bg-amber-900 border border-amber-800 text-amber-200 rounded text-xs font-semibold disabled:opacity-40"
                >
                  Simulate Remote Conflict on Selected Note
                </button>
              </div>
            </div>

            {/* Active Note Inspection & Live Editing */}
            {activeNote ? (
              <div className="p-4 bg-slate-950 rounded-lg border border-slate-800 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="text-xs font-mono text-slate-400">ID: {activeNote.id}</div>
                  <div className="text-xs text-slate-400">Revision: {activeNote.revisionId?.slice(0, 8)}...</div>
                </div>

                {activeNote.duplicateDriveFileIds && activeNote.duplicateDriveFileIds.length > 0 && (
                  <div className="p-2 bg-amber-950/50 border border-amber-800/60 rounded text-xs text-amber-300 flex items-center justify-between">
                    <span>Notice: Detected {activeNote.duplicateDriveFileIds.length} existing duplicate file(s) on Drive. Preserved without deleting. Canonical: {activeNote.driveFileId}</span>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Title</label>
                    <input
                      type="text"
                      value={activeNote.title}
                      onChange={(e) => {
                        const newTitle = e.target.value;
                        const body = activeNote.content.content?.[0]?.text || '';
                        handleUpdateActiveNote(newTitle, body);
                      }}
                      className="w-full bg-slate-900 border border-slate-800 rounded p-2 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Content Text (Paragraph)</label>
                    <input
                      type="text"
                      value={activeNote.content.content?.[0]?.text || ''}
                      onChange={(e) => {
                        handleUpdateActiveNote(activeNote.title, e.target.value);
                      }}
                      className="w-full bg-slate-900 border border-slate-800 rounded p-2 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
                  <div>Drive File ID: <span className="font-mono text-slate-300">{activeNote.driveFileId || 'Not yet uploaded'}</span></div>
                  <div>Base Drive Version: <span className="font-mono text-slate-300">{activeNote.baseDriveVersion || 'Uncommitted'}</span></div>
                </div>
              </div>
            ) : (
              <div className="p-6 bg-slate-950 rounded-lg border border-slate-800 text-center text-xs text-slate-500">
                Select or create a note to view its self-describing metadata and test write-ahead persistence.
              </div>
            )}
          </div>

          {/* Audit Logs Console */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Execution & Event Log</h2>
              <button
                onClick={() => setLogs([])}
                className="text-[11px] text-slate-500 hover:text-slate-300"
              >
                Clear Log
              </button>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 h-48 overflow-y-auto font-mono text-[11px] text-slate-300 space-y-1">
              {logs.length === 0 ? (
                <div className="text-slate-600 italic">No events logged yet.</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="leading-tight">
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
