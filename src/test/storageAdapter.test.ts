import { describe, it, expect, beforeEach } from 'vitest';
import { MockDriveAdapter } from '../lib/google-drive/mockDriveAdapter';
import { NoteDocument } from '../types/storage';

describe('Drive Storage Adapter & Folder Discovery', () => {
  let adapter: MockDriveAdapter;

  beforeEach(() => {
    adapter = new MockDriveAdapter();
  });

  it('discovers or creates root and notes folders using private appProperties', async () => {
    const folders1 = await adapter.discoverOrCreateAppFolders();
    expect(folders1.rootFolderId).toBeDefined();
    expect(folders1.notesFolderId).toBeDefined();

    // Verify root folder has proper appProperties
    const rootFile = adapter.files.get(folders1.rootFolderId);
    expect(rootFile?.appProperties['kurippuRole']).toBe('root');

    // Second call should rediscover existing folders without creating duplicates
    const folders2 = await adapter.discoverOrCreateAppFolders();
    expect(folders2.rootFolderId).toBe(folders1.rootFolderId);
    expect(folders2.notesFolderId).toBe(folders1.notesFolderId);
  });

  it('rediscovers root folder even if user renames the folder in Drive', async () => {
    const folders1 = await adapter.discoverOrCreateAppFolders();
    // User renames folder externally
    const rootFile = adapter.files.get(folders1.rootFolderId)!;
    rootFile.name = 'My Personal Renamed Wiki';

    // Discovery must still find it via appProperties
    const folders2 = await adapter.discoverOrCreateAppFolders();
    expect(folders2.rootFolderId).toBe(folders1.rootFolderId);
  });

  it('saves and reads self-describing notes with incremental version tracking', async () => {
    const folders = await adapter.discoverOrCreateAppFolders();

    const note: NoteDocument = {
      id: 'test_note_123',
      schemaVersion: 1,
      title: 'First Note',
      type: 'text',
      branches: [{ parentNoteId: 'root', position: 0 }],
      attributes: [],
      content: { type: 'doc', content: [{ type: 'paragraph', text: 'Hello World' }] },
      plainTextPreview: 'Hello World',
      outlinks: [],
      attachmentIds: [],
      contentHash: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revisionId: 'r1',
      clientTimestamp: Date.now(),
      isDeleted: false,
    };

    // First save: version 1
    const save1 = await adapter.saveNote(note, folders);
    expect(save1.version).toBe(1);
    expect(save1.fileId).toBeDefined();

    // Second save: version increments to 2
    note.content.content[0].text = 'Hello World Edited';
    const save2 = await adapter.saveNote(note, folders);
    expect(save2.version).toBe(2);
    expect(save2.fileId).toBe(save1.fileId);

    // Read back
    const fetched = await adapter.getNote('test_note_123', folders);
    expect(fetched).not.toBeNull();
    expect(fetched?.version).toBe(2);
    expect(fetched?.note.content.content[0].text).toBe('Hello World Edited');
  });

  it('handles simulated network offline errors cleanly', async () => {
    const folders = await adapter.discoverOrCreateAppFolders();
    adapter.networkConnected = false;

    await expect(adapter.listDriveNotes(folders)).rejects.toThrow('Network error: Device is offline');
  });
});
