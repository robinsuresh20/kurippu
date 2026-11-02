import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine } from '../features/sync/syncEngine';
import { MockDriveAdapter } from '../lib/google-drive/mockDriveAdapter';
import {
  clearLocalDatabase,
  saveNoteLocal,
  enqueueSyncJob,
  getPendingJobCount,
  listNotesLocal,
} from '../lib/indexeddb/cache';
import { NoteDocument } from '../types/storage';

describe('Sync Engine & Write-Ahead Offline Persistence', () => {
  let adapter: MockDriveAdapter;
  let syncEngine: SyncEngine;

  beforeEach(async () => {
    await clearLocalDatabase();
    adapter = new MockDriveAdapter();
    syncEngine = new SyncEngine(adapter);
  });

  const createNote = (id: string, text: string, baseDriveVersion = 1): NoteDocument => ({
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
    baseDriveVersion,
    clientTimestamp: Date.now(),
    isDeleted: false,
  });

  it('buffers mutations in IndexedDB when offline and flushes cleanly on reconnection', async () => {
    // 1. Enter offline mode
    syncEngine.setOffline(true);

    const note1 = createNote('note_offline_1', 'Offline content 1');
    await saveNoteLocal(note1);
    await enqueueSyncJob({
      jobId: 'job_1',
      type: 'SAVE_NOTE',
      targetId: note1.id,
      payload: note1,
      clientTimestamp: Date.now(),
      retryCount: 0,
      status: 'pending',
    });

    const pendingOffline = await getPendingJobCount();
    expect(pendingOffline).toBe(1);

    // Verify it was NOT sent to Drive yet
    const folderInfo = await adapter.discoverOrCreateAppFolders();
    const driveNotePre = await adapter.getNote('note_offline_1', folderInfo);
    expect(driveNotePre).toBeNull();

    // 2. Reconnect online
    syncEngine.setOffline(false);
    await syncEngine.processQueue();

    // Verify job was processed and committed to Drive
    const pendingOnline = await getPendingJobCount();
    expect(pendingOnline).toBe(0);

    const driveNotePost = await adapter.getNote('note_offline_1', folderInfo);
    expect(driveNotePost).not.toBeNull();
    expect(driveNotePost?.note.content.content[0].text).toBe('Offline content 1');
  });

  it('detects concurrent stale version, preserves remote, and forks a conflict note', async () => {
    const folders = await adapter.discoverOrCreateAppFolders();

    // 1. Device A originally saved Note 1 at version 1
    const originalNote = createNote('note_concurrent', 'Base Text', 1);
    const firstSave = await adapter.saveNote(originalNote, folders);
    expect(firstSave.version).toBe(1);

    // 2. Device B modified Note 1 on Drive -> Drive version is now 2 with different text
    const remoteEdit: NoteDocument = {
      ...originalNote,
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Device B Text' }] },
    };
    const secondSave = await adapter.saveNote(remoteEdit, folders);
    expect(secondSave.version).toBe(2);

    // 3. Device A has uncommitted local edit based on version 1
    const localDivergent = createNote('note_concurrent', 'Device A Local Text', 1); // baseDriveVersion is 1!
    await saveNoteLocal(localDivergent);
    await enqueueSyncJob({
      jobId: 'job_divergent',
      type: 'SAVE_NOTE',
      targetId: localDivergent.id,
      payload: localDivergent,
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

    // 4. Process queue on Device A
    await syncEngine.processQueue();

    expect(conflictDetected).toBe(true);

    // 5. Verify Remote Note 1 content on Drive was NOT overwritten!
    const remoteNoteCheck = await adapter.getNote('note_concurrent', folders);
    expect(remoteNoteCheck?.note.content.content[0].text).toBe('Device B Text');

    // 6. Verify a conflict note copy exists in IndexedDB and on Drive
    const localNotes = await listNotesLocal();
    const conflictCopy = localNotes.find(n => n.id !== 'note_concurrent' && n.title.includes('Conflict Copy'));

    expect(conflictCopy).toBeDefined();
    expect(conflictCopy?.content.content[0].text).toBe('Device A Local Text');
  });
});
