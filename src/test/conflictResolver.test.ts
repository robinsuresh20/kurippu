import { describe, it, expect } from 'vitest';
import { resolveNoteConflict } from '../lib/concurrency/conflictResolver';
import { NoteDocument } from '../types/storage';

describe('Conflict Resolver & Forking Strategy', () => {
  const createSampleNote = (id: string, text: string): NoteDocument => ({
    id,
    schemaVersion: 1,
    title: 'Design Ideas',
    type: 'text',
    branches: [{ parentNoteId: 'root', position: 0 }],
    attributes: [{ type: 'label', name: 'category', value: 'work' }],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', text }],
    },
    plainTextPreview: text,
    outlinks: [],
    attachmentIds: [],
    contentHash: '',
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    revisionId: 'rev_1',
    baseDriveVersion: 1,
    clientTimestamp: Date.now(),
    isDeleted: false,
  });

  it('detects identical content and avoids creating an unnecessary conflict note', async () => {
    const local = createSampleNote('note_1', 'Identical content across devices');
    const remote = createSampleNote('note_1', 'Identical content across devices');

    const result = await resolveNoteConflict(local, remote);
    expect(result.actionTaken).toBe('NO_CONFLICT_IDENTICAL');
    expect(result.forkedConflictNote.id).toBe('note_1');
  });

  it('forks a conflict note with unique ID, timestamped title, and conflict label when contents diverge', async () => {
    const local = createSampleNote('note_1', 'Local Device Edit: Add section 3');
    const remote = createSampleNote('note_1', 'Remote Device Edit: Changed paragraph 1');

    const result = await resolveNoteConflict(local, remote, 'Laptop');

    expect(result.actionTaken).toBe('FORKED_CONFLICT_NOTE');
    // Unique ID must not overwrite original note
    expect(result.forkedConflictNote.id).not.toBe('note_1');
    expect(result.forkedConflictNote.id.length).toBe(21);
    // Title must preserve original name and indicate conflict copy
    expect(result.forkedConflictNote.title).toContain('Design Ideas (Conflict Copy - Laptop');
    // Content of local edit is preserved in the forked copy
    expect(result.forkedConflictNote.content.content[0].text).toBe('Local Device Edit: Add section 3');
    // Conflict label and relation to original note are attached
    expect(result.forkedConflictNote.attributes.some(a => a.name === 'conflict' && a.value === 'unresolved')).toBe(true);
    expect(result.forkedConflictNote.attributes.some(a => a.name === 'conflictOf' && a.value === 'note_1')).toBe(true);
  });
});
