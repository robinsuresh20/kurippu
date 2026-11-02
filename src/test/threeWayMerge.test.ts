import { describe, it, expect } from 'vitest';
import { threeWayManifestMerge } from '../lib/concurrency/threeWayMerge';
import { ApplicationManifest } from '../types/storage';

describe('Three-Way Manifest Merge Algorithm', () => {
  const createBaseManifest = (): ApplicationManifest => ({
    schemaVersion: 1,
    workspaceId: 'default',
    rootNoteId: 'root',
    lastModified: '2026-11-02T10:00:00.000Z',
    revisionSequence: 1,
    notes: {
      'note_1': {
        id: 'note_1',
        title: 'Note 1 Original',
        type: 'text',
        attributes: [{ type: 'label', name: 'status', value: 'draft' }],
        contentHash: 'hash_original_1',
        updatedAt: '2026-11-02T10:00:00.000Z',
        isDeleted: false,
      },
    },
    branches: [
      { branchId: 'root_note_1', noteId: 'note_1', parentNoteId: 'root', position: 0 },
    ],
  });

  it('merges non-overlapping concurrent note creations from both sides', () => {
    const base = createBaseManifest();
    const local = createBaseManifest();
    const remote = createBaseManifest();

    local.notes['note_local'] = {
      id: 'note_local',
      title: 'Local Created',
      type: 'text',
      attributes: [],
      contentHash: 'hash_local',
      updatedAt: '2026-11-02T10:05:00.000Z',
      isDeleted: false,
    };
    local.branches.push({ branchId: 'root_note_local', noteId: 'note_local', parentNoteId: 'root', position: 1 });

    remote.notes['note_remote'] = {
      id: 'note_remote',
      title: 'Remote Created',
      type: 'text',
      attributes: [],
      contentHash: 'hash_remote',
      updatedAt: '2026-11-02T10:06:00.000Z',
      isDeleted: false,
    };
    remote.branches.push({ branchId: 'root_note_remote', noteId: 'note_remote', parentNoteId: 'root', position: 2 });

    const result = threeWayManifestMerge(base, local, remote);

    expect(result.mergedManifest.notes['note_1']).toBeDefined();
    expect(result.mergedManifest.notes['note_local']).toBeDefined();
    expect(result.mergedManifest.notes['note_remote']).toBeDefined();
    expect(result.mergedManifest.branches.length).toBe(3);
    expect(result.mergedManifest.revisionSequence).toBe(2);
  });

  it('preserves a note that was deleted locally but updated remotely (resurrection/preservation wins)', () => {
    const base = createBaseManifest();
    const local = createBaseManifest();
    const remote = createBaseManifest();

    // Local deletes note_1
    local.notes['note_1'].isDeleted = true;

    // Remote updates note_1
    remote.notes['note_1'].title = 'Note 1 Remote Updated';
    remote.notes['note_1'].contentHash = 'hash_remote_updated';
    remote.notes['note_1'].updatedAt = '2026-11-02T10:10:00.000Z';

    const result = threeWayManifestMerge(base, local, remote);

    // Note 1 must be resurrected/active because preservation wins over accidental deletion
    expect(result.mergedManifest.notes['note_1'].isDeleted).toBe(false);
    expect(result.mergedManifest.notes['note_1'].title).toBe('Note 1 Remote Updated');
    expect(result.resurrectedNotes).toContain('note_1');
  });

  it('preserves a note that was deleted remotely but edited locally (preservation wins)', () => {
    const base = createBaseManifest();
    const local = createBaseManifest();
    const remote = createBaseManifest();

    // Remote deletes note_1
    remote.notes['note_1'].isDeleted = true;

    // Local updates note_1
    local.notes['note_1'].title = 'Note 1 Local Modified';
    local.notes['note_1'].contentHash = 'hash_local_updated';
    local.notes['note_1'].updatedAt = '2026-11-02T10:12:00.000Z';

    const result = threeWayManifestMerge(base, local, remote);

    expect(result.mergedManifest.notes['note_1'].isDeleted).toBe(false);
    expect(result.mergedManifest.notes['note_1'].title).toBe('Note 1 Local Modified');
    expect(result.resurrectedNotes).toContain('note_1');
  });

  it('preserves multi-parent DAG branches when both clients move the note to different parents', () => {
    const base = createBaseManifest();
    const local = createBaseManifest();
    const remote = createBaseManifest();

    // Base has folder_A and folder_B
    base.notes['folder_A'] = { id: 'folder_A', title: 'Folder A', type: 'text', attributes: [], contentHash: 'hA', updatedAt: '2026-11-02T10:00:00Z', isDeleted: false };
    base.notes['folder_B'] = { id: 'folder_B', title: 'Folder B', type: 'text', attributes: [], contentHash: 'hB', updatedAt: '2026-11-02T10:00:00Z', isDeleted: false };
    local.notes['folder_A'] = { ...base.notes['folder_A'] };
    local.notes['folder_B'] = { ...base.notes['folder_B'] };
    remote.notes['folder_A'] = { ...base.notes['folder_A'] };
    remote.notes['folder_B'] = { ...base.notes['folder_B'] };

    // Local moves note_1 into folder_A
    local.branches = [{ branchId: 'fA_note_1', noteId: 'note_1', parentNoteId: 'folder_A', position: 0 }];

    // Remote moves note_1 into folder_B
    remote.branches = [{ branchId: 'fB_note_1', noteId: 'note_1', parentNoteId: 'folder_B', position: 0 }];

    const result = threeWayManifestMerge(base, local, remote);

    // Multi-parent DAG preservation: Note 1 exists under both folder_A and folder_B!
    const note1Branches = result.mergedManifest.branches.filter(b => b.noteId === 'note_1');
    expect(note1Branches.length).toBe(2);
    expect(note1Branches.some(b => b.parentNoteId === 'folder_A')).toBe(true);
    expect(note1Branches.some(b => b.parentNoteId === 'folder_B')).toBe(true);
  });

  it('detects and breaks circular parent hierarchies', () => {
    const base = createBaseManifest();
    const local = createBaseManifest();
    const remote = createBaseManifest();

    // note_1 parent of note_2
    base.notes['note_2'] = { id: 'note_2', title: 'Note 2', type: 'text', attributes: [], contentHash: 'h2', updatedAt: '2026-11-02T10:00:00Z', isDeleted: false };
    local.notes['note_2'] = { ...base.notes['note_2'] };
    remote.notes['note_2'] = { ...base.notes['note_2'] };

    // Local sets note_2 parent to note_1
    local.branches = [{ branchId: 'n1_n2', noteId: 'note_2', parentNoteId: 'note_1', position: 0 }];

    // Remote sets note_1 parent to note_2 (which creates a cycle!)
    remote.branches = [{ branchId: 'n2_n1', noteId: 'note_1', parentNoteId: 'note_2', position: 0 }];

    const result = threeWayManifestMerge(base, local, remote);

    // Cycle must be broken: at least one branch falls back to root
    const rootBranches = result.mergedManifest.branches.filter(b => b.parentNoteId === 'root');
    expect(rootBranches.length).toBeGreaterThan(0);
  });
});
