import React, { useState, useEffect, useRef } from 'react';
import { useAuthStore } from './features/auth/authStore';
import { NoteDocument, PersistenceState, SyncJob } from './types/storage';
import { GoogleDriveStorageAdapter } from './lib/google-drive/driveAdapter';
import { MockDriveAdapter } from './lib/google-drive/mockDriveAdapter';
import { SyncEngine } from './features/sync/syncEngine';
import {
  saveNoteLocal,
  listNotesLocal,
  getManifestLocal,
  saveManifestLocal,
  enqueueSyncJob,
  getAllQueueJobs,
  clearLocalDatabase,
  requestPersistentStorage,
} from './lib/indexeddb/cache';
import { reconstructManifestFromNotes } from './lib/storage/reconciliation';
import { computeContentHash } from './lib/storage/hash';
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
} from 'lucide-react';

declare global {
  interface Window {
    google?: any;
  }
}

export const App: React.FC = () => {
  const { user, accessToken, tokenExpiresAt, isDriveAuthorized, setUser, setAccessToken, signOut } = useAuthStore();

  const [useMock, setUseMock] = useState(true);
  const [clientId, setClientId] = useState(() => localStorage.getItem('kurippu_gcp_client_id') || '');
  const [persistenceState, setPersistenceState] = useState<PersistenceState>('IDLE');
  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [logs, setLogs] = useState<string[]>([]);
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [activeNote, setActiveNote] = useState<NoteDocument | null>(null);
  const [queueJobs, setQueueJobs] = useState<SyncJob[]>([]);
  const [isOffline, setIsOffline] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{ persisted: boolean; quota?: number; usage?: number }>({ persisted: false });

  const mockAdapterRef = useRef(new MockDriveAdapter());
  const driveAdapterRef = useRef<GoogleDriveStorageAdapter | null>(null);
  const syncEngineRef = useRef<SyncEngine>(new SyncEngine(mockAdapterRef.current));

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 99)]);
  };

  // Initialize adapters & sync engine
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

    refreshLocalData();
    return () => {
      unsubscribe();
    };
  }, []);

  // Switch between Mock and Live Drive Adapter
  useEffect(() => {
    if (useMock) {
      syncEngineRef.current.setAdapter(mockAdapterRef.current);
      addLog('Using In-Memory Mock Drive Storage Adapter');
    } else {
      if (!accessToken) {
        addLog('Live Drive selected: Please authorize with Google Drive first.');
      } else {
        if (!driveAdapterRef.current) {
          driveAdapterRef.current = new GoogleDriveStorageAdapter(accessToken);
        } else {
          driveAdapterRef.current.setAccessToken(accessToken);
        }
        syncEngineRef.current.setAdapter(driveAdapterRef.current);
        addLog('Using Live Google Drive REST API Adapter');
      }
    }
  }, [useMock, accessToken]);

  const refreshLocalData = async () => {
    const localNotes = await listNotesLocal();
    setNotes(localNotes);
    const jobs = await getAllQueueJobs();
    setQueueJobs(jobs);
    if (activeNote) {
      const updated = localNotes.find(n => n.id === activeNote.id);
      if (updated) setActiveNote(updated);
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
      callback: (resp: any) => {
        if (resp.error) {
          addLog(`Auth Error: ${resp.error} - ${resp.error_description || ''}`);
          return;
        }
        setAccessToken(resp.access_token, parseInt(resp.expires_in || '3600', 10));
        setUser({
          email: 'Authorized User',
          name: 'Google Drive User',
          sub: 'authorized_gdrive',
        });
        setUseMock(false);
        addLog('Google Drive Authorization Successful (drive.file scope acquired)');
      },
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  };

  const handleSimulateToken = () => {
    setAccessToken('mock_token_' + nanoid(10), 3600);
    setUser({
      email: 'tester@kurippu.local',
      name: 'Local Test Account',
      sub: 'local_test_sub',
    });
    addLog('Simulated test token initialized (1 hour validity)');
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
      clientTimestamp: Date.now(),
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

    // 3. Queue sync job
    await enqueueSyncJob({
      jobId: `job_${nanoid(8)}`,
      type: 'SAVE_NOTE',
      targetId: newNote.id,
      payload: newNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    addLog(`Note "${newNote.title}" saved locally to IndexedDB & queued for sync`);
    setActiveNote(newNote);
    await refreshLocalData();
    syncEngineRef.current.processQueue();
  };

  const handleUpdateActiveNote = async (newTitle: string, newBody: string) => {
    if (!activeNote) return;

    const updatedNote: NoteDocument = {
      ...activeNote,
      title: newTitle,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', text: newBody }],
      },
      plainTextPreview: newBody.slice(0, 100),
      updatedAt: new Date().toISOString(),
      revisionId: nanoid(),
      clientTimestamp: Date.now(),
    };
    updatedNote.contentHash = await computeContentHash(updatedNote.content);

    await saveNoteLocal(updatedNote);
    await enqueueSyncJob({
      jobId: `job_${nanoid(8)}`,
      type: 'SAVE_NOTE',
      targetId: updatedNote.id,
      payload: updatedNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    addLog(`Updated "${updatedNote.title}" in IndexedDB. Queued sync job.`);
    setActiveNote(updatedNote);
    await refreshLocalData();
    syncEngineRef.current.processQueue();
  };

  // Concurrency & Divergence Simulator
  const handleSimulateRemoteConflict = async () => {
    if (!activeNote) {
      alert('Select a note first.');
      return;
    }

    if (useMock) {
      // Find the note in mock files and bump version with conflicting text
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
      alert('Simulation is supported in Mock Drive mode.');
      return;
    }

    // Now edit local note with divergent text
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
    if (confirm('Clear local IndexedDB cache?')) {
      await clearLocalDatabase();
      setActiveNote(null);
      await refreshLocalData();
      addLog('Local IndexedDB database cleared.');
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
              Kurippu <span className="text-xs bg-blue-950 text-blue-300 px-2 py-0.5 rounded border border-blue-800">Phase 2 Technical PoC</span>
            </h1>
            <p className="text-xs text-slate-400">Google Drive Persistence & Concurrency Verification Testbench</p>
          </div>
        </div>

        {/* Persistence Status Badge */}
        <div className="flex items-center gap-3">
          <div className={`px-3 py-1.5 rounded-full border text-xs font-semibold flex items-center gap-2 ${
            persistenceState === 'COMMITTED_REMOTE' ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300' :
            persistenceState === 'SYNCING' ? 'bg-blue-950/60 border-blue-700/60 text-blue-300 animate-pulse' :
            persistenceState === 'CONFLICT_DIVERGED' ? 'bg-amber-950/60 border-amber-700/60 text-amber-300' :
            persistenceState === 'OFFLINE' ? 'bg-yellow-950/60 border-yellow-700/60 text-yellow-300' :
            'bg-slate-800 border-slate-700 text-slate-300'
          }`}>
            {persistenceState === 'COMMITTED_REMOTE' ? <CheckCircle className="w-3.5 h-3.5" /> :
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

      {/* Main Grid Content */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto w-full">
        {/* Left Column: Auth, Mode & Storage Info (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Storage Adapter Mode */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-blue-400" /> Storage Engine Target
            </h2>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button
                onClick={() => setUseMock(true)}
                className={`py-2 px-3 text-xs rounded-lg font-medium border text-center transition ${
                  useMock ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                In-Memory Mock Drive
              </button>
              <button
                onClick={() => setUseMock(false)}
                className={`py-2 px-3 text-xs rounded-lg font-medium border text-center transition ${
                  !useMock ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                Live Google Drive API
              </button>
            </div>
            <p className="text-xs text-slate-400">
              {useMock
                ? 'Running with zero external dependencies. Supports simulated multi-client concurrency, latency, and 429 errors.'
                : 'Connecting directly to Google Drive REST API v3 using user OAuth token.'}
            </p>
          </div>

          {/* Authentication & Authorization */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" /> Google Identity & GIS Token
            </h2>

            {user ? (
              <div className="space-y-3">
                <div className="p-3 bg-slate-800/80 rounded-lg border border-slate-700 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-white">{user.name}</div>
                    <div className="text-xs text-slate-400">{user.email}</div>
                  </div>
                  <span className="text-xs bg-emerald-950 text-emerald-400 px-2 py-0.5 rounded border border-emerald-800">
                    {isDriveAuthorized ? 'Drive Authorized' : 'Sign-In Only'}
                  </span>
                </div>

                <div className="text-xs text-slate-400 space-y-1">
                  <div>Token Expiry: {tokenExpiresAt ? new Date(tokenExpiresAt).toLocaleTimeString() : 'N/A'}</div>
                  <div className="font-mono truncate text-[11px] text-slate-500">Token: {accessToken?.slice(0, 20)}...</div>
                </div>

                <button
                  onClick={signOut}
                  className="w-full py-1.5 px-3 bg-red-950/60 hover:bg-red-900/60 border border-red-800 text-red-300 rounded text-xs font-medium"
                >
                  Disconnect / Sign Out
                </button>
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
                onClick={handleReconstructManifest}
                className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-xs text-slate-200 font-medium text-left flex items-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5 text-blue-400" /> Run Manifest Reconstruction Scanner
              </button>
              <button
                onClick={handleClearLocal}
                className="py-1.5 px-3 bg-slate-800 hover:bg-red-950 border border-slate-700 hover:border-red-800 rounded text-xs text-slate-400 hover:text-red-300 font-medium text-left flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5" /> Wipe Local IndexedDB Cache
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
                  <div className="text-xs text-slate-500 p-3 text-center">No notes in local cache. Click "+ Create Note" above.</div>
                ) : (
                  notes.map(n => (
                    <div
                      key={n.id}
                      onClick={() => setActiveNote(n)}
                      className={`p-2 rounded text-xs cursor-pointer flex items-center justify-between ${
                        activeNote?.id === n.id ? 'bg-blue-600/20 border border-blue-500/50 text-white' : 'hover:bg-slate-800/60 text-slate-300'
                      }`}
                    >
                      <div className="truncate font-medium">{n.title}</div>
                      <div className="text-[10px] text-slate-500 font-mono">v{n.baseDriveVersion || 0}</div>
                    </div>
                  ))
                )}
              </div>

              {/* Concurrency Simulator Actions */}
              <div className="border border-slate-800 rounded-lg p-3 bg-slate-950 flex flex-col justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Concurrency & Collision Test
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                    Simulates a second device writing a newer version with divergent text to Drive before local save. Verifies that the conflict is preserved as a sibling copy without lost updates.
                  </p>
                </div>
                <button
                  disabled={!activeNote || !useMock}
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
                  <div>Hash: <span className="font-mono text-slate-500">{activeNote.contentHash?.slice(0, 16)}...</span></div>
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
