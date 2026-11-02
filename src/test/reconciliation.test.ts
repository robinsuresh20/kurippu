import { describe, it, expect } from 'vitest';
import { reconstructManifestFromNotes } from '../lib/storage/reconciliation';
import { NoteDocument } from '../types/storage';

describe('Manifest Reconciliation Scanner', () => {
  it('rebuilds a complete manifest and branch topology from individual self-describing notes', async () => {
    const notes: NoteDocument[] = [
      {
        id: 'note_root_doc',
        schemaVersion: 1,
        title: 'Project Overview',
        type: 'text',
        branches: [{ parentNoteId: 'root', position: 0 }],
        attributes: [{ type: 'label', name: 'status', value: 'active' }],
        content: { type: 'doc', content: [{ type: 'paragraph', text: 'Overview text' }] },
        plainTextPreview: 'Overview text',
        outlinks: [],
        attachmentIds: [],
        contentHash: 'hash_overview',
        createdAt: '2026-11-02T10:00:00.000Z',
        updatedAt: '2026-11-02T10:00:00.000Z',
        revisionId: 'rev_1',
        clientTimestamp: Date.now(),
        isDeleted: false,
      },
      {
        id: 'note_child_doc',
        schemaVersion: 1,
        title: 'Architecture Sub-Note',
        type: 'text',
        branches: [{ parentNoteId: 'note_root_doc', position: 0 }],
        attributes: [{ type: 'label', name: 'tech', value: 'typescript' }],
        content: { type: 'doc', content: [{ type: 'paragraph', text: 'Tech specs' }] },
        plainTextPreview: 'Tech specs',
        outlinks: ['note_root_doc'],
        attachmentIds: [],
        contentHash: 'hash_arch',
        createdAt: '2026-11-02T10:05:00.000Z',
        updatedAt: '2026-11-02T10:05:00.000Z',
        revisionId: 'rev_2',
        clientTimestamp: Date.now(),
        isDeleted: false,
      },
    ];

    const reconstructed = await reconstructManifestFromNotes(notes);

    expect(reconstructed.notes['note_root_doc']).toBeDefined();
    expect(reconstructed.notes['note_child_doc']).toBeDefined();
    expect(reconstructed.notes['note_root_doc'].title).toBe('Project Overview');
    expect(reconstructed.notes['note_child_doc'].title).toBe('Architecture Sub-Note');

    // Branch topology reconstruction verification
    const rootBranch = reconstructed.branches.find(b => b.noteId === 'note_root_doc');
    const childBranch = reconstructed.branches.find(b => b.noteId === 'note_child_doc');

    expect(rootBranch?.parentNoteId).toBe('root');
    expect(childBranch?.parentNoteId).toBe('note_root_doc');
  });
});
