import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngine } from '../features/sync/syncEngine';
import { MockDriveAdapter } from '../lib/google-drive/mockDriveAdapter';
import { GoogleDriveStorageAdapter } from '../lib/google-drive/driveAdapter';
import {
  clearLocalDatabase,
  saveNoteLocal,
  listNotesLocal,
  getNoteLocal,
  saveManifestLocal,
  enqueueOrCoalesceSyncJob,
  getPendingJobCount,
  getManifestLocal,
  getAllQueueJobs,
  setActiveAccount,
  getActiveAccountId,
  getActiveAccountSessionId,
  inspectLegacyCache,
  importLegacyCacheToActiveAccount,
  hasPendingJobForNote,
  recoverInterruptedJobs,
  retryFailedJobs,
  AccountMismatchError,
  StaleSessionError,
  LegacyDatabaseUnavailableError,
  getLocalDB,
  setMigrationBeforeWriteHookForTesting,
  setLegacyDbNameForTesting,
  setLegacyDatabaseExistenceCheckerForTesting,
  setDbOpenWrapperForTesting,
} from '../lib/indexeddb/cache';
import { openDB, deleteDB } from 'idb';
import { NoteDocument, ApplicationManifest, DriveFolderInfo } from '../types/storage';
import { useAuthStore } from '../features/auth/authStore';
import { setClientDeviceIdForTesting } from '../lib/storage/deviceId';
import { computeContentHash } from '../lib/storage/hash';
import { executeLegacyImportWorkflow } from '../App';
import { LegacyCacheImportResult } from '../lib/indexeddb/cache';

describe('Google Drive Sync Reliability & Idempotency Tests', () => {
  let adapter: MockDriveAdapter;
  let syncEngine: SyncEngine;

  beforeEach(async () => {
    setMigrationBeforeWriteHookForTesting(null);
    setLegacyDbNameForTesting(null);
    setLegacyDatabaseExistenceCheckerForTesting(null);
    setDbOpenWrapperForTesting(null);
    setActiveAccount('test_device_default');
    setClientDeviceIdForTesting('test_device_default');
    await clearLocalDatabase();
    adapter = new MockDriveAdapter();
    syncEngine = new SyncEngine(adapter, 'test_device_default');
    useAuthStore.setState({
      user: null,
      storageMode: 'mock',
      accessToken: null,
      tokenExpiresAt: null,
      isDriveAuthorized: false,
      isLoading: false,
      error: null,
    });
  });

  const createNote = (id: string, text: string, driveFileId?: string, baseDriveVersion?: number): NoteDocument => ({
    id,
    schemaVersion: 1,
    title: `Note ${id}`,
    type: 'text',
    branches: [{ parentNoteId: 'root', position: 0 }],
    attributes: [],
    content: { type: 'doc', content: [{ type: 'paragraph', text }] },
    plainTextPreview: text,
    outlinks: [],
    attachmentIds: [],
    contentHash: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revisionId: `rev_${id}_1`,
    driveFileId,
    baseDriveVersion,
    clientTimestamp: Date.now(),
    isDeleted: false,
  });

  const openLegacyDatabase = (dbName: string) =>
    openDB(dbName, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('manifest')) db.createObjectStore('manifest');
        if (!db.objectStoreNames.contains('sync_queue')) {
          const qStore = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
          qStore.createIndex('by_status', 'status');
        }
      },
    });

  // Test 1: Repeated saves of the same note reuse one Drive file
  it('1. Repeated saves of the same note reuse one Drive file', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();
    const note = createNote('note_idempotent_1', 'Version 1');

    // First save: creates file
    const res1 = await adapter.saveNote(note, folderInfo);
    expect(res1.version).toBe(1);
    const originalFileId = res1.fileId;
    expect(originalFileId).toBeDefined();

    // Verify 1 note file exists in Drive
    let driveNotes = await adapter.listDriveNotes(folderInfo);
    expect(driveNotes.length).toBe(1);

    // Second save: note without driveFileId passed directly (simulating lost in-memory reference)
    const noteWithoutDriveId = createNote('note_idempotent_1', 'Version 2');
    const res2 = await adapter.saveNote(noteWithoutDriveId, folderInfo);

    // It MUST reuse originalFileId and increment version, NOT create a second file!
    expect(res2.fileId).toBe(originalFileId);
    expect(res2.version).toBe(2);

    driveNotes = await adapter.listDriveNotes(folderInfo);
    expect(driveNotes.length).toBe(1);

    // Third save: note with driveFileId
    const noteWithDriveId = createNote('note_idempotent_1', 'Version 3', originalFileId, 2);
    const res3 = await adapter.saveNote(noteWithDriveId, folderInfo);
    expect(res3.fileId).toBe(originalFileId);
    expect(res3.version).toBe(3);

    driveNotes = await adapter.listDriveNotes(folderInfo);
    expect(driveNotes.length).toBe(1);
  });

  // Test 2: Drive file IDs persist between queued saves
  it('2. Drive file IDs persist between queued saves', async () => {
    const note = createNote('note_persist_id', 'Initial Content');
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_p1',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Process initial save
    await syncEngine.processQueue();

    // Verify local note in IndexedDB now has driveFileId populated
    const noteAfterSave1 = await getNoteLocal('note_persist_id');
    expect(noteAfterSave1?.driveFileId).toBeDefined();
    const assignedDriveFileId = noteAfterSave1!.driveFileId;

    // Enqueue second edit where payload in memory lacked driveFileId
    const secondEditNote = createNote('note_persist_id', 'Second Content');
    // Save to local DB preserving driveFileId
    secondEditNote.driveFileId = assignedDriveFileId;
    await saveNoteLocal(secondEditNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_p2',
      type: 'SAVE_NOTE',
      targetId: secondEditNote.id,
      payload: secondEditNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    await syncEngine.processQueue();

    const folderInfo = await adapter.discoverOrCreateAppFolders();
    const driveNotes = await adapter.listDriveNotes(folderInfo);
    expect(driveNotes.length).toBe(1);
    expect(driveNotes[0].fileId).toBe(assignedDriveFileId);

    const finalNote = await getNoteLocal('note_persist_id');
    expect(finalNote?.driveFileId).toBe(assignedDriveFileId);
    expect(finalNote?.content.content[0].text).toBe('Second Content');
  });

  // Test 3: Existing duplicate files are detected and handled safely
  it('3. Existing duplicate files are detected and handled safely', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // Inject two pre-existing files on Drive for the same noteId (simulating previous bug output)
    adapter.files.set('duplicate_file_old', {
      id: 'duplicate_file_old',
      name: 'note_dup.json',
      mimeType: 'application/json',
      parents: [folderInfo.notesFolderId],
      content: JSON.stringify(createNote('note_dup', 'Old text', 'duplicate_file_old', 1)),
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'note', kurippuNoteId: 'note_dup' },
      trashed: false,
      modifiedTime: '2026-11-01T10:00:00.000Z',
    });

    adapter.files.set('duplicate_file_new', {
      id: 'duplicate_file_new',
      name: 'note_dup.json',
      mimeType: 'application/json',
      parents: [folderInfo.notesFolderId],
      content: JSON.stringify(createNote('note_dup', 'Newer text', 'duplicate_file_new', 2)),
      version: 2,
      appProperties: { kurippuApp: 'true', kurippuRole: 'note', kurippuNoteId: 'note_dup' },
      trashed: false,
      modifiedTime: '2026-11-02T10:00:00.000Z',
    });

    // Call getNote
    const fetched = await adapter.getNote('note_dup', folderInfo);
    expect(fetched).not.toBeNull();
    // Must select the newest canonical file (duplicate_file_new)
    expect(fetched?.note.driveFileId).toBe('duplicate_file_new');
    expect(fetched?.version).toBe(2);
    // Must report the older duplicate without deleting it
    expect(fetched?.duplicates?.length).toBe(1);
    expect(fetched?.duplicates?.[0].fileId).toBe('duplicate_file_old');

    // Both files must still exist in Drive (preservation of user data!)
    expect(adapter.files.has('duplicate_file_old')).toBe(true);
    expect(adapter.files.has('duplicate_file_new')).toBe(true);
    expect(adapter.files.get('duplicate_file_old')?.trashed).toBe(false);

    // Saving an update must update the canonical file, NOT create a 3rd file
    const updateNote = createNote('note_dup', 'Updated text');
    const saveRes = await adapter.saveNote(updateNote, folderInfo);
    expect(saveRes.fileId).toBe('duplicate_file_new');
    expect(saveRes.version).toBe(3);

    const driveFiles = await adapter.listDriveNotes(folderInfo);
    expect(driveFiles.length).toBe(2); // Still 2 files, no new duplicate created
  });

  // Test 4: Manifest updates are idempotent
  it('4. Manifest updates are idempotent', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    const manifest1: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 1,
      notes: {},
      branches: [],
    };

    // First save creates manifest file
    const res1 = await adapter.saveManifest(folderInfo, manifest1);
    expect(res1.fileId).toBeDefined();
    expect(res1.version).toBe(1);
    expect(folderInfo.manifestFileId).toBe(res1.fileId);

    // Second save updates the same manifest file
    manifest1.revisionSequence = 2;
    const res2 = await adapter.saveManifest(folderInfo, manifest1);
    expect(res2.fileId).toBe(res1.fileId);
    expect(res2.version).toBe(2);

    // Third save with folderInfo where manifestFileId was cleared (simulating lost in-memory ref)
    const freshFolderInfo = { rootFolderId: folderInfo.rootFolderId, notesFolderId: folderInfo.notesFolderId };
    manifest1.revisionSequence = 3;
    const res3 = await adapter.saveManifest(freshFolderInfo, manifest1);
    expect(res3.fileId).toBe(res1.fileId); // Reused existing file!
    expect(res3.version).toBe(3);

    // Verify only ONE manifest file exists in Drive root folder
    const allRootFiles = Array.from(adapter.files.values()).filter(
      f => f.parents.includes(folderInfo.rootFolderId) && f.appProperties['kurippuRole'] === 'manifest' && !f.trashed
    );
    expect(allRootFiles.length).toBe(1);
  });

  // Test 5: Multiple queued edits preserve the latest note content
  it('5. Multiple queued edits preserve the latest note content via coalescing', async () => {
    const noteId = 'note_coalesce_test';

    // Simulate rapid typing: 3 edits enqueued while offline/paused
    syncEngine.setOffline(true);

    const edit1 = createNote(noteId, 'First draft (H)');
    await saveNoteLocal(edit1);
    await enqueueOrCoalesceSyncJob({
      jobId: 'j1',
      type: 'SAVE_NOTE',
      targetId: noteId,
      payload: edit1,
      clientTimestamp: 1000,
      retryCount: 0,
      status: 'pending',
    });

    const edit2 = createNote(noteId, 'Second draft (Hello)');
    await saveNoteLocal(edit2);
    await enqueueOrCoalesceSyncJob({
      jobId: 'j2',
      type: 'SAVE_NOTE',
      targetId: noteId,
      payload: edit2,
      clientTimestamp: 2000,
      retryCount: 0,
      status: 'pending',
    });

    const edit3 = createNote(noteId, 'Third draft (Hello World)');
    await saveNoteLocal(edit3);
    await enqueueOrCoalesceSyncJob({
      jobId: 'j3',
      type: 'SAVE_NOTE',
      targetId: noteId,
      payload: edit3,
      clientTimestamp: 3000,
      retryCount: 0,
      status: 'pending',
    });

    // Coalescing should result in exactly 1 pending job in queue
    const pendingCount = await getPendingJobCount();
    expect(pendingCount).toBe(1);

    // Unpause and process queue
    syncEngine.setOffline(false);
    await syncEngine.processQueue();

    expect(await getPendingJobCount()).toBe(0);

    // Verify Drive content contains the latest (third) draft
    const folderInfo = await adapter.discoverOrCreateAppFolders();
    const driveNote = await adapter.getNote(noteId, folderInfo);
    expect(driveNote?.note.content.content[0].text).toBe('Third draft (Hello World)');
  });

  // Test 6: Failed uploads do not report successful remote synchronization
  it('6. Failed uploads do not report successful remote synchronization', async () => {
    const note = createNote('note_fail_test', 'Will Fail');
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'j_fail',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Make adapter fail
    adapter.shouldFailNext = true;
    adapter.failWithStatus = 503;

    let reportedCommitted = false;
    syncEngine.subscribe({
      onStateChange: (state) => {
        if (state === 'COMMITTED_REMOTE') reportedCommitted = true;
      },
      onJobCompleted: () => {},
      onConflictDetected: () => {},
    });

    await syncEngine.processQueue();

    // Must NOT report COMMITTED_REMOTE
    expect(reportedCommitted).toBe(false);
    expect(syncEngine.getState()).not.toBe('COMMITTED_REMOTE');

    // Job must remain in queue for retry
    const pendingCount = await getPendingJobCount();
    expect(pendingCount).toBe(1);
  });

  // Test 7: Empty IndexedDB can hydrate notes from a mocked Google Drive
  it('7. Empty IndexedDB can hydrate notes from a mocked Google Drive', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // Populate Drive with 2 notes and manifest
    const driveNote1 = createNote('remote_n1', 'Remote Note 1 Content');
    const driveNote2 = createNote('remote_n2', 'Remote Note 2 Content');
    const s1 = await adapter.saveNote(driveNote1, folderInfo);
    const s2 = await adapter.saveNote(driveNote2, folderInfo);

    const remoteManifest: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 5,
      notes: {
        'remote_n1': {
          id: 'remote_n1',
          title: driveNote1.title,
          type: 'text',
          attributes: [],
          contentHash: s1.contentHash,
          driveFileId: s1.fileId,
          driveVersion: s1.version,
          updatedAt: driveNote1.updatedAt,
          isDeleted: false,
        },
        'remote_n2': {
          id: 'remote_n2',
          title: driveNote2.title,
          type: 'text',
          attributes: [],
          contentHash: s2.contentHash,
          driveFileId: s2.fileId,
          driveVersion: s2.version,
          updatedAt: driveNote2.updatedAt,
          isDeleted: false,
        },
      },
      branches: [
        { branchId: 'r_n1', noteId: 'remote_n1', parentNoteId: 'root', position: 0 },
        { branchId: 'r_n2', noteId: 'remote_n2', parentNoteId: 'root', position: 1 },
      ],
    };
    await adapter.saveManifest(folderInfo, remoteManifest);

    // Verify local DB is completely empty (clean browser / new device simulation)
    expect((await listNotesLocal()).length).toBe(0);
    expect(await getManifestLocal()).toBeUndefined();

    // Execute hydration
    const hydrateResult = await syncEngine.hydrateAndReconcileFromDrive();
    expect(hydrateResult.importedNotesCount).toBe(2);

    // Verify local IndexedDB now has both notes and the manifest
    const localNotes = await listNotesLocal();
    expect(localNotes.length).toBe(2);
    expect(localNotes.some(n => n.id === 'remote_n1' && n.content.content[0].text === 'Remote Note 1 Content')).toBe(true);
    expect(localNotes.some(n => n.id === 'remote_n2' && n.content.content[0].text === 'Remote Note 2 Content')).toBe(true);

    const localManifest = await getManifestLocal();
    expect(localManifest).toBeDefined();
    expect(localManifest?.notes['remote_n1']).toBeDefined();
    expect(localManifest?.notes['remote_n2']).toBeDefined();
  });

  // Test 8: Existing local and remote notes reconcile correctly
  it('8. Existing local and remote notes reconcile correctly without overwriting', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // Remote has an updated version of note_1 (modified on Device B)
    const remoteNote = createNote('note_shared', 'Device B edit');
    const s1 = await adapter.saveNote(remoteNote, folderInfo);

    const remoteManifest: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 2,
      notes: {
        'note_shared': {
          id: 'note_shared',
          title: remoteNote.title,
          type: 'text',
          attributes: [],
          contentHash: s1.contentHash,
          driveFileId: s1.fileId,
          driveVersion: s1.version,
          updatedAt: remoteNote.updatedAt,
          isDeleted: false,
        },
      },
      branches: [{ branchId: 'b_shared', noteId: 'note_shared', parentNoteId: 'root', position: 0 }],
    };
    await adapter.saveManifest(folderInfo, remoteManifest);

    // Local device has old version in DB, but NO pending offline edits
    const localNote = createNote('note_shared', 'Original text before Device B edit', s1.fileId, 1);
    await saveNoteLocal(localNote);

    // Hydration should update local note with Device B's newer content
    const result = await syncEngine.hydrateAndReconcileFromDrive();
    expect(result.updatedNotesCount).toBe(1);

    const reconciledLocal = await getNoteLocal('note_shared');
    expect(reconciledLocal?.content.content[0].text).toBe('Device B edit');
    expect(reconciledLocal?.baseDriveVersion).toBe(s1.version);
  });

  // Test 9: Conflicting edits preserve both versions
  it('9. Conflicting edits preserve both versions when both local and remote changed', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // Remote was modified
    const remoteNote = createNote('note_conflict', 'Remote edit from Laptop');
    const s1 = await adapter.saveNote(remoteNote, folderInfo);

    const remoteManifest: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 3,
      notes: {
        'note_conflict': {
          id: 'note_conflict',
          title: remoteNote.title,
          type: 'text',
          attributes: [],
          contentHash: s1.contentHash,
          driveFileId: s1.fileId,
          driveVersion: s1.version,
          updatedAt: remoteNote.updatedAt,
          isDeleted: false,
        },
      },
      branches: [],
    };
    await adapter.saveManifest(folderInfo, remoteManifest);

    // Local also had an uncommitted offline edit!
    const localNote = createNote('note_conflict', 'Local edit from Phone', s1.fileId, 1);
    await saveNoteLocal(localNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'j_conflict',
      type: 'SAVE_NOTE',
      targetId: localNote.id,
      payload: localNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Hydration must detect conflict and fork a conflict copy
    const result = await syncEngine.hydrateAndReconcileFromDrive();
    expect(result.conflictNotesCount).toBe(1);

    const allLocalNotes = await listNotesLocal();
    // Must have exactly 2 notes now: original and conflict copy
    expect(allLocalNotes.length).toBe(2);
    const conflictCopy = allLocalNotes.find(n => n.title.includes('Conflict Copy'));
    expect(conflictCopy).toBeDefined();
    expect(conflictCopy?.content.content[0].text).toBe('Local edit from Phone');

    // Original note in IndexedDB must be rebased to the canonical remote note
    const rebasedOriginal = allLocalNotes.find(n => n.id === 'note_conflict');
    expect(rebasedOriginal).toBeDefined();
    expect(rebasedOriginal?.content.content[0].text).toBe('Remote edit from Laptop');
    expect(rebasedOriginal?.baseDriveVersion).toBe(s1.version);

    // Running processQueue right after hydration must process the conflict upload without creating duplicate conflict copies
    await syncEngine.processQueue();
    const notesAfterQueue = await listNotesLocal();
    expect(notesAfterQueue.length).toBe(2);
  });

  // Test 10: Expired or missing authentication is handled without silently switching to mock storage
  it('10. Expired or missing authentication is handled without silently switching to mock storage', async () => {
    // Put sync engine in Drive mode with auth required
    syncEngine.setAuthRequired(true);
    expect(syncEngine.getState()).toBe('AUTH_REQUIRED');

    const note = createNote('note_auth_test', 'Local text during expired auth');
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'j_auth',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Calling processQueue must NOT process jobs against mock storage while auth is required
    await syncEngine.processQueue();

    // The job must still be pending in the queue
    expect(await getPendingJobCount()).toBe(1);
    expect(syncEngine.getState()).toBe('AUTH_REQUIRED');

    // Now user authorizes
    syncEngine.setAuthRequired(false);
    await syncEngine.processQueue();

    // Now it processes and commits
    expect(await getPendingJobCount()).toBe(0);
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');
  });

  // Test 11: Refresh/startup behavior is clearly represented in application state
  it('11. Refresh/startup behavior preserves user storage mode preference', () => {
    // Set storage mode in store
    useAuthStore.getState().setStorageMode('drive');
    expect(useAuthStore.getState().storageMode).toBe('drive');

    // Simulate page reload: storage mode from localStorage is 'drive'
    expect(localStorage.getItem('kurippu_storage_mode')).toBe('drive');

    // Access token is null on reload (not persisted to disk)
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().isDriveAuthorized).toBe(false);

    // Setting user profile persists in localStorage for UI continuity
    useAuthStore.getState().setUser({
      email: 'test@example.com',
      name: 'Test User',
      sub: 'sub_123',
    });
    expect(localStorage.getItem('kurippu_user_profile')).toContain('test@example.com');
  });

  // Test 12: Regression test — Multiple sequential edits to one note from same device do not trigger false conflicts
  it('12. Multiple sequential edits to one note from the same device update the same Drive file without false conflicts', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Initial creation (Edit 1)
    const initialNote: NoteDocument = {
      id: 'note_seq_test',
      schemaVersion: 1,
      title: 'Sync Test',
      type: 'text',
      branches: [{ parentNoteId: 'root', position: 0 }],
      attributes: [],
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Initial edit content' }] },
      plainTextPreview: 'Initial edit content',
      outlinks: [],
      attachmentIds: [],
      contentHash: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_seq_1',
      baseRevisionId: undefined,
      clientTimestamp: Date.now(),
      isDeleted: false,
    };

    await saveNoteLocal(initialNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_seq_1',
      type: 'SAVE_NOTE',
      targetId: initialNote.id,
      payload: initialNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    let localAfter1 = await getNoteLocal('note_seq_test');
    expect(localAfter1?.baseDriveVersion).toBe(1);
    expect(localAfter1?.driveFileId).toBeDefined();

    let remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(1);

    // 2. Sequential Edit 2 on the same device
    const localInDb2 = await getNoteLocal('note_seq_test');
    const edit2: NoteDocument = {
      ...localInDb2!,
      title: 'Sync Test (Updated 2)',
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Second edit content' }] },
      plainTextPreview: 'Second edit content',
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_seq_2',
      baseRevisionId: localInDb2!.revisionId, // Based on rev_seq_1
      baseDriveVersion: localInDb2!.baseDriveVersion,
      clientTimestamp: Date.now(),
    };

    await saveNoteLocal(edit2);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_seq_2',
      type: 'SAVE_NOTE',
      targetId: edit2.id,
      payload: edit2,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    let localAfter2 = await getNoteLocal('note_seq_test');
    expect(localAfter2?.baseDriveVersion).toBe(2);

    remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(1);

    // 3. Sequential Edit 3 on the same device (even with slightly lagged baseDriveVersion simulating client cache lag)
    const localInDb3 = await getNoteLocal('note_seq_test');
    const edit3: NoteDocument = {
      ...localInDb3!,
      title: 'Sync Test (Updated 3)',
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Third edit content' }] },
      plainTextPreview: 'Third edit content',
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_seq_3',
      baseRevisionId: localInDb3!.revisionId, // Based on rev_seq_2
      baseDriveVersion: 1, // Deliberately simulate lagged baseDriveVersion to test lineage protection
      clientTimestamp: Date.now(),
    };

    await saveNoteLocal(edit3);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_seq_3',
      type: 'SAVE_NOTE',
      targetId: edit3.id,
      payload: edit3,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    // 4. Verification: Exactly 1 note in Drive, exactly 1 note in IndexedDB, 0 conflict copies
    remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(1);

    const allLocalNotes = await listNotesLocal();
    expect(allLocalNotes.length).toBe(1);
    expect(allLocalNotes[0].title).toBe('Sync Test (Updated 3)');
    expect(allLocalNotes[0].content.content[0].text).toBe('Third edit content');
    expect(allLocalNotes[0].baseDriveVersion).toBe(3);
    expect(allLocalNotes.some(n => n.title.includes('Conflict Copy'))).toBe(false);
  });

  // Test 13: Keystroke-level editing simulation — baseRevisionId remains stable across multiple rapid keystrokes
  it('13. Rapid sequential keystrokes maintain stable baseRevisionId across coalesced saves without false conflicts', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Version 1 initial note
    const note1 = createNote('note_keystrokes', 'Initial Note');
    await saveNoteLocal(note1);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_k_1',
      type: 'SAVE_NOTE',
      targetId: note1.id,
      payload: note1,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    // 2. Simulate 5 keystrokes for Version 2 before queue processes
    let currentInDb = (await getNoteLocal('note_keystrokes'))!;
    const v1RevisionId = currentInDb.revisionId;

    // Simulate typing: "R", "Re", "Reg", "Regr", "Regression test - Version 2"
    const keystrokeTexts = ['R', 'Re', 'Reg', 'Regr', 'Regression test - Version 2'];
    for (const text of keystrokeTexts) {
      currentInDb = (await getNoteLocal('note_keystrokes'))!;
      const baseRevisionId = currentInDb.baseRevisionId || currentInDb.revisionId;
      expect(baseRevisionId).toBe(v1RevisionId);
      const keystrokeNote: NoteDocument = {
        ...currentInDb,
        content: { type: 'doc', content: [{ type: 'paragraph', text }] },
        plainTextPreview: text,
        updatedAt: new Date().toISOString(),
        revisionId: `rev_k2_${Math.random()}`,
        baseRevisionId, // Stays locked to v1RevisionId!
        clientTimestamp: Date.now(),
      };
      await saveNoteLocal(keystrokeNote);
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_k_2',
        type: 'SAVE_NOTE',
        targetId: keystrokeNote.id,
        payload: keystrokeNote,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
    }

    // Process Version 2 queue
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    // 3. Simulate 5 keystrokes for Version 3
    currentInDb = (await getNoteLocal('note_keystrokes'))!;
    const v2RevisionId = currentInDb.revisionId;
    expect(currentInDb.baseRevisionId).toBeUndefined(); // Committed note has reset draft base

    const keystrokeTextsV3 = ['R', 'Re', 'Reg', 'Regr', 'Regression test - Version 3'];
    for (const text of keystrokeTextsV3) {
      currentInDb = (await getNoteLocal('note_keystrokes'))!;
      const baseRevisionId = currentInDb.baseRevisionId || currentInDb.revisionId;
      expect(baseRevisionId).toBe(v2RevisionId);
      const keystrokeNote: NoteDocument = {
        ...currentInDb,
        content: { type: 'doc', content: [{ type: 'paragraph', text }] },
        plainTextPreview: text,
        updatedAt: new Date().toISOString(),
        revisionId: `rev_k3_${Math.random()}`,
        baseRevisionId, // Stays locked to v2RevisionId!
        clientTimestamp: Date.now(),
      };
      await saveNoteLocal(keystrokeNote);
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_k_3',
        type: 'SAVE_NOTE',
        targetId: keystrokeNote.id,
        payload: keystrokeNote,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
    }

    // Process Version 3 queue
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    // Verification: Zero conflict copies! Exactly 1 file in Drive, exactly 1 file in IndexedDB!
    const remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(1);

    const allLocalNotes = await listNotesLocal();
    expect(allLocalNotes.length).toBe(1);
    expect(allLocalNotes[0].content.content[0].text).toBe('Regression test - Version 3');
    expect(allLocalNotes.some(n => n.title.includes('Conflict Copy'))).toBe(false);
  });

  // Test 14: In-flight save race condition — local edits made while upload is in flight correctly inherit newly committed base
  it('14. Local edits made while an upload is in flight inherit the newly committed base without conflict', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Initial note Version 1
    const note1 = createNote('note_inflight', 'Version 1');
    await saveNoteLocal(note1);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_if_1',
      type: 'SAVE_NOTE',
      targetId: note1.id,
      payload: note1,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();

    // 2. Version 2 queued
    const v1InDb = (await getNoteLocal('note_inflight'))!;
    const note2: NoteDocument = {
      ...v1InDb,
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Version 2' }] },
      plainTextPreview: 'Version 2',
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_v2',
      baseRevisionId: v1InDb.revisionId,
      clientTimestamp: Date.now(),
    };
    await saveNoteLocal(note2);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_if_2',
      type: 'SAVE_NOTE',
      targetId: note2.id,
      payload: note2,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // 3. User types Version 3 in local IndexedDB (simulating edits while network is saving)
    const note3: NoteDocument = {
      ...note2,
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Version 3 (typed fast)' }] },
      plainTextPreview: 'Version 3 (typed fast)',
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_v3',
      baseRevisionId: note2.revisionId, // Based on v2
      clientTimestamp: Date.now(),
    };
    await saveNoteLocal(note3);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_if_3',
      type: 'SAVE_NOTE',
      targetId: note3.id,
      payload: note3,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Process all jobs
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    // Verification: Zero conflicts, latest content committed to Drive
    const remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(1);

    const localFinal = await getNoteLocal('note_inflight');
    expect(localFinal?.content.content[0].text).toBe('Version 3 (typed fast)');
    // Since job 3 was enqueued while job 2 was pending, they coalesced into a single save from v1 -> v2
    expect(localFinal?.baseDriveVersion).toBe(2);

    const allLocalNotes = await listNotesLocal();
    expect(allLocalNotes.length).toBe(1);
    expect(allLocalNotes.some(n => n.title.includes('Conflict Copy'))).toBe(false);
  });

  // Test 15: Single device with remote version divergence (9 > 7) updates cleanly without false conflict copy
  it('15. Single device with remote version divergence (9 > 7) updates cleanly without false conflict copy', async () => {
    setClientDeviceIdForTesting('device_single_user');
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Initial note created on this device
    const initialNote: NoteDocument = {
      ...createNote('note_single_div', 'Single Device Note - Initial'),
      clientDeviceId: 'device_single_user',
    };
    await saveNoteLocal(initialNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_single_1',
      type: 'SAVE_NOTE',
      targetId: initialNote.id,
      payload: initialNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    const remote1 = await adapter.getNote('note_single_div', folderInfo);
    expect(remote1).not.toBeNull();
    const driveFileId = remote1!.note.driveFileId!;

    // 2. Simulate remote version bumping to 9 on Google Drive (e.g. earlier PATCHes from this device)
    // with clientDeviceId still matching device_single_user
    const mockFile = adapter.files.get(driveFileId)!;
    mockFile.version = 9;
    const remoteDoc: NoteDocument = JSON.parse(mockFile.content);
    remoteDoc.clientDeviceId = 'device_single_user';
    mockFile.content = JSON.stringify(remoteDoc);

    // 3. Local note has baseDriveVersion 7 (stale version number), but newer edits on this same device
    const localUpdated: NoteDocument = {
      ...initialNote,
      driveFileId,
      baseDriveVersion: 7, // Stale base version (9 > 7)
      title: 'Single Device Note - Edit 2',
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Sequential edit from same device' }] },
      plainTextPreview: 'Sequential edit from same device',
      revisionId: 'rev_sequential_2',
      baseRevisionId: 'rev_initial',
      updatedAt: new Date().toISOString(),
      clientDeviceId: 'device_single_user',
    };
    await saveNoteLocal(localUpdated);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_single_2',
      type: 'SAVE_NOTE',
      targetId: localUpdated.id,
      payload: localUpdated,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // 4. Process queue: SyncEngine should detect isSameDevice=true, adopt version 9, and cleanly commit
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    // 5. Verification: ZERO conflict copies created
    const allNotes = await listNotesLocal();
    expect(allNotes.length).toBe(1);
    expect(allNotes[0].content.content[0].text).toBe('Sequential edit from same device');
    expect(allNotes.some(n => n.title.includes('Conflict Copy'))).toBe(false);

    // Drive file was cleanly updated in-place
    const remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(1);
    expect(remoteFiles[0].fileId).toBe(driveFileId);
  });

  // Test 16: Multi-device concurrent editing triggers conflict copy and preserves both versions
  it('16. Multi-device concurrent editing triggers conflict copy and preserves both versions', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Note created on Device A
    setClientDeviceIdForTesting('device_AAA');
    const noteDeviceA: NoteDocument = {
      ...createNote('note_concurrent', 'Baseline text from Device A'),
      clientDeviceId: 'device_AAA',
      revisionId: 'rev_base',
    };
    await saveNoteLocal(noteDeviceA);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_multi_1',
      type: 'SAVE_NOTE',
      targetId: noteDeviceA.id,
      payload: noteDeviceA,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();
    expect(syncEngine.getState()).toBe('COMMITTED_REMOTE');

    const remoteBase = (await adapter.getNote('note_concurrent', folderInfo))!;
    const driveFileId = remoteBase.note.driveFileId!;

    // 2. Device B concurrently modifies the note on Drive
    const mockFile = adapter.files.get(driveFileId)!;
    const deviceBDoc: NoteDocument = {
      ...remoteBase.note,
      title: 'Device B Modified Title',
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Device B concurrent content' }] },
      plainTextPreview: 'Device B concurrent content',
      revisionId: 'rev_device_b',
      baseRevisionId: 'rev_base',
      clientDeviceId: 'device_BBB', // Different device!
      updatedAt: new Date().toISOString(),
    };
    mockFile.content = JSON.stringify(deviceBDoc);
    mockFile.version = 5; // Advanced version

    // 3. Device A makes conflicting local edit on the same baseline
    setClientDeviceIdForTesting('device_AAA');
    const localDeviceAEdit: NoteDocument = {
      ...noteDeviceA,
      driveFileId,
      baseDriveVersion: 1, // Device A's base version is 1, while remote is 5
      title: 'Device A Modified Title',
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Device A concurrent content' }] },
      plainTextPreview: 'Device A concurrent content',
      revisionId: 'rev_device_a',
      baseRevisionId: 'rev_base', // Based on rev_base, NOT rev_device_b
      clientDeviceId: 'device_AAA',
      updatedAt: new Date().toISOString(),
    };
    await saveNoteLocal(localDeviceAEdit);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_multi_conflict',
      type: 'SAVE_NOTE',
      targetId: localDeviceAEdit.id,
      payload: localDeviceAEdit,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    let conflictDetected = false;
    syncEngine.subscribe({
      onStateChange: () => {},
      onJobCompleted: () => {},
      onConflictDetected: () => {
        conflictDetected = true;
      },
    });

    // 4. Process queue: SyncEngine MUST detect cross-device conflict (isSameDevice=false)
    await syncEngine.processQueue();
    expect(conflictDetected).toBe(true);

    // 5. Verification: Both versions preserved! Conflict copy forked!
    const allNotes = await listNotesLocal();
    expect(allNotes.length).toBe(2);
    const conflictCopy = allNotes.find(n => n.title.includes('Conflict Copy'));
    expect(conflictCopy).toBeDefined();
    expect(conflictCopy?.content.content[0].text).toBe('Device A concurrent content');
    expect(conflictCopy?.attributes.find(a => a.name === 'conflictOf')?.value).toBe('note_concurrent');

    // Both files exist in Drive
    const remoteFiles = await adapter.listDriveNotes(folderInfo);
    expect(remoteFiles.length).toBe(2);

    // Verification: The original local note received the canonical remote content and baseline
    const localOriginal = allNotes.find(n => n.id === 'note_concurrent');
    expect(localOriginal).toBeDefined();
    expect(localOriginal?.content.content[0].text).toBe('Device B concurrent content');
    expect(localOriginal?.baseDriveVersion).toBe(5);

    // 6. Verification: A subsequent sequential edit on Device A saves cleanly without generating another conflict copy
    const subsequentEdit: NoteDocument = {
      ...localOriginal!,
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Device A subsequent sequential edit' }] },
      plainTextPreview: 'Device A subsequent sequential edit',
      revisionId: 'rev_device_a_subsequent',
      baseRevisionId: localOriginal!.revisionId,
      updatedAt: new Date().toISOString(),
    };
    await saveNoteLocal(subsequentEdit);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_subsequent_edit',
      type: 'SAVE_NOTE',
      targetId: subsequentEdit.id,
      payload: subsequentEdit,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    let secondConflictDetected = false;
    syncEngine.subscribe({
      onStateChange: () => {},
      onJobCompleted: () => {},
      onConflictDetected: () => {
        secondConflictDetected = true;
      },
    });

    await syncEngine.processQueue();
    expect(secondConflictDetected).toBe(false);

    // Verify still exactly 2 notes in Drive and local (no duplicate conflict copy created!)
    const allNotesAfter = await listNotesLocal();
    expect(allNotesAfter.length).toBe(2);
    const remoteFilesAfter = await adapter.listDriveNotes(folderInfo);
    expect(remoteFilesAfter.length).toBe(2);

    // Verify original note in Drive was cleanly updated to Version 6
    const updatedDriveNote = await adapter.getNote('note_concurrent', folderInfo);
    expect(updatedDriveNote?.note.content.content[0].text).toBe('Device A subsequent sequential edit');
    expect(updatedDriveNote?.version).toBe(6);

    // 7. Verification: Repeated processing or retries do not generate duplicate copies of the same conflict
    await syncEngine.processQueue();
    const finalNotes = await listNotesLocal();
    expect(finalNotes.length).toBe(2);
  });

  // Test 17: Multiple manifests (46 files) scenario: selects newest canonical manifest, preserves duplicates, and updates without creating new duplicates
  it('17. Multiple manifests (46 files) scenario: selects newest canonical manifest and updates in-place', async () => {
    // 1. Seed 46 manifest files in MockDriveAdapter
    const rootId = 'mock_folder_root_1001';
    adapter.files.set(rootId, {
      id: rootId,
      name: 'Kurippu Knowledge Base',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'root' },
      trashed: false,
    });

    const notesFolderId = 'mock_folder_notes_1002';
    adapter.files.set(notesFolderId, {
      id: notesFolderId,
      name: 'notes',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'notesFolder' },
      trashed: false,
    });

    // Create 46 manifest files with increasing versions
    const canonicalManifestId = 'manifest_canonical_v46';
    for (let i = 1; i <= 46; i++) {
      const fileId = i === 46 ? canonicalManifestId : `manifest_historical_${i}`;
      const dummyManifest: ApplicationManifest = {
        schemaVersion: 1,
        workspaceId: 'default',
        rootNoteId: 'root',
        lastModified: new Date(Date.now() - (46 - i) * 1000).toISOString(),
        revisionSequence: i,
        notes: {},
        branches: [],
      };
      adapter.files.set(fileId, {
        id: fileId,
        name: 'kurippu_manifest.json',
        mimeType: 'application/json',
        parents: [rootId],
        content: JSON.stringify(dummyManifest),
        version: i,
        appProperties: { kurippuApp: 'true', kurippuRole: 'manifest' },
        trashed: false,
      });
    }

    // Total manifests before discovery
    const manifestsBefore = Array.from(adapter.files.values()).filter(
      f => f.appProperties['kurippuRole'] === 'manifest'
    );
    expect(manifestsBefore.length).toBe(46);

    // 2. Discover folders: Must select highest version manifest as canonical
    const folderInfo = await adapter.discoverOrCreateAppFolders();
    expect(folderInfo.manifestFileId).toBe(canonicalManifestId);
    expect(folderInfo.duplicateManifestFileIds?.length).toBe(45);

    // 3. Save a note through the sync engine, which triggers manifest update
    const note = createNote('note_manifest_test', 'Testing manifest update');
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_manifest_test',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();

    // 4. Verification: Total manifests remains exactly 46 (updated in-place, zero new duplicate files created)
    const manifestsAfter = Array.from(adapter.files.values()).filter(
      f => f.appProperties['kurippuRole'] === 'manifest'
    );
    expect(manifestsAfter.length).toBe(46);

    // Canonical manifest contains the note
    const canonicalFile = adapter.files.get(canonicalManifestId)!;
    const canonicalParsed: ApplicationManifest = JSON.parse(canonicalFile.content);
    expect(canonicalParsed.notes['note_manifest_test']).toBeDefined();
    expect(canonicalParsed.duplicateManifestFileIds?.length).toBe(45);
  });

  // Test 18: Repeated initialization, page refresh, and hydration cycles reuse the canonical manifest and never increase the manifest count
  it('18. Repeated initialization, page refresh, and hydration cycles reuse the canonical manifest and never increase the manifest count', async () => {
    // 1. Setup adapter with 46 existing manifests
    const rootId = 'mock_folder_root_18';
    adapter.files.set(rootId, {
      id: rootId,
      name: 'Kurippu Knowledge Base',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'root' },
      trashed: false,
    });

    const notesFolderId = 'mock_folder_notes_18';
    adapter.files.set(notesFolderId, {
      id: notesFolderId,
      name: 'notes',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'notesFolder' },
      trashed: false,
    });

    const canonicalManifestId = 'manifest_canonical_18';
    for (let i = 1; i <= 46; i++) {
      const fileId = i === 46 ? canonicalManifestId : `manifest_hist_18_${i}`;
      const dummyManifest: ApplicationManifest = {
        schemaVersion: 1,
        workspaceId: 'default',
        rootNoteId: 'root',
        lastModified: new Date(Date.now() - (46 - i) * 1000).toISOString(),
        revisionSequence: i,
        notes: {},
        branches: [],
      };
      adapter.files.set(fileId, {
        id: fileId,
        name: 'manifest.json',
        mimeType: 'application/json',
        parents: [rootId],
        content: JSON.stringify(dummyManifest),
        version: i,
        appProperties: { kurippuApp: 'true', kurippuRole: 'manifest' },
        trashed: false,
      });
    }

    const countBefore = Array.from(adapter.files.values()).filter(
      f => f.appProperties['kurippuRole'] === 'manifest'
    ).length;
    expect(countBefore).toBe(46);

    // 2. Simulate 5 consecutive app refresh / re-authorization cycles
    for (let cycle = 1; cycle <= 5; cycle++) {
      // Each cycle represents a fresh browser load (new SyncEngine instance)
      const freshEngine = new SyncEngine(adapter);

      // Initialization discovers folders
      const folders = await freshEngine.initializeFolders();
      expect(folders.manifestFileId).toBe(canonicalManifestId);
      expect(folders.duplicateManifestFileIds?.length).toBe(45);

      // Hydration runs (as happens on authorization / startup)
      const hydrationRes = await freshEngine.hydrateAndReconcileFromDrive();
      expect(hydrationRes).toBeDefined();

      // Create a note and sync it in this cycle
      const cycleNote = createNote(`note_cycle_${cycle}`, `Cycle ${cycle} Note Content`);
      await saveNoteLocal(cycleNote);
      await enqueueOrCoalesceSyncJob({
        jobId: `job_cycle_${cycle}`,
        type: 'SAVE_NOTE',
        targetId: cycleNote.id,
        payload: cycleNote,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      await freshEngine.processQueue();
      expect(freshEngine.getState()).toBe('COMMITTED_REMOTE');

      // Verify manifest count after each cycle remains strictly 46
      const countDuring = Array.from(adapter.files.values()).filter(
        f => f.appProperties['kurippuRole'] === 'manifest'
      ).length;
      expect(countDuring).toBe(46);
    }

    // 3. Final verification: Total manifests is still exactly 46
    const countAfter = Array.from(adapter.files.values()).filter(
      f => f.appProperties['kurippuRole'] === 'manifest'
    ).length;
    expect(countAfter).toBe(46);

    // Canonical manifest was updated with all 5 notes
    const canonicalFile = adapter.files.get(canonicalManifestId)!;
    const finalManifest: ApplicationManifest = JSON.parse(canonicalFile.content);
    for (let cycle = 1; cycle <= 5; cycle++) {
      expect(finalManifest.notes[`note_cycle_${cycle}`]).toBeDefined();
    }
    // All 45 historical duplicates remain intact and unmodified
    expect(finalManifest.duplicateManifestFileIds?.length).toBe(45);
  });

  // Test 19: Defensive saveManifest auto-discovers canonical manifest when manifestFileId is missing
  it('19. Defensive saveManifest auto-discovers canonical manifest when manifestFileId is missing', async () => {
    const rootId = 'mock_folder_root_19';
    adapter.files.set(rootId, {
      id: rootId,
      name: 'Kurippu Knowledge Base',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'root' },
      trashed: false,
    });

    const notesFolderId = 'mock_folder_notes_19';
    adapter.files.set(notesFolderId, {
      id: notesFolderId,
      name: 'notes',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'notesFolder' },
      trashed: false,
    });

    const canonicalManifestId = 'manifest_canonical_19';
    for (let i = 1; i <= 46; i++) {
      const fileId = i === 46 ? canonicalManifestId : `manifest_hist_19_${i}`;
      adapter.files.set(fileId, {
        id: fileId,
        name: 'manifest.json',
        mimeType: 'application/json',
        parents: [rootId],
        content: JSON.stringify({
          schemaVersion: 1,
          workspaceId: 'default',
          rootNoteId: 'root',
          lastModified: new Date().toISOString(),
          revisionSequence: i,
          notes: {},
          branches: [],
        }),
        version: i,
        appProperties: { kurippuApp: 'true', kurippuRole: 'manifest' },
        trashed: false,
      });
    }

    // Call saveManifest with intentionally undefined manifestFileId
    const corruptedFolderInfo = {
      rootFolderId: rootId,
      notesFolderId,
      manifestFileId: undefined, // Missing!
    };

    const dummyManifest: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 99,
      notes: {},
      branches: [],
    };

    const res = await adapter.saveManifest(corruptedFolderInfo, dummyManifest);

    // It must have reused the canonical manifest ID and NOT created a 47th file
    expect(res.fileId).toBe(canonicalManifestId);
    expect(corruptedFolderInfo.manifestFileId).toBe(canonicalManifestId);

    const totalManifests = Array.from(adapter.files.values()).filter(
      f => f.appProperties['kurippuRole'] === 'manifest'
    ).length;
    expect(totalManifests).toBe(46);
  });

  it('strictly rejects listDriveNotes when notesFolderId is empty or uninitialized', async () => {
    const adapter = new MockDriveAdapter();
    const badFolderInfo: DriveFolderInfo = {
      rootFolderId: 'root_123',
      notesFolderId: '', // Empty!
    };

    await expect(adapter.listDriveNotes(badFolderInfo)).rejects.toThrow(
      'Cannot list Drive notes: notesFolderId is missing or uninitialized.'
    );

    const whitespaceFolderInfo: DriveFolderInfo = {
      rootFolderId: 'root_123',
      notesFolderId: '   ',
    };

    await expect(adapter.listDriveNotes(whitespaceFolderInfo)).rejects.toThrow(
      'Cannot list Drive notes: notesFolderId is missing or uninitialized.'
    );
  });

  it('shares a single in-flight promise lock during concurrent initializeFolders calls', async () => {
    const adapter = new MockDriveAdapter();
    const spy = vi.spyOn(adapter, 'discoverOrCreateAppFolders');
    const syncEngine = new SyncEngine(adapter);

    // Call initializeFolders concurrently 3 times
    const [folders1, folders2, folders3] = await Promise.all([
      syncEngine.initializeFolders(),
      syncEngine.initializeFolders(),
      syncEngine.initializeFolders(),
    ]);

    expect(folders1).toBe(folders2);
    expect(folders2).toBe(folders3);
    // discoverOrCreateAppFolders must have been invoked exactly once!
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not reset folderInfo when setAdapter is called with the same adapter instance', async () => {
    const adapter = new MockDriveAdapter();
    const syncEngine = new SyncEngine(adapter);

    const folders = await syncEngine.initializeFolders();
    expect(folders).toBeDefined();

    // Re-setting the exact same adapter instance (as happens during React render cycles)
    syncEngine.setAdapter(adapter);

    // The cached folderInfo must be preserved
    const foldersAfter = await syncEngine.initializeFolders();
    expect(foldersAfter).toBe(folders);
  });

  it('hydrates notes and reuses canonical manifest on a fresh browser profile without creating duplicates', async () => {
    const adapter = new MockDriveAdapter();
    const rootId = 'mock_existing_root_profile1';
    const notesFolderId = 'mock_existing_notes_profile1';
    const canonicalManifestId = 'mock_canonical_manifest_profile1';

    // Seed existing Drive persistence structure from Profile 1
    adapter.files.set(rootId, {
      id: rootId,
      name: 'Kurippu Knowledge Base',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'root' },
      trashed: false,
    });

    adapter.files.set(notesFolderId, {
      id: notesFolderId,
      name: 'notes',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
      content: '',
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'notesFolder' },
      trashed: false,
    });

    const existingNoteId = 'profile1_shared_note_1';
    const existingNote: NoteDocument = {
      id: existingNoteId,
      schemaVersion: 1,
      title: 'Shared Note From Profile 1',
      type: 'text',
      branches: [{ parentNoteId: 'root', position: 0 }],
      attributes: [],
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Cross-device sync content' }] },
      plainTextPreview: 'Cross-device sync content',
      outlinks: [],
      attachmentIds: [],
      contentHash: 'hash_profile1_note',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_profile1_note',
      clientTimestamp: Date.now(),
      clientDeviceId: 'profile1_device',
      driveFileId: 'drive_file_p1_note',
      isDeleted: false,
    };

    adapter.files.set('drive_file_p1_note', {
      id: 'drive_file_p1_note',
      name: `${existingNoteId}.json`,
      mimeType: 'application/json',
      parents: [notesFolderId],
      content: JSON.stringify(existingNote),
      version: 1,
      appProperties: { kurippuApp: 'true', kurippuRole: 'note', kurippuNoteId: existingNoteId },
      trashed: false,
    });

    const existingManifest: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 10,
      notes: {
        [existingNoteId]: {
          id: existingNoteId,
          title: existingNote.title,
          type: existingNote.type,
          attributes: [],
          contentHash: existingNote.contentHash,
          driveFileId: 'drive_file_p1_note',
          driveVersion: 1,
          updatedAt: existingNote.updatedAt,
          isDeleted: false,
        },
      },
      branches: [{ branchId: 'b1', noteId: existingNoteId, parentNoteId: 'root', position: 0 }],
    };

    adapter.files.set(canonicalManifestId, {
      id: canonicalManifestId,
      name: 'manifest.json',
      mimeType: 'application/json',
      parents: [rootId],
      content: JSON.stringify(existingManifest),
      version: 10,
      appProperties: { kurippuApp: 'true', kurippuRole: 'manifest' },
      trashed: false,
    });

    // Fresh browser profile: completely empty IndexedDB and fresh SyncEngine
    setActiveAccount('fresh_profile_account');
    await clearLocalDatabase();
    const freshEngine = new SyncEngine(adapter, 'fresh_profile_account');

    const result = await freshEngine.hydrateAndReconcileFromDrive();

    expect(result.importedNotesCount).toBe(1);
    expect(result.updatedNotesCount).toBe(0);
    expect(result.conflictNotesCount).toBe(0);

    // Verify local IndexedDB now has the imported note
    const localNote = await getNoteLocal(existingNoteId);
    expect(localNote).toBeDefined();
    expect(localNote?.title).toBe('Shared Note From Profile 1');
    expect(localNote?.driveFileId).toBe('drive_file_p1_note');

    // Verify local manifest matches remote
    const localManifest = await getManifestLocal();
    expect(localManifest).toBeDefined();
    expect(localManifest?.notes[existingNoteId]).toBeDefined();

    // Verify zero new manifest or folder files were created in Drive
    const totalManifests = Array.from(adapter.files.values()).filter(
      f => f.appProperties['kurippuRole'] === 'manifest' || f.name === 'manifest.json'
    ).length;
    expect(totalManifests).toBe(1);

    const totalFolders = Array.from(adapter.files.values()).filter(
      f => f.mimeType === 'application/vnd.google-apps.folder'
    ).length;
    expect(totalFolders).toBe(2); // 1 root + 1 notes
  });

  // Test 17: Remote update from Device B is discovered by Device A's reconciliation cycle
  it('17. Remote update from Device B is discovered by Device A reconciliation cycle', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Device A creates and saves Note 1
    setClientDeviceIdForTesting('device_AAA');
    const noteA = createNote('note_auto_discover_1', 'Original Content from Device A');
    noteA.contentHash = await computeContentHash(noteA.content);
    noteA.clientDeviceId = 'device_AAA';
    await saveNoteLocal(noteA);

    await enqueueOrCoalesceSyncJob({
      jobId: 'job_dev_a_init',
      type: 'SAVE_NOTE',
      targetId: noteA.id,
      payload: noteA,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();

    // Verify initial save in IndexedDB and Drive
    const savedLocalA = await getNoteLocal(noteA.id);
    expect(savedLocalA?.baseDriveVersion).toBe(1);
    expect(savedLocalA?.driveFileId).toBeDefined();

    // 2. Device B sequentially edits the note on Google Drive
    const driveFileId = savedLocalA!.driveFileId!;
    const fileOnDrive = adapter.files.get(driveFileId)!;
    expect(fileOnDrive).toBeDefined();

    const updatedContent = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', text: 'Edited on Device B - Sequential Save After Conflict' }],
    };
    const updatedHash = await computeContentHash(updatedContent);
    const docB: NoteDocument = {
      ...JSON.parse(fileOnDrive.content),
      title: 'Note 1 (Updated by Device B)',
      content: updatedContent,
      plainTextPreview: 'Edited on Device B - Sequential Save After Conflict',
      contentHash: updatedHash,
      clientDeviceId: 'device_BBB',
      updatedAt: new Date().toISOString(),
      revisionId: 'rev_device_b_seq_2',
      baseRevisionId: savedLocalA?.revisionId,
    };

    fileOnDrive.content = JSON.stringify(docB);
    fileOnDrive.version = 2;

    // Update remote manifest to reflect Device B's save
    const remoteManifestData = await adapter.getManifest(folderInfo);
    const remoteManifest = remoteManifestData!.manifest;
    remoteManifest.notes[noteA.id] = {
      ...remoteManifest.notes[noteA.id],
      title: docB.title,
      contentHash: updatedHash,
      driveVersion: 2,
      updatedAt: docB.updatedAt,
    };
    await adapter.saveManifest(folderInfo, remoteManifest);

    // 3. Device A runs hydration / auto-poll reconciliation
    setClientDeviceIdForTesting('device_AAA');
    const result = await syncEngine.hydrateAndReconcileFromDrive();

    expect(result.importedNotesCount).toBe(0);
    expect(result.updatedNotesCount).toBe(1);
    expect(result.conflictNotesCount).toBe(0);

    // Verify Device A's IndexedDB now has Device B's sequential edit
    const refreshedNoteA = await getNoteLocal(noteA.id);
    expect(refreshedNoteA).toBeDefined();
    expect(refreshedNoteA?.title).toBe('Note 1 (Updated by Device B)');
    expect(refreshedNoteA?.contentHash).toBe(updatedHash);
    expect(refreshedNoteA?.baseDriveVersion).toBe(2);
    expect(refreshedNoteA?.plainTextPreview).toBe('Edited on Device B - Sequential Save After Conflict');
  });

  // Test 18: UI refreshes after a successfully imported remote update
  it('18. UI refreshes active note after a successfully imported remote update', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    const note = createNote('note_ui_refresh_1', 'Initial Text');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_ui_1',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();

    const localNote = await getNoteLocal(note.id);
    let activeNote = localNote;
    expect(activeNote?.plainTextPreview).toBe('Initial Text');

    // Remote device updates the file on Drive
    const driveFile = adapter.files.get(localNote!.driveFileId!)!;
    const remoteNewText = 'Remote content received via background poll';
    const remoteContent = { type: 'doc' as const, content: [{ type: 'paragraph', text: remoteNewText }] };
    const remoteHash = await computeContentHash(remoteContent);
    const remoteDoc: NoteDocument = {
      ...JSON.parse(driveFile.content),
      content: remoteContent,
      plainTextPreview: remoteNewText,
      contentHash: remoteHash,
      updatedAt: new Date().toISOString(),
    };
    driveFile.content = JSON.stringify(remoteDoc);
    driveFile.version = 2;

    const manifestData = await adapter.getManifest(folderInfo);
    const manifest = manifestData!.manifest;
    manifest.notes[note.id].contentHash = remoteHash;
    manifest.notes[note.id].driveVersion = 2;
    await adapter.saveManifest(folderInfo, manifest);

    // Background poll runs with refresh callback
    let uiRefreshed = false;
    const result = await syncEngine.hydrateAndReconcileFromDrive();
    if (result.updatedNotesCount > 0) {
      const updated = await getNoteLocal(activeNote!.id);
      if (updated) {
        activeNote = updated;
        uiRefreshed = true;
      }
    }

    expect(uiRefreshed).toBe(true);
    expect(activeNote?.plainTextPreview).toBe('Remote content received via background poll');
    expect(activeNote?.contentHash).toBe(remoteHash);
  });

  // Test 19: Local pending edits are preserved when a remote change is discovered
  it('19. Local pending edits are preserved when a remote change is discovered', async () => {
    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // 1. Initial shared note
    const note = createNote('note_preserve_pending_1', 'Base Content');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_init',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();
    const baseLocal = await getNoteLocal(note.id);

    // 2. Local device edits note while offline or un-synced (has pending job)
    const localContent = { type: 'doc' as const, content: [{ type: 'paragraph', text: 'Local Pending Unsaved Work' }] };
    const localEditedNote: NoteDocument = {
      ...baseLocal!,
      content: localContent,
      plainTextPreview: 'Local Pending Unsaved Work',
      contentHash: await computeContentHash(localContent),
      revisionId: 'rev_local_pending_new',
      clientDeviceId: 'device_AAA',
    };
    await saveNoteLocal(localEditedNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_pending_edit',
      type: 'SAVE_NOTE',
      targetId: localEditedNote.id,
      payload: localEditedNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // 3. Remote device edited note on Drive concurrently
    const driveFile = adapter.files.get(baseLocal!.driveFileId!)!;
    const remoteContent = { type: 'doc' as const, content: [{ type: 'paragraph', text: 'Remote Concurrent Change' }] };
    const remoteHash = await computeContentHash(remoteContent);
    const remoteDoc: NoteDocument = {
      ...JSON.parse(driveFile.content),
      content: remoteContent,
      plainTextPreview: 'Remote Concurrent Change',
      contentHash: remoteHash,
      clientDeviceId: 'device_BBB',
      revisionId: 'rev_remote_concurrent',
    };
    driveFile.content = JSON.stringify(remoteDoc);
    driveFile.version = 3;

    const manifestData = await adapter.getManifest(folderInfo);
    const manifest = manifestData!.manifest;
    manifest.notes[note.id].contentHash = remoteHash;
    manifest.notes[note.id].driveVersion = 3;
    await adapter.saveManifest(folderInfo, manifest);

    // 4. Reconciliation runs while local has pending job
    const result = await syncEngine.hydrateAndReconcileFromDrive();

    // Must detect conflict, preserve local version as conflict copy, and NOT overwrite local unsaved edits
    expect(result.conflictNotesCount).toBe(1);

    const allLocalNotes = await listNotesLocal();
    expect(allLocalNotes.length).toBe(2);

    const conflictNote = allLocalNotes.find(n => n.id !== note.id && n.title.includes('Conflict Copy'));
    expect(conflictNote).toBeDefined();
    expect(conflictNote?.plainTextPreview).toBe('Local Pending Unsaved Work');
    expect(conflictNote?.attributes.some(a => a.name === 'conflictOf' && a.value === note.id)).toBe(true);

    const originalNote = allLocalNotes.find(n => n.id === note.id);
    expect(originalNote?.plainTextPreview).toBe('Remote Concurrent Change');
    expect(originalNote?.baseDriveVersion).toBe(3);
  });

  // Test 20: Concurrent hydration/polling calls do not overlap or create duplicate conflicts
  it('20. Concurrent hydration/polling calls do not overlap or create duplicate conflicts', async () => {
    await adapter.discoverOrCreateAppFolders();

    const note = createNote('note_concurrent_calls', 'Shared Note');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_cc_init',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();

    // Call hydrateAndReconcileFromDrive concurrently 3 times
    const [res1, res2, res3] = await Promise.all([
      syncEngine.hydrateAndReconcileFromDrive(),
      syncEngine.hydrateAndReconcileFromDrive(),
      syncEngine.hydrateAndReconcileFromDrive(),
    ]);

    // All three calls should resolve to the exact same promise result
    expect(res1).toBe(res2);
    expect(res2).toBe(res3);
    expect(res1.conflictNotesCount).toBe(0);

    const allNotes = await listNotesLocal();
    expect(allNotes.length).toBe(1);
  });

  // Test 21: Auto-polling triggers at configured interval and stops when authorization or Drive storage is no longer active
  it('21. Auto-polling triggers at configured interval and stops when authorization is inactive', async () => {
    vi.useFakeTimers();
    try {
      await adapter.discoverOrCreateAppFolders();
      let pollCount = 0;
      const onPoll = vi.fn(() => {
        pollCount++;
      });

      const mockReconcile = vi.fn(async () => ({ importedNotesCount: 0, updatedNotesCount: 0, conflictNotesCount: 0 }));
      syncEngine.hydrateAndReconcileFromDrive = mockReconcile;

      // Start auto poll with 30s interval
      syncEngine.startAutoPoll(30000, onPoll);
      expect(syncEngine.isAutoPollingActive()).toBe(true);

      // Advance by 30 seconds
      await vi.advanceTimersByTimeAsync(30000);
      expect(pollCount).toBe(1);

      // Advance by another 30 seconds
      await vi.advanceTimersByTimeAsync(30000);
      expect(pollCount).toBe(2);

      // Stop auto poll
      syncEngine.stopAutoPoll();
      expect(syncEngine.isAutoPollingActive()).toBe(false);

      // Advance by 60 seconds -> pollCount should not increase
      await vi.advanceTimersByTimeAsync(60000);
      expect(pollCount).toBe(2);

      // If auth is required, polling skips even if started
      syncEngine.setAuthRequired(true);
      syncEngine.startAutoPoll(30000, onPoll);
      await vi.advanceTimersByTimeAsync(30000);
      expect(pollCount).toBe(2); // Skipped because auth is required

      syncEngine.stopAutoPoll();
    } finally {
      vi.useRealTimers();
    }
  });

  // Test 22: Focus and visibility events trigger debounced reconciliation at most once within debounce window
  it('22. Focus and visibility events trigger debounced reconciliation at most once within debounce window', async () => {
    vi.useFakeTimers();
    try {
      await adapter.discoverOrCreateAppFolders();

      let reconcileExecutions = 0;
      const mockReconcile = vi.fn(async () => {
        reconcileExecutions++;
        (syncEngine as any).lastReconcileTime = Date.now();
        return { importedNotesCount: 0, updatedNotesCount: 0, conflictNotesCount: 0 };
      });
      syncEngine.hydrateAndReconcileFromDrive = mockReconcile;

      // Simulate App.tsx debounced focus/visibility logic
      let focusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      const triggerFocusOrVisibility = () => {
        if (focusDebounceTimer) clearTimeout(focusDebounceTimer);
        focusDebounceTimer = setTimeout(async () => {
          const timeSinceLastReconcile = Date.now() - syncEngine.getLastReconcileTime();
          if (timeSinceLastReconcile < 10000) return;
          await syncEngine.hydrateAndReconcileFromDrive();
        }, 1000);
      };

      // Fire 3 events in rapid succession within 300ms
      triggerFocusOrVisibility();
      await vi.advanceTimersByTimeAsync(100);
      triggerFocusOrVisibility();
      await vi.advanceTimersByTimeAsync(100);
      triggerFocusOrVisibility();

      // Before 1000ms debounce expires, no execution
      expect(reconcileExecutions).toBe(0);

      // Advance past 1000ms debounce
      await vi.advanceTimersByTimeAsync(1000);
      expect(reconcileExecutions).toBe(1);

      // Fire focus event again within 10s cooldown window (e.g. at 2 seconds)
      triggerFocusOrVisibility();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reconcileExecutions).toBe(1); // Skipped due to 10s cooldown!

      // Advance past 10s cooldown window
      await vi.advanceTimersByTimeAsync(10000);
      triggerFocusOrVisibility();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reconcileExecutions).toBe(2); // Executed after cooldown
    } finally {
      vi.useRealTimers();
    }
  });

  // Test 23: Complete cache and sync queue isolation between two Google accounts
  it('23. Complete cache and sync queue isolation between two Google accounts', async () => {
    // 1. Account Alice logs in
    setActiveAccount('perm_alice');
    await clearLocalDatabase();
    const aliceNote = createNote('note_alice_private', 'Alice Confidential Thoughts');
    aliceNote.contentHash = await computeContentHash(aliceNote.content);
    await saveNoteLocal(aliceNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_alice_1',
      type: 'SAVE_NOTE',
      targetId: aliceNote.id,
      payload: aliceNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Verify Alice has 1 note and 1 pending job
    expect((await listNotesLocal()).length).toBe(1);
    expect((await getAllQueueJobs()).length).toBe(1);

    // 2. Disconnect Alice and Account Bob logs in
    setActiveAccount('perm_bob');
    await clearLocalDatabase();

    // Verify Bob's partition is completely empty
    expect((await listNotesLocal()).length).toBe(0);
    expect((await getAllQueueJobs()).length).toBe(0);

    // Bob creates his own note
    const bobNote = createNote('note_bob_work', 'Bob Work Task');
    bobNote.contentHash = await computeContentHash(bobNote.content);
    await saveNoteLocal(bobNote);
    expect((await listNotesLocal()).length).toBe(1);
    expect((await getNoteLocal('note_alice_private'))).toBeUndefined();

    // 3. Switch back to Alice
    setActiveAccount('perm_alice');
    const aliceNotesAfter = await listNotesLocal();
    expect(aliceNotesAfter.length).toBe(1);
    expect(aliceNotesAfter[0].id).toBe('note_alice_private');
    expect((await getNoteLocal('note_bob_work'))).toBeUndefined();
    expect((await getAllQueueJobs()).length).toBe(1);
  });

  // Test 24: Zero cross-account data upload to Google Drive
  it('24. Zero cross-account data upload to Google Drive', async () => {
    // Alice creates a private note in her partition
    setActiveAccount('perm_alice');
    await clearLocalDatabase();
    const aliceNote = createNote('note_alice_secret', 'Alice Secret Note');
    aliceNote.contentHash = await computeContentHash(aliceNote.content);
    await saveNoteLocal(aliceNote);

    // Bob signs in with a separate Mock Drive Adapter
    setActiveAccount('perm_bob');
    await clearLocalDatabase();
    const bobAdapter = new MockDriveAdapter();
    const bobEngine = new SyncEngine(bobAdapter, 'perm_bob');

    // Bob syncs and processes queue
    await bobEngine.hydrateAndReconcileFromDrive();
    await bobEngine.processQueue();

    // Verify Bob's Drive contains zero note files and Bob's manifest has zero notes
    const bobNoteFiles = Array.from(bobAdapter.files.values()).filter(
      f => !f.trashed && f.appProperties?.['kurippuRole'] === 'note'
    );
    expect(bobNoteFiles.length).toBe(0);

    const bobManifest = Array.from(bobAdapter.files.values()).find(
      f => !f.trashed && f.appProperties?.['kurippuRole'] === 'manifest'
    );
    if (bobManifest) {
      const parsed = JSON.parse(bobManifest.content);
      expect(Object.keys(parsed.notes || {}).length).toBe(0);
    }

    const bobLocalNotes = await listNotesLocal();
    expect(bobLocalNotes.length).toBe(0);
  });

  // Test 25: Unassigned legacy database protection and non-destructive inspection
  it('25. Unassigned legacy database protection and non-destructive inspection', async () => {
    const testLegacyDbName = `kurippu_test_legacy_25_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    let verifyLegacyDb: any = null;
    try {
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const legacyNote = createNote('note_legacy_1', 'Legacy Offline Work');
      await legacyDb.put('notes', legacyNote);
      await legacyDb.add('sync_queue', {
        jobId: 'job_legacy_offline',
        type: 'SAVE_NOTE',
        targetId: 'note_legacy_1',
        payload: legacyNote,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      legacyDb.close();

      // User Alice logs in with an isolated partition
      setActiveAccount('perm_alice_new');
      await clearLocalDatabase();

      // Inspect legacy cache: returns summary without altering database
      const summary = await inspectLegacyCache();
      expect(summary.exists).toBe(true);
      expect(summary.notesCount).toBe(1);
      expect(summary.pendingJobsCount).toBe(1);
      expect(summary.noteTitles).toContain('Note note_legacy_1');

      // Alice's active account does NOT automatically inherit legacy data
      expect((await listNotesLocal()).length).toBe(0);
      expect((await getAllQueueJobs()).length).toBe(0);

      // Alice performs a sync cycle: legacy notes are NOT uploaded to Alice's Drive
      const aliceAdapter = new MockDriveAdapter();
      const aliceEngine = new SyncEngine(aliceAdapter, 'perm_alice_new');
      await aliceEngine.hydrateAndReconcileFromDrive();
      await aliceEngine.processQueue();

      const aliceNoteFiles = Array.from(aliceAdapter.files.values()).filter(
        f => !f.trashed && f.appProperties?.['kurippuRole'] === 'note'
      );
      expect(aliceNoteFiles.length).toBe(0);

      const aliceManifest = Array.from(aliceAdapter.files.values()).find(
        f => !f.trashed && f.appProperties?.['kurippuRole'] === 'manifest'
      );
      if (aliceManifest) {
        const parsed = JSON.parse(aliceManifest.content);
        expect(Object.keys(parsed.notes || {}).length).toBe(0);
      }

      // Legacy database remains untouched and intact
      verifyLegacyDb = await openDB(testLegacyDbName, 1);
      expect((await verifyLegacyDb.getAll('notes')).length).toBe(1);
      expect((await verifyLegacyDb.getAll('sync_queue')).length).toBe(1);
      verifyLegacyDb.close();
      verifyLegacyDb = null;
    } finally {
      if (verifyLegacyDb) {
        try { verifyLegacyDb.close(); } catch {}
      }
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 26: User-approved explicit legacy cache migration preserves all jobs and data
  it('26. User-approved explicit legacy cache migration preserves all jobs and data', async () => {
    const testLegacyDbName = `kurippu_test_legacy_26_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    let verifyLegacyDb: any = null;
    try {
      // Seed isolated legacy cache fixture for migration
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const legacyNote = createNote('note_legacy_1', 'Legacy Offline Work');
      await legacyDb.put('notes', legacyNote);
      await legacyDb.add('sync_queue', {
        jobId: 'job_legacy_offline',
        type: 'SAVE_NOTE',
        targetId: 'note_legacy_1',
        payload: legacyNote,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      legacyDb.close();

      setActiveAccount('perm_alice_approved');
      await clearLocalDatabase();

      // User explicitly approves migration into Alice's account
      const res = await importLegacyCacheToActiveAccount('perm_alice_approved');
      expect(res.importedNotesCount).toBe(1);
      expect(res.importedJobsCount).toBe(1);

      // Alice's partition now contains the imported note and pending job
      const aliceNotes = await listNotesLocal();
      expect(aliceNotes.length).toBe(1);
      expect(aliceNotes[0].id).toBe('note_legacy_1');

      const aliceJobs = await getAllQueueJobs();
      expect(aliceJobs.length).toBe(1);
      expect(aliceJobs[0].targetId).toBe('note_legacy_1');

      // Legacy database was NOT destroyed
      verifyLegacyDb = await openDB(testLegacyDbName, 1);
      expect((await verifyLegacyDb.getAll('notes')).length).toBe(1);
      verifyLegacyDb.close();
      verifyLegacyDb = null;
    } finally {
      if (verifyLegacyDb) {
        try { verifyLegacyDb.close(); } catch {}
      }
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 27: Database access rejected when no account partition is active
  it('27. Database access rejected when no account partition is active', async () => {
    setActiveAccount(null);
    await expect(listNotesLocal()).rejects.toThrow('IndexedDB access denied');
    await expect(saveNoteLocal(createNote('n1', 'text'))).rejects.toThrow('IndexedDB access denied');
  });

  function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Test 28: Requirement 1 - Account switch during a delayed Drive read
  it('28. Account switch during a delayed Drive read aborts without cross-writing to new account partition', async () => {
    setActiveAccount('perm_alice');
    await clearLocalDatabase();
    const aliceAdapter = new MockDriveAdapter('perm_alice', 'token_alice');
    const folderInfo = await aliceAdapter.discoverOrCreateAppFolders();

    // Alice has a remote note on Drive
    const aliceRemoteNote = createNote('note_alice_read', 'Alice Remote Content');
    aliceRemoteNote.contentHash = await computeContentHash(aliceRemoteNote.content);
    await aliceAdapter.saveNote(aliceRemoteNote, folderInfo);

    const aliceEngine = new SyncEngine(aliceAdapter, 'perm_alice');

    // Intercept Drive read with a deferred promise
    const deferred = createDeferred();
    aliceAdapter.onBeforeGetNote = () => deferred.promise;

    // Start hydration for Alice
    const aliceHydratePromise = aliceEngine.hydrateAndReconcileFromDrive();

    // While Alice's Drive read is in flight, user switches to Bob!
    setActiveAccount('perm_bob');
    await clearLocalDatabase();
    const bobAdapter = new MockDriveAdapter('perm_bob', 'token_bob');
    expect(bobAdapter.accountId).toBe('perm_bob');
    const bobEngine = new SyncEngine(bobAdapter, 'perm_bob');
    expect(bobEngine.getState()).toBe('IDLE');

    // Now resolve Alice's delayed read
    deferred.resolve();
    await aliceHydratePromise;

    // Bob's partition must remain completely empty and unpolluted
    const bobNotes = await listNotesLocal();
    expect(bobNotes.length).toBe(0);
    expect(await getNoteLocal('note_alice_read')).toBeUndefined();
  });

  // Test 29: Requirement 2 - Account switch during a delayed Drive upload
  it('29. Account switch during a delayed Drive upload aborts without writing to new account', async () => {
    setActiveAccount('perm_alice');
    await clearLocalDatabase();
    const aliceAdapter = new MockDriveAdapter('perm_alice', 'token_alice');
    const aliceEngine = new SyncEngine(aliceAdapter, 'perm_alice');

    const aliceNote = createNote('note_alice_upload', 'Alice Upload Edits');
    aliceNote.contentHash = await computeContentHash(aliceNote.content);
    await saveNoteLocal(aliceNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_alice_up',
      type: 'SAVE_NOTE',
      targetId: aliceNote.id,
      payload: aliceNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    const deferred = createDeferred();
    aliceAdapter.onBeforeSaveNote = () => deferred.promise;

    const aliceProcessPromise = aliceEngine.processQueue();

    // Switch account to Bob mid-upload
    setActiveAccount('perm_bob');
    await clearLocalDatabase();
    const bobAdapter = new MockDriveAdapter('perm_bob', 'token_bob');
    expect(bobAdapter.accountId).toBe('perm_bob');
    const bobEngine = new SyncEngine(bobAdapter, 'perm_bob');
    expect(bobEngine.getState()).toBe('IDLE');

    deferred.resolve();
    await aliceProcessPromise;

    // Bob's database has zero notes and zero jobs
    expect((await listNotesLocal()).length).toBe(0);
    expect((await getAllQueueJobs()).length).toBe(0);

    // Alice's job in Alice's partition is preserved in pending status
    setActiveAccount('perm_alice');
    await recoverInterruptedJobs('perm_alice');
    const aliceJobs = await getAllQueueJobs();
    expect(aliceJobs.length).toBe(1);
    expect(aliceJobs[0].status).toBe('pending');
  });

  // Test 30: Requirement 3 - Account switch during a delayed manifest save
  it('30. Account switch during a delayed manifest save aborts before writing local manifest', async () => {
    setActiveAccount('perm_alice');
    await clearLocalDatabase();
    const aliceAdapter = new MockDriveAdapter('perm_alice', 'token_alice');
    const aliceEngine = new SyncEngine(aliceAdapter, 'perm_alice');

    const aliceNote = createNote('note_alice_mf', 'Alice Note for Manifest');
    aliceNote.contentHash = await computeContentHash(aliceNote.content);
    await saveNoteLocal(aliceNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_alice_mf',
      type: 'SAVE_NOTE',
      targetId: aliceNote.id,
      payload: aliceNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    const deferred = createDeferred();
    aliceAdapter.onBeforeSaveManifest = () => deferred.promise;

    const aliceProcessPromise = aliceEngine.processQueue();

    // Switch to Bob mid-manifest-save
    setActiveAccount('perm_bob');
    await clearLocalDatabase();
    const bobAdapter = new MockDriveAdapter('perm_bob', 'token_bob');
    expect(bobAdapter.accountId).toBe('perm_bob');

    deferred.resolve();
    await aliceProcessPromise;

    // Bob's local manifest must not contain Alice's note
    const bobManifest = await getManifestLocal();
    expect(bobManifest?.notes?.['note_alice_mf']).toBeUndefined();
  });

  // Test 31: Requirement 4 - Account A token is never used by Account B's operation and vice versa
  it('31. Account A token is never used by Account B operation, and adapter rejects cross-account token reassignment', async () => {
    const adapterA = new GoogleDriveStorageAdapter('token_AAA', 'perm_alice');
    const adapterB = new GoogleDriveStorageAdapter('token_BBB', 'perm_bob');

    expect(adapterA.getAccessToken()).toBe('token_AAA');
    expect(adapterB.getAccessToken()).toBe('token_BBB');

    // Attempting to mutate adapterA to Bob's account throws an error
    expect(() => {
      adapterA.setAccessToken('token_BBB', 'perm_bob');
    }).toThrow('Cannot assign token for account "perm_bob" to adapter bound to "perm_alice"');

    // Mock fetch to verify request Authorization header isolation
    const originalFetch = globalThis.fetch;
    const authHeadersSent: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeadersSent.push(headers.get('Authorization') || '');
      return new Response(JSON.stringify({ files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      await adapterA.discoverOrCreateAppFolders();
      await adapterB.discoverOrCreateAppFolders();

      expect(authHeadersSent).toContain('Bearer token_AAA');
      expect(authHeadersSent).toContain('Bearer token_BBB');

      // Request from adapterA never used token_BBB, and adapterB never used token_AAA
      const requestForA = authHeadersSent.filter(h => h === 'Bearer token_AAA');
      const requestForB = authHeadersSent.filter(h => h === 'Bearer token_BBB');
      expect(requestForA.length).toBeGreaterThan(0);
      expect(requestForB.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 32: Requirement 5 - Verifying stale operations cannot modify the other account's local notes or manifest
  it('32. Stale operations cannot modify the other account local notes or manifest', async () => {
    setActiveAccount('perm_bob');
    await clearLocalDatabase();

    // A stale operation attempting to call saveNoteLocal or saveManifestLocal for perm_alice while perm_bob is active is rejected
    const aliceNote = createNote('note_alice_stale', 'Stale Content');
    await expect(saveNoteLocal(aliceNote, 'perm_alice')).rejects.toThrow(AccountMismatchError);

    const aliceManifest: ApplicationManifest = {
      schemaVersion: 1,
      workspaceId: 'default',
      rootNoteId: 'root',
      lastModified: new Date().toISOString(),
      revisionSequence: 1,
      notes: { [aliceNote.id]: { id: aliceNote.id, title: 'Stale', type: 'text', attributes: [], contentHash: 'h', updatedAt: '', isDeleted: false } },
      branches: [],
    };
    await expect(saveManifestLocal(aliceManifest, 'perm_alice')).rejects.toThrow(AccountMismatchError);

    // Bob's partition has zero notes
    expect((await listNotesLocal()).length).toBe(0);
  });

  // Test 33: Requirement 6 - Repeated legacy import without duplicate jobs or overwritten notes
  it('33. Repeated legacy import is idempotent, skips existing notes, and creates zero duplicate jobs', async () => {
    const testLegacyDbName = `kurippu_test_legacy_33_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    try {
      // 1. Setup isolated legacy cache with 1 note
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const legacyNote = createNote('note_collision', 'Legacy Content (Older)');
      await legacyDb.put('notes', legacyNote);
      await legacyDb.add('sync_queue', {
        jobId: 'job_legacy_collision',
        type: 'SAVE_NOTE',
        targetId: 'note_collision',
        payload: legacyNote,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      legacyDb.close();

      // 2. Active account already has this note with updated local edits
      setActiveAccount('perm_active_user');
      await clearLocalDatabase();
      const activeNote = createNote('note_collision', 'Active Newer Content');
      activeNote.contentHash = await computeContentHash(activeNote.content);
      await saveNoteLocal(activeNote);

      // 3. First legacy import: must NOT overwrite active note, imports safe pending job
      const res1 = await importLegacyCacheToActiveAccount('perm_active_user');
      expect(res1.importedNotesCount).toBe(0);
      expect(res1.skippedNotesCount).toBe(1);
      expect(res1.importedJobsCount).toBe(1);

      // Verify content was not overwritten
      const preservedNote = await getNoteLocal('note_collision');
      expect(preservedNote?.plainTextPreview).toBe('Active Newer Content');

      // 4. Second legacy import: repeated execution creates zero duplicates
      const res2 = await importLegacyCacheToActiveAccount('perm_active_user');
      expect(res2.importedNotesCount).toBe(0);
      expect(res2.importedJobsCount).toBe(0);
      expect(res2.skippedNotesCount).toBe(1);

      // Total jobs in target account remains strictly 1 (no duplicate job was created on repeated import)
      const jobs = await getAllQueueJobs();
      expect(jobs.length).toBe(1);
    } finally {
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 34: Requirement 7 - Failed-job recovery and interrupted in-flight jobs
  it('34. Failed-job recovery restores interrupted jobs and protects uncommitted failed edits from being overwritten', async () => {
    setActiveAccount('perm_recovery_user');
    await clearLocalDatabase();

    const note = createNote('note_recover', 'Uncommitted Edits');
    note.clientDeviceId = 'device_recovery_current';
    setClientDeviceIdForTesting('device_recovery_current');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);

    // Seed a job stuck in 'in_flight' (as if app was interrupted/reloaded mid-save)
    const db = await openDB('kurippu_cache_perm_recovery_user', 1);
    await db.add('sync_queue', {
      jobId: 'job_interrupted',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'in_flight',
    });
    db.close();

    // 1. Interrupted in-flight job recovery
    const recovered = await recoverInterruptedJobs('perm_recovery_user');
    expect(recovered).toBe(1);
    const jobs = await getAllQueueJobs();
    expect(jobs[0].status).toBe('pending');

    // 2. Failed job protection: Mark job as failed (retryCount exceeded)
    jobs[0].status = 'failed';
    jobs[0].retryCount = 5;
    const db2 = await openDB('kurippu_cache_perm_recovery_user', 1);
    await db2.put('sync_queue', jobs[0]);
    db2.close();

    // Verify hasPendingJobForNote returns true for failed job (must not be treated as committed)
    expect(await hasPendingJobForNote(note.id)).toBe(true);

    // Hydration with differing remote content must NOT overwrite local failed note
    const recoveryAdapter = new MockDriveAdapter();
    const folderInfo = await recoveryAdapter.discoverOrCreateAppFolders();
    const remoteDifferent = createNote('note_recover', 'Remote Cloud Content');
    remoteDifferent.clientDeviceId = 'device_recovery_current';
    remoteDifferent.contentHash = await computeContentHash(remoteDifferent.content);
    await recoveryAdapter.saveNote(remoteDifferent, folderInfo);

    const recoveryEngine = new SyncEngine(recoveryAdapter, 'perm_recovery_user');
    await recoveryEngine.hydrateAndReconcileFromDrive();

    // Local note is preserved with its uncommitted edits!
    const noteAfterHydrate = await getNoteLocal('note_recover');
    expect(noteAfterHydrate?.plainTextPreview).toBe('Uncommitted Edits');

    // 3. Retry failed jobs
    const retried = await retryFailedJobs('perm_recovery_user');
    expect(retried).toBe(1);
    const jobsAfterRetry = await getAllQueueJobs();
    expect(jobsAfterRetry[0].status).toBe('pending');
    expect(jobsAfterRetry[0].retryCount).toBe(0);
  });

  // Test 35: Requirement 8 - Delete operations and prevention of deleted-note resurrection
  it('35. Delete operations delete remote file, update manifest tombstones, and prevent note resurrection on another device', async () => {
    // Device 1: Creates, saves, and deletes a note
    setActiveAccount('perm_device1');
    await clearLocalDatabase();
    const dev1Adapter = new MockDriveAdapter('perm_device1', 'token_dev1');
    const dev1Engine = new SyncEngine(dev1Adapter, 'perm_device1');

    const note = createNote('note_to_delete', 'Content To Delete');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_save_before_del',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await dev1Engine.processQueue();

    // Device 1 deletes the note
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_delete_note',
      type: 'DELETE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await dev1Engine.processQueue();

    // Remote file is trashed on Drive
    const remoteFiles = Array.from(dev1Adapter.files.values()).filter(f => f.appProperties['kurippuNoteId'] === note.id);
    expect(remoteFiles[0].trashed).toBe(true);

    // Remote manifest has tombstone isDeleted: true
    const folderInfo = await dev1Adapter.discoverOrCreateAppFolders();
    const remoteManifest = await dev1Adapter.getManifest(folderInfo);
    expect(remoteManifest?.manifest.notes[note.id].isDeleted).toBe(true);

    // Device 2 has note_to_delete in its local cache (isDeleted: false)
    setActiveAccount('perm_device2');
    await clearLocalDatabase();
    const dev2Engine = new SyncEngine(dev1Adapter, 'perm_device2');
    const dev2LocalCopy = { ...note, isDeleted: false };
    await saveNoteLocal(dev2LocalCopy);
    expect((await listNotesLocal()).length).toBe(1);

    // Device 2 hydrates from Drive: remote deletion is synchronized, tombstone applied
    await dev2Engine.hydrateAndReconcileFromDrive();

    // Active notes list returns 0 notes (deleted note does NOT resurrect!)
    const dev2ActiveNotes = await listNotesLocal(undefined, false);
    expect(dev2ActiveNotes.length).toBe(0);

    // Local note is preserved as tombstone (isDeleted: true)
    const dev2StoredNote = await getNoteLocal(note.id);
    expect(dev2StoredNote?.isDeleted).toBe(true);
  });

  // Test 36: Requirement 9 - Sign-out while an operation is in flight
  it('36. Sign-out while an operation is in flight aborts cleanly without corruption', async () => {
    setActiveAccount('perm_alice_signout');
    await clearLocalDatabase();
    const aliceAdapter = new MockDriveAdapter('perm_alice_signout', 'token_alice');
    const aliceEngine = new SyncEngine(aliceAdapter, 'perm_alice_signout');

    const note = createNote('note_signout_inflight', 'Alice In Flight Data');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_signout_inflight',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    const deferred = createDeferred();
    aliceAdapter.onBeforeSaveNote = () => deferred.promise;

    const processPromise = aliceEngine.processQueue();

    // User signs out while saveNote is waiting
    aliceEngine.setAdapter(new MockDriveAdapter(), null);
    setActiveAccount(null);

    // Now resolve the delayed saveNote
    deferred.resolve();
    await processPromise;

    // Active account is null; operations reject access
    expect(getActiveAccountId()).toBeNull();
    await expect(listNotesLocal()).rejects.toThrow('IndexedDB access denied');

    // When Alice signs back in, her note and job are safely preserved
    setActiveAccount('perm_alice_signout');
    await recoverInterruptedJobs('perm_alice_signout');
    const aliceNotes = await listNotesLocal();
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].plainTextPreview).toBe('Alice In Flight Data');
    const aliceJobs = await getAllQueueJobs();
    expect(aliceJobs.length).toBe(1);
    expect(aliceJobs[0].status).toBe('pending');
  });

  // Test 37: Account switch during DELETE_NOTE operation
  it('37. Account switch during DELETE_NOTE operation aborts without writing to new account partition, and job recovers safely', async () => {
    setActiveAccount('perm_alice_del_switch');
    await clearLocalDatabase();
    const aliceAdapter = new MockDriveAdapter('perm_alice_del_switch', 'token_alice');
    const syncEngine = new SyncEngine(aliceAdapter, 'perm_alice_del_switch');

    // Create note on Alice's device and commit it to Drive
    const aliceNote = createNote('note_alice_del', 'Alice Note To Delete');
    aliceNote.contentHash = await computeContentHash(aliceNote.content);
    await saveNoteLocal(aliceNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_alice_create',
      type: 'SAVE_NOTE',
      targetId: aliceNote.id,
      payload: aliceNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await syncEngine.processQueue();

    // Verify remote file exists on Alice's Drive
    const remoteFiles = Array.from(aliceAdapter.files.values()).filter(f => f.appProperties['kurippuNoteId'] === 'note_alice_del');
    expect(remoteFiles.length).toBe(1);
    expect(remoteFiles[0].trashed).toBe(false);

    // Enqueue DELETE_NOTE job for Alice
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_alice_del_switch',
      type: 'DELETE_NOTE',
      targetId: aliceNote.id,
      payload: aliceNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Pause mock adapter after the remote file deletion completes
    const deferred = createDeferred();
    aliceAdapter.onAfterDeleteNoteFile = () => deferred.promise;

    const deletePromise = syncEngine.processQueue();

    // While deletion is paused after remote file removal, switch account to Bob!
    setActiveAccount('perm_bob_del_switch');
    await clearLocalDatabase();
    const bobAdapter = new MockDriveAdapter('perm_bob_del_switch', 'token_bob');
    syncEngine.setAdapter(bobAdapter, 'perm_bob_del_switch');

    // Resume the delayed delete operation
    deferred.resolve();
    await deletePromise;

    // Verify Bob's cache was NOT touched or polluted with Alice's note or manifest
    expect((await listNotesLocal()).length).toBe(0);
    expect((await getAllQueueJobs()).length).toBe(0);
    const bobManifest = await getManifestLocal();
    expect(bobManifest?.notes?.['note_alice_del']).toBeUndefined();

    // Switch back to Alice: verify delete job was not silently lost and is recoverable
    setActiveAccount('perm_alice_del_switch');
    syncEngine.setAdapter(aliceAdapter, 'perm_alice_del_switch');
    await recoverInterruptedJobs('perm_alice_del_switch');

    const aliceJobs = await getAllQueueJobs();
    expect(aliceJobs.length).toBe(1);
    expect(aliceJobs[0].type).toBe('DELETE_NOTE');
    expect(aliceJobs[0].status).toBe('pending');

    // Remove hook and complete the recovered deletion job
    aliceAdapter.onAfterDeleteNoteFile = undefined;
    await syncEngine.processQueue();

    // Verify Alice's pending jobs queue is empty and tombstone is saved
    expect((await getAllQueueJobs()).length).toBe(0);
    const folderInfo = await aliceAdapter.discoverOrCreateAppFolders();
    const aliceRemoteManifest = await aliceAdapter.getManifest(folderInfo);
    expect(aliceRemoteManifest?.manifest.notes['note_alice_del']?.isDeleted).toBe(true);

    const aliceLocalNote = await getNoteLocal('note_alice_del');
    expect(aliceLocalNote?.isDeleted).toBe(true);
  });

  // Test 38: Partial deletion and retry
  it('38. Partial deletion preserves recoverable job, and retry treats already-deleted Drive file as idempotent success', async () => {
    setActiveAccount('perm_partial_del');
    await clearLocalDatabase();
    const adapter = new MockDriveAdapter('perm_partial_del', 'token_partial');
    const engine = new SyncEngine(adapter, 'perm_partial_del');

    // Create and save note to Drive
    const note = createNote('note_partial_del', 'Partial Delete Content');
    note.contentHash = await computeContentHash(note.content);
    await saveNoteLocal(note);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_create_partial',
      type: 'SAVE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });
    await engine.processQueue();

    const folderInfo = await adapter.discoverOrCreateAppFolders();

    // Enqueue DELETE_NOTE job
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_partial_del',
      type: 'DELETE_NOTE',
      targetId: note.id,
      payload: note,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Simulate failure: remote file deletion succeeds, but saveManifest throws error
    let manifestSaveFailedOnce = false;
    adapter.onBeforeSaveManifest = (manifest) => {
      if (!manifestSaveFailedOnce && manifest.notes['note_partial_del']?.isDeleted) {
        manifestSaveFailedOnce = true;
        throw new Error('Simulated network failure saving remote manifest');
      }
    };

    // First attempt fails during manifest update
    await engine.processQueue();

    // 1. Verify remote file was already deleted (trashed)
    const remoteFile = Array.from(adapter.files.values()).find(f => f.appProperties['kurippuNoteId'] === 'note_partial_del');
    expect(remoteFile?.trashed).toBe(true);

    // 2. Verify remote manifest does NOT yet have tombstone
    const remoteManifestBefore = await adapter.getManifest(folderInfo);
    expect(remoteManifestBefore?.manifest.notes['note_partial_del']?.isDeleted).toBe(false);

    // 3. Verify DELETE_NOTE job remains recoverable in sync_queue
    const jobs = await getAllQueueJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].type).toBe('DELETE_NOTE');
    expect(jobs[0].retryCount).toBe(1);

    // 4. Retry the job: already-deleted Drive file is handled idempotently, and manifest tombstone is saved
    adapter.onBeforeSaveManifest = undefined;
    await engine.processQueue();

    expect((await getAllQueueJobs()).length).toBe(0);

    const remoteManifestAfter = await adapter.getManifest(folderInfo);
    expect(remoteManifestAfter?.manifest.notes['note_partial_del']?.isDeleted).toBe(true);

    // 5. Subsequent hydration must NOT resurrect the deleted note
    await engine.hydrateAndReconcileFromDrive();
    const activeNotes = await listNotesLocal(undefined, false);
    expect(activeNotes.length).toBe(0);

    const storedNote = await getNoteLocal('note_partial_del');
    expect(storedNote?.isDeleted).toBe(true);
  });

  // Test 39: Sign-out during DELETE_NOTE operation
  it('39. Sign-out during deletion aborts cleanly, does not lose unrelated notes, and job remains recoverable', async () => {
    setActiveAccount('perm_alice_signout_del');
    await clearLocalDatabase();
    const aliceAdapter = new MockDriveAdapter('perm_alice_signout_del', 'token_alice');
    const engine = new SyncEngine(aliceAdapter, 'perm_alice_signout_del');

    // Create an unrelated note (to remain active) and a note to delete
    const unrelatedNote = createNote('note_unrelated', 'Alice Important Kept Note');
    unrelatedNote.contentHash = await computeContentHash(unrelatedNote.content);
    await saveNoteLocal(unrelatedNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_unrelated',
      type: 'SAVE_NOTE',
      targetId: unrelatedNote.id,
      payload: unrelatedNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    const noteToDelete = createNote('note_to_del_signout', 'Note To Delete Before Signout');
    noteToDelete.contentHash = await computeContentHash(noteToDelete.content);
    await saveNoteLocal(noteToDelete);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_to_del',
      type: 'SAVE_NOTE',
      targetId: noteToDelete.id,
      payload: noteToDelete,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    await engine.processQueue();
    expect((await listNotesLocal(undefined, false)).length).toBe(2);

    // Enqueue DELETE_NOTE job
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_del_inflight_signout',
      type: 'DELETE_NOTE',
      targetId: noteToDelete.id,
      payload: noteToDelete,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Pause deletion before remote file deletion
    const deferred = createDeferred();
    aliceAdapter.onBeforeDeleteNoteFile = () => deferred.promise;

    const deletePromise = engine.processQueue();

    // User signs out while deletion is in flight
    engine.setAdapter(new MockDriveAdapter(), null);
    setActiveAccount(null);

    deferred.resolve();
    await deletePromise;

    // Verify user is signed out and DB access rejected
    expect(getActiveAccountId()).toBeNull();
    await expect(listNotesLocal()).rejects.toThrow('IndexedDB access denied');

    // Sign back in as Alice
    setActiveAccount('perm_alice_signout_del');
    engine.setAdapter(aliceAdapter, 'perm_alice_signout_del');
    await recoverInterruptedJobs('perm_alice_signout_del');

    // Verify unrelated note is intact and not lost
    const recoveredUnrelated = await getNoteLocal('note_unrelated');
    expect(recoveredUnrelated).toBeDefined();
    expect(recoveredUnrelated?.plainTextPreview).toBe('Alice Important Kept Note');
    expect(recoveredUnrelated?.isDeleted).toBe(false);

    // Verify DELETE_NOTE job is preserved in queue
    const aliceJobs = await getAllQueueJobs();
    expect(aliceJobs.length).toBe(1);
    expect(aliceJobs[0].type).toBe('DELETE_NOTE');
    expect(aliceJobs[0].status).toBe('pending');

    // Complete the delete job
    aliceAdapter.onBeforeDeleteNoteFile = undefined;
    await engine.processQueue();

    expect((await getAllQueueJobs()).length).toBe(0);
    const activeNotes = await listNotesLocal(undefined, false);
    expect(activeNotes.length).toBe(1);
    expect(activeNotes[0].id).toBe('note_unrelated');

    const tombstonedNote = await getNoteLocal('note_to_del_signout');
    expect(tombstonedNote?.isDeleted).toBe(true);
  });

  // Test 40: Edge Case 1 - IndexedDB open race between Account A and Account B
  it('40. IndexedDB open race: Account A stale open cannot replace or invalidate Account B connection', async () => {
    setActiveAccount('perm_alice_race');

    // Account A initiates getLocalDB() while opening is in flight
    const promiseA = getLocalDB();

    // In the same synchronous turn before promiseA's open resolves, switch active account to Bob
    setActiveAccount('perm_bob_race');

    // Account B initiates getLocalDB()
    const promiseB = getLocalDB();

    // Account A's stale open must reject with StaleSessionError
    await expect(promiseA).rejects.toThrow(StaleSessionError);

    // Account B's open must resolve successfully
    const dbB = await promiseB;
    expect(dbB.name).toBe('kurippu_cache_perm_bob_race');

    // Bob can write and read his own notes
    const bobNote = createNote('note_bob_data', 'Bob Secret Data');
    await saveNoteLocal(bobNote);
    const bobNotes = await listNotesLocal();
    expect(bobNotes.length).toBe(1);
    expect(bobNotes[0].id).toBe('note_bob_data');

    // Switching back to Alice confirms Alice's partition is isolated and does not contain Bob's note
    setActiveAccount('perm_alice_race');
    const aliceNotes = await listNotesLocal();
    expect(aliceNotes.length).toBe(0);
    expect(await getNoteLocal('note_bob_data')).toBeUndefined();
  });

  // Test 41: Edge Case 2 - Partial legacy migration and recovery
  it('41. Partial legacy migration: recovers missing notes on re-run without duplicate entries or modifying legacy database', async () => {
    const testLegacyDbName = `kurippu_test_legacy_41_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    let verifyLegacyDb: any = null;
    try {
      // 1. Setup isolated legacy database with 3 notes and 3 jobs
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const note1 = createNote('legacy_1', 'Legacy 1 Text');
      const note2 = createNote('legacy_2', 'Legacy 2 Text');
      const note3 = createNote('legacy_3', 'Legacy 3 Text');
      for (const n of [note1, note2, note3]) {
        await legacyDb.put('notes', n);
        await legacyDb.add('sync_queue', {
          jobId: `job_${n.id}`,
          type: 'SAVE_NOTE',
          targetId: n.id,
          payload: n,
          clientTimestamp: Date.now(),
          retryCount: 0,
          status: 'pending',
        });
      }
      legacyDb.close();

      // 2. Setup destination account with legacy_1 already imported (simulating failure after note 1)
      setActiveAccount('perm_dest_partial');
      await clearLocalDatabase();
      await saveNoteLocal(note1);

      // 3. Re-run migration: must skip note1, import missing note2 and note3
      const res = await importLegacyCacheToActiveAccount('perm_dest_partial');
      expect(res.skippedNotesCount).toBe(1);
      expect(res.importedNotesCount).toBe(2);

      // Verify all 3 notes exist in destination with zero duplicates
      const destNotes = await listNotesLocal();
      expect(destNotes.length).toBe(3);
      const destIds = destNotes.map(n => n.id).sort();
      expect(destIds).toEqual(['legacy_1', 'legacy_2', 'legacy_3']);

      // Verify all 3 notes have sync jobs ready to sync to Drive
      const destJobs = await getAllQueueJobs();
      expect(destJobs.length).toBe(3);

      // 4. Repeated run is completely idempotent
      const res2 = await importLegacyCacheToActiveAccount('perm_dest_partial');
      expect(res2.importedNotesCount).toBe(0);
      expect(res2.importedJobsCount).toBe(0);
      expect(res2.skippedNotesCount).toBe(3);
      expect((await getAllQueueJobs()).length).toBe(3);

      // Verify legacy database remains completely untouched with 3 notes
      verifyLegacyDb = await openDB(testLegacyDbName, 1);
      expect((await verifyLegacyDb.getAll('notes')).length).toBe(3);
      expect((await verifyLegacyDb.getAll('sync_queue')).length).toBe(3);
      verifyLegacyDb.close();
      verifyLegacyDb = null;
    } finally {
      if (verifyLegacyDb) {
        try { verifyLegacyDb.close(); } catch {}
      }
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 42: Edge Case 3 - Failed legacy job collision & payload protection
  it('42. Failed legacy job collision: deduplicates jobs and prevents older legacy payloads from overwriting newer local edits', async () => {
    const testLegacyDbName = `kurippu_test_legacy_42_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    try {
      // 1. Setup isolated legacy database with note_collision containing old content
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const oldLegacyNote = createNote('note_collision_failed', 'Old Stale Legacy Content');
      await legacyDb.put('notes', oldLegacyNote);
      await legacyDb.add('sync_queue', {
        jobId: 'job_legacy_old',
        type: 'SAVE_NOTE',
        targetId: 'note_collision_failed',
        payload: oldLegacyNote,
        clientTimestamp: Date.now() - 100000,
        retryCount: 0,
        status: 'pending',
      });
      legacyDb.close();

      // 2. Destination account has note_collision_failed with NEWER local edits
      setActiveAccount('perm_collision_test');
      await clearLocalDatabase();
      const newerActiveNote = createNote('note_collision_failed', 'Newer Active Local Edits');
      newerActiveNote.contentHash = await computeContentHash(newerActiveNote.content);
      await saveNoteLocal(newerActiveNote);

      // Destination account has an existing FAILED job for this note
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_destination_failed',
        type: 'SAVE_NOTE',
        targetId: 'note_collision_failed',
        payload: newerActiveNote,
        clientTimestamp: Date.now(),
        retryCount: 5,
        status: 'failed',
      });

      // Verify pre-condition: destination has 1 failed job
      const initialJobs = await getAllQueueJobs();
      expect(initialJobs.length).toBe(1);
      expect(initialJobs[0].status).toBe('failed');

      // 3. Run migration into destination account
      const res = await importLegacyCacheToActiveAccount('perm_collision_test');
      expect(res.skippedNotesCount).toBe(1);
      expect(res.importedNotesCount).toBe(0);
      expect(res.importedJobsCount).toBe(0); // Deduplicated: zero duplicate jobs created

      // 4. Verify local note still has NEWER content (never overwritten by legacy)
      const storedNote = await getNoteLocal('note_collision_failed');
      expect(storedNote?.plainTextPreview).toBe('Newer Active Local Edits');

      // 5. Verify destination queue still contains strictly 1 job with newer payload
      const jobsAfterMigration = await getAllQueueJobs();
      expect(jobsAfterMigration.length).toBe(1);
      const jobPayload = jobsAfterMigration[0].payload as NoteDocument;
      expect(jobPayload.plainTextPreview).toBe('Newer Active Local Edits');

      // 6. Retrying failed jobs restores the job with the newer content for sync
      const retriedCount = await retryFailedJobs('perm_collision_test');
      expect(retriedCount).toBe(1);
      const jobsAfterRetry = await getAllQueueJobs();
      expect(jobsAfterRetry[0].status).toBe('pending');
      expect(jobsAfterRetry[0].retryCount).toBe(0);
    } finally {
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 43: Edge Case 4 - Concurrent legacy migration attempts
  it('43. Concurrent legacy migration attempts reuse in-flight promise and create zero duplicate jobs or inconsistent manifests', async () => {
    const testLegacyDbName = `kurippu_test_legacy_43_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    try {
      // 1. Setup isolated legacy database with 2 notes and 2 jobs
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const noteA = createNote('concurrent_note_a', 'Concurrent Note A');
      const noteB = createNote('concurrent_note_b', 'Concurrent Note B');
      for (const n of [noteA, noteB]) {
        await legacyDb.put('notes', n);
        await legacyDb.add('sync_queue', {
          jobId: `job_${n.id}`,
          type: 'SAVE_NOTE',
          targetId: n.id,
          payload: n,
          clientTimestamp: Date.now(),
          retryCount: 0,
          status: 'pending',
        });
      }
      legacyDb.close();

      // 2. Destination account starts empty
      setActiveAccount('perm_concurrent_migration');
      await clearLocalDatabase();

      // 3. Initiate two concurrent migration attempts simultaneously
      const [res1, res2] = await Promise.all([
        importLegacyCacheToActiveAccount('perm_concurrent_migration'),
        importLegacyCacheToActiveAccount('perm_concurrent_migration'),
      ]);

      // Both callers receive the exact same migration result
      expect(res1).toEqual(res2);
      expect(res1.importedNotesCount).toBe(2);

      // Verify destination database has exactly 2 notes (zero duplicates)
      const notes = await listNotesLocal();
      expect(notes.length).toBe(2);

      // Verify destination queue has exactly 2 jobs (zero duplicate jobs)
      const jobs = await getAllQueueJobs();
      expect(jobs.length).toBe(2);

      // Verify destination manifest has exactly 2 notes
      const manifest = await getManifestLocal();
      expect(Object.keys(manifest?.notes || {}).length).toBe(2);
    } finally {
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 44: Stale-session UI refresh guard
  it('44. Stale-session UI refresh guard: rejects stale session reads and suppresses UI state updates when account switches during refresh', async () => {
    // 1. Setup Alice's account with Alice's note
    setActiveAccount('perm_alice_refresh');
    await clearLocalDatabase();
    const aliceNote = createNote('note_alice_refresh', 'Alice Secret Content');
    await saveNoteLocal(aliceNote);

    // 2. Setup Bob's account with Bob's note
    setActiveAccount('perm_bob_refresh');
    await clearLocalDatabase();
    const bobNote = createNote('note_bob_refresh', 'Bob Secret Content');
    await saveNoteLocal(bobNote);

    // 3. Scenario A: Post-read session verification prevents stale state updates
    // Alice is active and captures account and session
    setActiveAccount('perm_alice_refresh');
    const aliceAccountId = getActiveAccountId()!;
    const aliceSessionId = getActiveAccountSessionId();

    // Alice reads her notes
    const aliceNotes = await listNotesLocal(aliceAccountId, false, aliceSessionId);
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].id).toBe('note_alice_refresh');

    // Before state update executes, account switches to Bob
    setActiveAccount('perm_bob_refresh');

    // Simulate React component state (currently Bob's data)
    let componentNotes: NoteDocument[] = [bobNote];
    let stateWasOverwritten = false;

    // Execute the exact guard logic from refreshLocalData()
    if (getActiveAccountId() === aliceAccountId && getActiveAccountSessionId() === aliceSessionId) {
      componentNotes = aliceNotes;
      stateWasOverwritten = true;
    }

    // Must NOT overwrite Bob's UI state with Alice's resolved notes
    expect(stateWasOverwritten).toBe(false);
    expect(componentNotes.length).toBe(1);
    expect(componentNotes[0].id).toBe('note_bob_refresh');

    // 4. Scenario B: Stale session read rejection & error suppression
    // Any read attempted using Alice's stale session ID rejects with StaleSessionError
    await expect(listNotesLocal(aliceAccountId, false, aliceSessionId)).rejects.toThrow(StaleSessionError);
    await expect(getAllQueueJobs(aliceAccountId, aliceSessionId)).rejects.toThrow(StaleSessionError);

    // Verify error suppression: StaleSessionError is caught silently, not logged as unexpected error
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      try {
        await listNotesLocal(aliceAccountId, false, aliceSessionId);
      } catch (err: any) {
        if (
          err instanceof StaleSessionError ||
          err?.name === 'StaleSessionError' ||
          err instanceof AccountMismatchError ||
          err?.name === 'AccountMismatchError'
        ) {
          // Expected cancellation
        } else {
          console.warn('[App] Failed to refresh local data:', err.message);
        }
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }

    // 5. Bob's reads using Bob's valid session succeed and return Bob's data
    const bobAccountId = getActiveAccountId()!;
    const bobSessionId = getActiveAccountSessionId();
    const bobNotes = await listNotesLocal(bobAccountId, false, bobSessionId);
    expect(bobNotes.length).toBe(1);
    expect(bobNotes[0].id).toBe('note_bob_refresh');
  });

  // Test 45: Account switch during migration cancels and prevents foreign partition pollution
  it('45. Account switch during migration cancels cleanly and prevents data leakage into new account', async () => {
    const testLegacyDbName = `kurippu_test_legacy_45_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    // 1. Setup isolated legacy database with 3 notes
    const legacyDb = await openLegacyDatabase(testLegacyDbName);
    const note1 = createNote('mig_race_1', 'Migration Race 1');
    const note2 = createNote('mig_race_2', 'Migration Race 2');
    const note3 = createNote('mig_race_3', 'Migration Race 3');
    for (const n of [note1, note2, note3]) {
      await legacyDb.put('notes', n);
    }
    legacyDb.close();

    // 2. Setup Alice's account
    setActiveAccount('perm_alice_switch_race');
    await clearLocalDatabase();

    // 3. Test seam: pause Alice's migration deterministically before destination write transaction begins
    let resumeMigration!: () => void;
    let notifyPaused!: () => void;
    const pauseGate = new Promise<void>(resolve => { resumeMigration = resolve; });
    const reachedPauseGate = new Promise<void>(resolve => { notifyPaused = resolve; });

    setMigrationBeforeWriteHookForTesting(async () => {
      notifyPaused();
      await pauseGate;
    });

    try {
      // Alice initiates migration
      const aliceMigrationPromise = importLegacyCacheToActiveAccount('perm_alice_switch_race');

      // Wait until Alice's migration has read legacy data, acquired target DB,
      // and paused right before beginning destination write transaction
      await reachedPauseGate;

      // 4. User switches account to Bob mid-flight while Alice is paused
      setActiveAccount('perm_bob_switch_race');
      await clearLocalDatabase();

      // Release the pause gate: Alice resumes and immediately encounters session/account validation
      resumeMigration();

      // Alice's migration must reject due to stale session or account mismatch
      await expect(aliceMigrationPromise).rejects.toThrow(/(Account partition mismatch|Stale session rejected)/);

      // 5. Bob's partition must remain completely empty (zero Alice notes written)
      const bobNotes = await listNotesLocal();
      expect(bobNotes.length).toBe(0);
      const bobManifest = await getManifestLocal();
      expect(Object.keys(bobManifest?.notes || {}).length).toBe(0);
      const bobJobs = await getAllQueueJobs();
      expect(bobJobs.length).toBe(0);

      // 6. Switching back to Alice allows clean, successful migration recovery
      setActiveAccount('perm_alice_switch_race');
      const recoveryResult = await importLegacyCacheToActiveAccount('perm_alice_switch_race');
      expect(recoveryResult.importedNotesCount).toBe(3);

      const aliceNotes = await listNotesLocal();
      expect(aliceNotes.length).toBe(3);
    } finally {
      setMigrationBeforeWriteHookForTesting(null);
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 46: Account- and session-scoped migration coordination
  it('46. Account- and session-scoped migration coordination: rejects cross-account calls and isolates per session', async () => {
    const testLegacyDbName = `kurippu_test_legacy_46_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    try {
      // 1. Setup isolated legacy database with 1 note
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      await legacyDb.put('notes', createNote('note_coord', 'Coord Note'));
      legacyDb.close();

      // 2. Alice is active
      setActiveAccount('perm_alice_coord');
      await clearLocalDatabase();

      // 3. Requesting Bob's partition while Alice is active must reject with AccountMismatchError
      await expect(importLegacyCacheToActiveAccount('perm_bob_coord')).rejects.toThrow(AccountMismatchError);

      // 4. Concurrent calls for the same active account and session must share the same promise
      const promise1 = importLegacyCacheToActiveAccount('perm_alice_coord');
      const promise2 = importLegacyCacheToActiveAccount('perm_alice_coord');
      expect(promise1).toBe(promise2);

      const resAlice = await promise1;
      expect(resAlice.importedNotesCount).toBe(1);

      // 5. Switch to Bob
      setActiveAccount('perm_bob_coord');
      await clearLocalDatabase();

      // Bob's call must receive a fresh, independent promise (not Alice's resolved or cached promise)
      const promiseBob1 = importLegacyCacheToActiveAccount('perm_bob_coord');
      expect(promiseBob1).not.toBe(promise1);

      const resBob = await promiseBob1;
      expect(resBob.importedNotesCount).toBe(1);

      // 6. After completion, subsequent calls receive a new promise, verifying cleanup of Map entry
      const promiseBob2 = importLegacyCacheToActiveAccount('perm_bob_coord');
      expect(promiseBob2).not.toBe(promiseBob1);
      const resBob2 = await promiseBob2;
      expect(resBob2.skippedNotesCount).toBe(1); // Already imported
    } finally {
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 47: Destination note preservation, idempotency, and legacy database non-mutation
  it('47. Destination note preservation, idempotency on retry, and legacy database non-mutation', async () => {
    const testLegacyDbName = `kurippu_test_legacy_47_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    let checkLegacyDb: any = null;
    try {
      // 1. Setup isolated legacy database with note A and note B
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const noteA = createNote('note_idemp_a', 'Original Legacy A Content');
      const noteB = createNote('note_idemp_b', 'Original Legacy B Content');
      await legacyDb.put('notes', noteA);
      await legacyDb.put('notes', noteB);
      await legacyDb.add('sync_queue', {
        jobId: 'job_legacy_a',
        type: 'SAVE_NOTE',
        targetId: 'note_idemp_a',
        payload: noteA,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      legacyDb.close();

      // 2. Setup destination partition where note A already exists with local edits
      setActiveAccount('perm_dest_idemp');
      await clearLocalDatabase();
      const locallyEditedA = {
        ...createNote('note_idemp_a', 'Locally Modified Destination Content'),
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      };
      await saveNoteLocal(locallyEditedA);

      // 3. Run migration
      const result = await importLegacyCacheToActiveAccount('perm_dest_idemp');
      expect(result.skippedNotesCount).toBe(1); // noteA was skipped
      expect(result.importedNotesCount).toBe(1); // noteB was imported

      // 4. Verify destination note A was NOT overwritten by legacy content
      const destinationNoteA = await getNoteLocal('note_idemp_a');
      expect(destinationNoteA?.plainTextPreview).toBe('Locally Modified Destination Content');

      // Verify destination note B was imported
      const destinationNoteB = await getNoteLocal('note_idemp_b');
      expect(destinationNoteB?.plainTextPreview).toBe('Original Legacy B Content');

      // 5. Verify legacy database remains 100% untouched
      checkLegacyDb = await openDB(testLegacyDbName, 1);
      const legacyNotesAfter = await checkLegacyDb.getAll('notes');
      const legacyJobsAfter = await checkLegacyDb.getAll('sync_queue');
      checkLegacyDb.close();
      checkLegacyDb = null;
      expect(legacyNotesAfter.length).toBe(2);
      expect(legacyJobsAfter.length).toBe(1);

      // 6. Safe retry: running migration again does not duplicate notes or jobs
      const retryResult = await importLegacyCacheToActiveAccount('perm_dest_idemp');
      expect(retryResult.skippedNotesCount).toBe(2);
      expect(retryResult.importedNotesCount).toBe(0);
      expect(retryResult.importedJobsCount).toBe(0);

      const destNotes = await listNotesLocal();
      expect(destNotes.length).toBe(2);
    } finally {
      if (checkLegacyDb) {
        try { checkLegacyDb.close(); } catch {}
      }
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 47b: Destination write transaction failure rolls back all stores atomically
  it('47b. Destination write transaction failure rolls back notes, manifest, and sync queue atomically', async () => {
    const testLegacyDbName = `kurippu_test_legacy_47b_${Date.now()}`;
    setLegacyDbNameForTesting(testLegacyDbName);

    let checkLegacyDb: any = null;
    const originalPut = IDBObjectStore.prototype.put;
    let putSpy: any = null;

    try {
      // 1. Setup isolated legacy database with note A, note B, and a sync job
      const legacyDb = await openLegacyDatabase(testLegacyDbName);
      const noteA = createNote('note_rollback_a', 'Rollback Note A Content');
      const noteB = createNote('note_rollback_b', 'Rollback Note B Content');
      await legacyDb.put('notes', noteA);
      await legacyDb.put('notes', noteB);
      await legacyDb.add('sync_queue', {
        jobId: 'job_rollback_a',
        type: 'SAVE_NOTE',
        targetId: 'note_rollback_a',
        payload: noteA,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      legacyDb.close();

      // 2. Setup clean destination partition
      setActiveAccount('perm_dest_rollback');
      await clearLocalDatabase();

      // 3. Inject a controlled JavaScript error during migration AFTER destination note writes have executed
      let notesWrittenBeforeError = 0;
      putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: any, key?: any) {
        if (this.name === 'notes') {
          notesWrittenBeforeError++;
        }
        if (this.name === 'manifest') {
          throw new Error('Controlled JavaScript failure during manifest merge in transaction');
        }
        return originalPut.call(this, value, key);
      });

      // 4. Migration must reject with the injected error
      await expect(importLegacyCacheToActiveAccount('perm_dest_rollback')).rejects.toThrow(
        'Controlled JavaScript failure during manifest merge in transaction'
      );

      // Verify that at least one destination note write had been executed before the error
      expect(notesWrittenBeforeError).toBeGreaterThanOrEqual(1);

      // 5. Verify atomic rollback: destination partition must have ZERO notes, ZERO manifest entries, and ZERO queue jobs
      const destNotes = await listNotesLocal('perm_dest_rollback');
      expect(destNotes.length).toBe(0);

      const destManifest = await getManifestLocal('perm_dest_rollback');
      expect(destManifest?.notes?.['note_rollback_a']).toBeUndefined();
      expect(destManifest?.notes?.['note_rollback_b']).toBeUndefined();
      expect(Object.keys(destManifest?.notes || {}).length).toBe(0);

      const destJobs = await getAllQueueJobs('perm_dest_rollback');
      expect(destJobs.length).toBe(0);

      // 6. Verify legacy database remains 100% untouched
      checkLegacyDb = await openDB(testLegacyDbName, 1);
      const legacyNotesAfter = await checkLegacyDb.getAll('notes');
      const legacyJobsAfter = await checkLegacyDb.getAll('sync_queue');
      checkLegacyDb.close();
      checkLegacyDb = null;
      expect(legacyNotesAfter.length).toBe(2);
      expect(legacyJobsAfter.length).toBe(1);

      // 7. Remove the error injection and verify that subsequent migration retry succeeds cleanly
      putSpy.mockRestore();
      putSpy = null;

      const retryResult = await importLegacyCacheToActiveAccount('perm_dest_rollback');
      expect(retryResult.importedNotesCount).toBe(2);
      expect(retryResult.importedJobsCount).toBe(1);
      expect(retryResult.skippedNotesCount).toBe(0);

      const recoveredNotes = await listNotesLocal('perm_dest_rollback');
      expect(recoveredNotes.length).toBe(2);
      const recoveredJobs = await getAllQueueJobs('perm_dest_rollback');
      expect(recoveredJobs.length).toBe(1);
    } finally {
      if (putSpy) {
        try { putSpy.mockRestore(); } catch {}
      }
      if (checkLegacyDb) {
        try { checkLegacyDb.close(); } catch {}
      }
      try { await deleteDB(testLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
    }
  });

  // Test 48: Stale completion safety via production executeLegacyImportWorkflow
  it('48. executeLegacyImportWorkflow: stale completion does not mutate UI state, call processQueue, or log errors', async () => {
    // 1. Spies to verify callback invocations
    const setLegacyCacheInfoSpy = vi.fn();
    const refreshLocalDataSpy = vi.fn();
    const processQueueSpy = vi.fn();
    const setIsMigratingLegacySpy = vi.fn();
    const addLogSpy = vi.fn();

    // 2. Alice is active
    setActiveAccount('perm_alice_wf');
    const targetAccountId = 'perm_alice_wf';
    const migrationSessionId = getActiveAccountSessionId();

    // 3. Controlled migration promise to simulate in-flight delay
    let resolveMigration!: (res: LegacyCacheImportResult) => void;
    const controlledMigrationPromise = new Promise<LegacyCacheImportResult>(resolve => {
      resolveMigration = resolve;
    });

    // 4. Launch the production workflow helper
    const workflowPromise = executeLegacyImportWorkflow({
      targetAccountId,
      migrationSessionId,
      getActiveAccountId,
      getActiveAccountSessionId,
      importLegacyCache: () => controlledMigrationPromise,
      refreshLocalData: refreshLocalDataSpy,
      processQueue: processQueueSpy,
      setLegacyCacheInfo: setLegacyCacheInfoSpy,
      setIsMigratingLegacy: setIsMigratingLegacySpy,
      addLog: addLogSpy,
    });

    // Workflow started and set loading flag
    expect(setIsMigratingLegacySpy).toHaveBeenCalledWith(true);

    // 5. User switches account to Bob mid-migration
    setActiveAccount('perm_bob_wf');

    // 6. Resolve Alice's migration
    resolveMigration({ importedNotesCount: 2, importedJobsCount: 1, skippedNotesCount: 0 });

    // 7. Await workflow completion
    const completed = await workflowPromise;

    // Must return false indicating clean cancellation
    expect(completed).toBe(false);

    // Must NOT clear Bob's legacy cache banner
    expect(setLegacyCacheInfoSpy).not.toHaveBeenCalled();

    // Must NOT refresh local data
    expect(refreshLocalDataSpy).not.toHaveBeenCalled();

    // Must NOT trigger sync queue processing
    expect(processQueueSpy).not.toHaveBeenCalled();

    // Must NOT emit failure log
    const logCalls = addLogSpy.mock.calls.map(c => c[0]);
    expect(logCalls.some(m => m.includes('Legacy import failed'))).toBe(false);
  });

  // Test 49: getLocalDB caches connection but recovers from rejected open, respecting session boundaries
  it('49. getLocalDB recovers from failed database open on subsequent call and protects newer sessions', async () => {
    // Phase 1: Transient open failure recovers on subsequent attempt for same session
    setActiveAccount('perm_retry_open');
    const originalOpen = indexedDB.open.bind(indexedDB);

    let failNextOpen = true;
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
      if (name === 'kurippu_cache_perm_retry_open' && failNextOpen) {
        failNextOpen = false;
        throw new DOMException('Simulated transient disk/open error', 'UnknownError');
      }
      return originalOpen(name, version);
    });

    let recoveredDb: any = null;
    try {
      // First attempt rejects due to transient error
      await expect(getLocalDB('perm_retry_open')).rejects.toThrow();

      // Second attempt without account switch must NOT return the cached rejected promise;
      // it must re-attempt and succeed
      recoveredDb = await getLocalDB('perm_retry_open');
      expect(recoveredDb).toBeDefined();
      expect(recoveredDb.name).toBe('kurippu_cache_perm_retry_open');
    } finally {
      openSpy.mockRestore();
      if (recoveredDb) {
        try { recoveredDb.close(); } catch {}
      }
    }

    // Phase 2: Session isolation with controlled deferred open promise
    setActiveAccount('perm_alice_deferred');

    let rejectAliceOpen!: (err: Error) => void;
    const aliceDeferredGate = new Promise<never>((_, reject) => {
      rejectAliceOpen = reject;
    });

    setDbOpenWrapperForTesting(async doOpen => {
      if (getActiveAccountId() === 'perm_alice_deferred') {
        return aliceDeferredGate; // Alice stays pending
      }
      return doOpen(); // Bob opens normally
    });

    let bobDb: any = null;
    try {
      // Alice initiates getLocalDB (remains pending on aliceDeferredGate)
      const aliceOpenCall = getLocalDB('perm_alice_deferred');

      // User switches to Bob while Alice's call is in-flight
      setActiveAccount('perm_bob_deferred');
      bobDb = await getLocalDB('perm_bob_deferred');
      expect(bobDb.name).toBe('kurippu_cache_perm_bob_deferred');

      // Reject Alice's pending open only AFTER Bob's connection is established
      rejectAliceOpen(new DOMException('Alice deferred disk error', 'UnknownError'));

      // Alice's open call rejects cleanly
      await expect(aliceOpenCall).rejects.toThrow();

      // Verify Alice's failure did NOT change the active account
      expect(getActiveAccountId()).toBe('perm_bob_deferred');

      // Verify Alice's failure did NOT clear Bob's active connection
      const bobDbCached = await getLocalDB('perm_bob_deferred');
      expect(bobDbCached).toBe(bobDb);
    } finally {
      setDbOpenWrapperForTesting(null);
      if (bobDb) {
        try { bobDb.close(); } catch {}
      }
    }
  });

  // Test 50: Non-destructive inspection and safe handling of absent legacy database
  it('50. inspectLegacyCache and migration safely handle absent legacy database without mutating storage', async () => {
    const hasDatabasesSupport = typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function';
    const uniqueAbsentDbName = `kurippu_test_absent_${Date.now()}`;
    setLegacyDbNameForTesting(uniqueAbsentDbName);

    try {
      if (hasDatabasesSupport) {
        // Case A: When indexedDB.databases() is supported and confirms absent database
        let dbs = await indexedDB.databases();
        expect(dbs.some(d => d.name === uniqueAbsentDbName)).toBe(false);

        // 1. inspectLegacyCache when DB is absent
        const summary = await inspectLegacyCache();
        expect(summary.exists).toBe(false);
        expect(summary.notesCount).toBe(0);
        expect(summary.pendingJobsCount).toBe(0);
        expect(summary.noteTitles).toEqual([]);

        // Verify inspectLegacyCache did NOT create the database on disk
        dbs = await indexedDB.databases();
        expect(dbs.some(d => d.name === uniqueAbsentDbName)).toBe(false);

        // 2. importLegacyCacheToActiveAccount when DB is absent
        setActiveAccount('perm_dest_absent_legacy');
        await clearLocalDatabase();

        const migrationResult = await importLegacyCacheToActiveAccount('perm_dest_absent_legacy');
        expect(migrationResult.importedNotesCount).toBe(0);
        expect(migrationResult.importedJobsCount).toBe(0);
        expect(migrationResult.skippedNotesCount).toBe(0);

        // Verify migration did NOT create the database on disk
        dbs = await indexedDB.databases();
        expect(dbs.some(d => d.name === uniqueAbsentDbName)).toBe(false);

        // Verify destination partition remains empty
        const destNotes = await listNotesLocal('perm_dest_absent_legacy');
        expect(destNotes.length).toBe(0);
      }

      // Case B: In an environment where indexedDB.databases() is unavailable
      setLegacyDatabaseExistenceCheckerForTesting(async () => 'unsupported');

      // Passive inspection must remain conservative and return exists: false
      const unsuppSummary = await inspectLegacyCache();
      expect(unsuppSummary.exists).toBe(false);

      // Active migration must NOT silently create an empty database or report a successful no-op;
      // it must throw LegacyDatabaseUnavailableError
      setActiveAccount('perm_dest_unsupported_legacy');
      await clearLocalDatabase();

      await expect(importLegacyCacheToActiveAccount('perm_dest_unsupported_legacy')).rejects.toThrow(
        LegacyDatabaseUnavailableError
      );

      // Verify destination partition remains completely empty
      const destNotes = await listNotesLocal('perm_dest_unsupported_legacy');
      expect(destNotes.length).toBe(0);

      // Case C: In an environment where indexedDB itself is completely unavailable/undefined
      setLegacyDatabaseExistenceCheckerForTesting(null);
      const originalIndexedDB = (globalThis as any).indexedDB;
      try {
        (globalThis as any).indexedDB = undefined;
        // Passive inspection returns exists: false
        const undefSummary = await inspectLegacyCache();
        expect(undefSummary.exists).toBe(false);

        // Active migration must throw LegacyDatabaseUnavailableError, NOT report a successful no-op
        await expect(importLegacyCacheToActiveAccount('perm_dest_unsupported_legacy')).rejects.toThrow(
          LegacyDatabaseUnavailableError
        );
      } finally {
        (globalThis as any).indexedDB = originalIndexedDB;
      }
    } finally {
      setLegacyDbNameForTesting(null);
      setLegacyDatabaseExistenceCheckerForTesting(null);
    }
  });

  // Test 51: Legacy database opening never upgrades existing version and surfaces open failures
  it('51. openExistingLegacyDB preserves existing database version and surfaces open failures', async () => {
    const isolatedLegacyDbName = `kurippu_test_legacy_version_${Date.now()}`;
    setLegacyDbNameForTesting(isolatedLegacyDbName);

    // 1. Create an isolated legacy database at version 1 with notes
    const setupDb = await openDB(isolatedLegacyDbName, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id' });
        }
      },
    });
    const testNote = createNote('legacy_ver_note_1', 'Version Preservation Note');
    await setupDb.put('notes', testNote);
    setupDb.close();

    let verifyDb1: any = null;
    let verifyDb2: any = null;
    try {
      // 2. Verify inspection does NOT upgrade version
      const summary = await inspectLegacyCache();
      expect(summary.exists).toBe(true);
      expect(summary.notesCount).toBe(1);

      // Verify version in IndexedDB remains exactly 1
      verifyDb1 = await openDB(isolatedLegacyDbName);
      expect(verifyDb1.version).toBe(1);
      verifyDb1.close();
      verifyDb1 = null;

      // 3. Verify active migration does NOT upgrade version
      setActiveAccount('perm_dest_ver_test');
      await clearLocalDatabase();

      const migrationResult = await importLegacyCacheToActiveAccount('perm_dest_ver_test');
      expect(migrationResult.importedNotesCount).toBe(1);

      // Verify version remains exactly 1 and notes store remains intact
      verifyDb2 = await openDB(isolatedLegacyDbName);
      expect(verifyDb2.version).toBe(1);
      const remainingNotes = await verifyDb2.getAll('notes');
      expect(remainingNotes.length).toBe(1);
      verifyDb2.close();
      verifyDb2 = null;

      // 4. Test disappearance race condition / open failure surfacing:
      // Configure existence checker to report true, but point to a database that was removed
      const disappearedDbName = `kurippu_test_disappeared_${Date.now()}`;
      setLegacyDbNameForTesting(disappearedDbName);
      setLegacyDatabaseExistenceCheckerForTesting(async () => true);

      // Inspection must surface the open failure (reject) because existence was confirmed
      await expect(inspectLegacyCache()).rejects.toThrow();

      // Migration must NOT silently report a successful no-op; it must surface the open failure
      setActiveAccount('perm_dest_race_test');
      await clearLocalDatabase();

      await expect(importLegacyCacheToActiveAccount('perm_dest_race_test')).rejects.toThrow();

      // Verify the disappeared database was not created with a valid schema version on disk
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        expect(dbs.some(d => d.name === disappearedDbName && (d.version ?? 0) > 0)).toBe(false);
      }
    } finally {
      if (verifyDb1) { try { verifyDb1.close(); } catch {} }
      if (verifyDb2) { try { verifyDb2.close(); } catch {} }
      try { await deleteDB(isolatedLegacyDbName); } catch {}
      setLegacyDbNameForTesting(null);
      setLegacyDatabaseExistenceCheckerForTesting(null);
    }
  });

  // Test 52: clearLocalDatabase with stale session ID rejects and preserves active account partition
  it('52. clearLocalDatabase with stale session ID rejects and preserves active account partition', async () => {
    // 1. Setup Alice's account and capture session
    setActiveAccount('perm_alice_clear_guard');
    const aliceSession = getActiveAccountSessionId();

    // 2. Switch to Bob and write data into Bob's partition
    setActiveAccount('perm_bob_clear_guard');
    await clearLocalDatabase();
    const bobNote = createNote('note_bob_protected', 'Protected Content in Bob Partition');
    await saveNoteLocal(bobNote);
    await enqueueOrCoalesceSyncJob({
      jobId: 'job_bob_protected',
      type: 'SAVE_NOTE',
      targetId: 'note_bob_protected',
      payload: bobNote,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    // Verify Bob has 1 note and 1 queue job
    expect((await listNotesLocal()).length).toBe(1);
    expect((await getAllQueueJobs()).length).toBe(1);

    // 3. Stale clear operation from Alice's session (passing aliceSession) must reject with StaleSessionError
    await expect(clearLocalDatabase(undefined, aliceSession)).rejects.toThrow(StaleSessionError);

    // 4. Stale clear operation explicitly referencing perm_alice and aliceSession must also reject
    await expect(clearLocalDatabase('perm_alice_clear_guard', aliceSession)).rejects.toThrow();

    // 5. Verify Bob's partition data was NOT cleared and remains completely intact
    const remainingNotes = await listNotesLocal();
    expect(remainingNotes.length).toBe(1);
    expect(remainingNotes[0].id).toBe('note_bob_protected');
    const remainingJobs = await getAllQueueJobs();
    expect(remainingJobs.length).toBe(1);
    expect(remainingJobs[0].targetId).toBe('note_bob_protected');
  });

  // Test 53: Deleting a note reconciles against remote manifest and preserves remote additions from other devices
  it('53. Deleting a note reconciles against remote manifest and preserves remote additions from other devices', async () => {
    const accountId = 'perm_manifest_del_device_a';
    setActiveAccount(accountId);
    await clearLocalDatabase();
    const adapter = new MockDriveAdapter(accountId, 'token_shared_dev');
    const engineA = new SyncEngine(adapter, accountId);

    try {
      // 1. Initial state: Note 1 created and synced to Drive
      const note1 = createNote('note_dev_a_1', 'Device A Note 1 Content');
      note1.contentHash = await computeContentHash(note1.content);
      await saveNoteLocal(note1);
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_create_note1',
        type: 'SAVE_NOTE',
        targetId: note1.id,
        payload: note1,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      await engineA.processQueue();

      const folderInfo = await adapter.discoverOrCreateAppFolders();
      const initialRemoteManifest = await adapter.getManifest(folderInfo);
      expect(initialRemoteManifest?.manifest.notes['note_dev_a_1']).toBeDefined();

      // 2. Simulate Device B: adds Note 2 and a branch directly to remote Drive
      const note2 = createNote('note_dev_b_2', 'Device B Note 2 Content');
      note2.contentHash = await computeContentHash(note2.content);
      const saveNote2Res = await adapter.saveNote(note2, folderInfo);

      const remoteManifestWithB = initialRemoteManifest!.manifest;
      remoteManifestWithB.notes['note_dev_b_2'] = {
        id: note2.id,
        title: note2.title,
        type: note2.type,
        attributes: [],
        contentHash: note2.contentHash,
        driveFileId: saveNote2Res.fileId,
        updatedAt: new Date().toISOString(),
        isDeleted: false,
      };
      remoteManifestWithB.branches = [
        {
          branchId: 'branch_b_feature',
          noteId: 'note_dev_b_2',
          parentNoteId: 'root',
          position: 1,
        },
      ];
      remoteManifestWithB.revisionSequence = (remoteManifestWithB.revisionSequence || 1) + 1;
      await adapter.saveManifest(folderInfo, remoteManifestWithB);

      // Verify remote manifest now has Note 1 and Note 2
      const remoteBeforeDelete = await adapter.getManifest(folderInfo);
      expect(remoteBeforeDelete?.manifest.notes['note_dev_b_2']).toBeDefined();
      expect(remoteBeforeDelete?.manifest.branches?.length).toBe(1);

      // Verify Device A still has a stale local manifest that only knows about Note 1
      const staleLocalManifest = await getManifestLocal();
      expect(staleLocalManifest?.notes['note_dev_b_2']).toBeUndefined();

      // 3. Device A deletes Note 1
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_delete_note1',
        type: 'DELETE_NOTE',
        targetId: 'note_dev_a_1',
        payload: note1,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      await engineA.processQueue();

      // 4. Assert that Device B's Note 2 and its branch survived the deletion in remote manifest!
      const remoteAfterDelete = await adapter.getManifest(folderInfo);
      expect(remoteAfterDelete).toBeDefined();
      expect(remoteAfterDelete!.manifest.notes['note_dev_a_1']?.isDeleted).toBe(true);
      expect(remoteAfterDelete!.manifest.notes['note_dev_b_2']).toBeDefined();
      expect(remoteAfterDelete!.manifest.notes['note_dev_b_2']?.title).toBe('Note note_dev_b_2');
      expect(remoteAfterDelete!.manifest.notes['note_dev_b_2']?.isDeleted).toBeFalsy();
      expect(remoteAfterDelete!.manifest.branches?.some(b => b.noteId === 'note_dev_b_2')).toBe(true);

      // 5. Assert that Device A's local manifest was updated with Device B's changes
      const updatedLocalManifest = await getManifestLocal();
      expect(updatedLocalManifest?.notes['note_dev_b_2']).toBeDefined();
      expect(updatedLocalManifest?.notes['note_dev_a_1']?.isDeleted).toBe(true);
    } finally {
      engineA.stopAutoPoll();
      await clearLocalDatabase();
      setActiveAccount('test_default');
    }
  });

  // Test 54: Remote manifest retrieval or saving failure leaves delete job retryable without overwriting remote state
  it('54. Remote manifest retrieval or saving failure leaves delete job retryable without overwriting remote state', async () => {
    const accountId = 'perm_del_fail_retry';
    setActiveAccount(accountId);
    await clearLocalDatabase();
    const adapter = new MockDriveAdapter(accountId, 'token_fail_retry');
    const engine = new SyncEngine(adapter, accountId);

    try {
      // Setup Note 1 and Note 2 on Drive
      const note1 = createNote('note_retry_1', 'Retry Note 1');
      note1.contentHash = await computeContentHash(note1.content);
      await saveNoteLocal(note1);
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_create_r1',
        type: 'SAVE_NOTE',
        targetId: note1.id,
        payload: note1,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
      await engine.processQueue();

      const folderInfo = await adapter.discoverOrCreateAppFolders();
      // Add Note 2 to remote Drive
      const note2 = createNote('note_retry_2', 'Remote Note 2 Survives');
      note2.contentHash = await computeContentHash(note2.content);
      await adapter.saveNote(note2, folderInfo);
      const manifest = (await adapter.getManifest(folderInfo))!.manifest;
      manifest.notes['note_retry_2'] = {
        id: note2.id,
        title: note2.title,
        type: note2.type,
        attributes: [],
        contentHash: note2.contentHash,
        updatedAt: new Date().toISOString(),
        isDeleted: false,
      };
      await adapter.saveManifest(folderInfo, manifest);

      // Enqueue DELETE_NOTE for Note 1
      await enqueueOrCoalesceSyncJob({
        jobId: 'job_delete_retry_1',
        type: 'DELETE_NOTE',
        targetId: 'note_retry_1',
        payload: note1,
        clientTimestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });

      // 1. Simulate network failure during remote manifest retrieval
      adapter.onBeforeGetManifest = () => {
        throw new Error('Network error: simulated getManifest failure');
      };
      await engine.processQueue();

      // Remote manifest must NOT have been overwritten or mutated
      adapter.onBeforeGetManifest = undefined;
      const remoteAfterFailedGet = await adapter.getManifest(folderInfo);
      expect(remoteAfterFailedGet?.manifest.notes['note_retry_2']).toBeDefined();
      expect(remoteAfterFailedGet?.manifest.notes['note_retry_1']?.isDeleted).toBeFalsy();

      // Delete job must remain retryable in queue
      let jobs = await getAllQueueJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].type).toBe('DELETE_NOTE');
      expect(jobs[0].status).toBe('pending');

      // 2. Simulate partial failure: remote file deleted, but saveManifest fails
      let saveFailedOnce = false;
      adapter.onBeforeSaveManifest = (m) => {
        if (!saveFailedOnce && m.notes['note_retry_1']?.isDeleted) {
          saveFailedOnce = true;
          throw new Error('Network error: simulated saveManifest failure');
        }
      };
      await engine.processQueue();

      // Verify remote note file was trashed, but manifest was not updated yet
      const file1 = Array.from(adapter.files.values()).find(f => f.appProperties['kurippuNoteId'] === 'note_retry_1');
      expect(file1?.trashed).toBe(true);

      jobs = await getAllQueueJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('pending');

      // 3. Retry when network recovers: already-deleted file handled idempotently, manifest tombstone saved
      adapter.onBeforeSaveManifest = undefined;
      await engine.processQueue();

      expect((await getAllQueueJobs()).length).toBe(0);
      const finalRemoteManifest = await adapter.getManifest(folderInfo);
      expect(finalRemoteManifest?.manifest.notes['note_retry_1']?.isDeleted).toBe(true);
      expect(finalRemoteManifest?.manifest.notes['note_retry_2']).toBeDefined();
    } finally {
      adapter.onBeforeGetManifest = undefined;
      adapter.onBeforeSaveManifest = undefined;
      engine.stopAutoPoll();
      await clearLocalDatabase();
      setActiveAccount('test_default');
    }
  });

  // Test 55: Activating the same account repeatedly is idempotent and preserves in-flight operations
  it('55. Activating the same account repeatedly is idempotent and preserves in-flight operations', async () => {
    const accountId = 'perm_idemp_acc';
    setActiveAccount(accountId);
    const session1 = getActiveAccountSessionId();

    // 1. Repeated calls with the same account ID must not change the session ID
    setActiveAccount(accountId);
    expect(getActiveAccountSessionId()).toBe(session1);
    setActiveAccount(accountId);
    expect(getActiveAccountSessionId()).toBe(session1);

    // 2. Open DB connection and verify subsequent activation does not close or invalidate it
    const db = await getLocalDB(accountId, session1);
    expect(db).toBeDefined();

    setActiveAccount(accountId);
    expect(getActiveAccountSessionId()).toBe(session1);

    // 3. Write operation using session1 succeeds without StaleSessionError
    const testNote = createNote('note_idemp_write', 'Idempotent Activation Note');
    await saveNoteLocal(testNote, accountId, session1);
    const loadedNote = await getNoteLocal('note_idemp_write', accountId, session1);
    expect(loadedNote?.title).toBe('Note note_idemp_write');

    // 4. Repeated activation while database is opening preserves pending promise and session
    const openAccount = 'perm_idemp_inflight';
    setActiveAccount(openAccount);
    const openSession = getActiveAccountSessionId();

    const pendingOpen = getLocalDB(openAccount, openSession);
    setActiveAccount(openAccount);
    expect(getActiveAccountSessionId()).toBe(openSession);

    const openedDb = await pendingOpen;
    expect(openedDb).toBeDefined();

    await clearLocalDatabase();
    setActiveAccount('test_default');
  });

  // Test 56: Switching A -> B -> A invalidates previous sessions and prevents stale session writes
  it('56. Switching A -> B -> A invalidates previous sessions and prevents stale session writes', async () => {
    // 1. Account A - Session 1
    setActiveAccount('perm_aba_alice');
    const aliceSession1 = getActiveAccountSessionId();
    await clearLocalDatabase();

    // 2. Switch to Account B - Session 2
    setActiveAccount('perm_aba_bob');
    const bobSession = getActiveAccountSessionId();
    expect(bobSession).toBeGreaterThan(aliceSession1);

    // Stale operations from Alice's session 1 must reject with StaleSessionError
    await expect(getLocalDB('perm_aba_alice', aliceSession1)).rejects.toThrow(StaleSessionError);
    await expect(getLocalDB(undefined, aliceSession1)).rejects.toThrow(StaleSessionError);
    // Accessing Alice's partition while Bob is active without passing expectedSessionId rejects with AccountMismatchError
    await expect(getLocalDB('perm_aba_alice')).rejects.toThrow(AccountMismatchError);

    // 3. Switch back to Account A - Session 3
    setActiveAccount('perm_aba_alice');
    const aliceSession2 = getActiveAccountSessionId();
    expect(aliceSession2).toBeGreaterThan(bobSession);

    // 4. Operations from original Alice Session 1 MUST reject because session advanced
    const staleNote = createNote('note_alice_stale', 'Stale session write attempt');
    await expect(saveNoteLocal(staleNote, 'perm_aba_alice', aliceSession1)).rejects.toThrow(StaleSessionError);
    await expect(clearLocalDatabase('perm_aba_alice', aliceSession1)).rejects.toThrow(StaleSessionError);

    // 5. Valid operations under Alice Session 2 succeed
    const validNote = createNote('note_alice_valid', 'Valid session 2 write');
    await saveNoteLocal(validNote, 'perm_aba_alice', aliceSession2);
    const retrieved = await getNoteLocal('note_alice_valid', 'perm_aba_alice', aliceSession2);
    expect(retrieved?.title).toBe('Note note_alice_valid');

    await clearLocalDatabase();
    setActiveAccount('test_default');
  });
});
