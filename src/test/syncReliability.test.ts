import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncEngine } from '../features/sync/syncEngine';
import { MockDriveAdapter } from '../lib/google-drive/mockDriveAdapter';
import {
  clearLocalDatabase,
  saveNoteLocal,
  listNotesLocal,
  getNoteLocal,
  enqueueOrCoalesceSyncJob,
  getPendingJobCount,
  getManifestLocal,
} from '../lib/indexeddb/cache';
import { NoteDocument, ApplicationManifest, DriveFolderInfo } from '../types/storage';
import { useAuthStore } from '../features/auth/authStore';
import { setClientDeviceIdForTesting } from '../lib/storage/deviceId';
import { computeContentHash } from '../lib/storage/hash';

describe('Google Drive Sync Reliability & Idempotency Tests', () => {
  let adapter: MockDriveAdapter;
  let syncEngine: SyncEngine;

  beforeEach(async () => {
    setClientDeviceIdForTesting('test_device_default');
    await clearLocalDatabase();
    adapter = new MockDriveAdapter();
    syncEngine = new SyncEngine(adapter);
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
    await clearLocalDatabase();
    const freshEngine = new SyncEngine(adapter);

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
});
