import { nanoid } from 'nanoid';
import { NoteDocument } from '../../types/storage';
import { computeContentHash } from '../storage/hash';

export interface ConflictResolution {
  forkedConflictNote: NoteDocument;
  actionTaken: 'FORKED_CONFLICT_NOTE' | 'NO_CONFLICT_IDENTICAL';
}

export async function resolveNoteConflict(
  localNote: NoteDocument,
  remoteNote: NoteDocument,
  deviceName = 'Device'
): Promise<ConflictResolution> {
  const localHash = localNote.contentHash || (await computeContentHash(localNote.content));
  const remoteHash = remoteNote.contentHash || (await computeContentHash(remoteNote.content));

  if (localHash === remoteHash) {
    return {
      forkedConflictNote: localNote,
      actionTaken: 'NO_CONFLICT_IDENTICAL',
    };
  }

  // Generate a distinct timestamp string for clarity
  const timestampStr = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const forkedId = nanoid(21);
  const forkedTitle = `${localNote.title} (Conflict Copy - ${deviceName} - ${timestampStr})`;

  const forkedConflictNote: NoteDocument = {
    ...localNote,
    id: forkedId,
    title: forkedTitle,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revisionId: nanoid(),
    baseRevisionId: remoteNote.revisionId,
    baseDriveVersion: remoteNote.baseDriveVersion,
    clientTimestamp: Date.now(),
    driveFileId: undefined, // New Drive file will be created
    branches: localNote.branches.map(b => ({
      ...b,
      position: b.position + 1, // Place right after original
    })),
    attributes: [
      ...localNote.attributes,
      { type: 'label', name: 'conflict', value: 'unresolved' },
      { type: 'relation', name: 'conflictOf', value: localNote.id },
    ],
  };

  forkedConflictNote.contentHash = await computeContentHash(forkedConflictNote.content);

  return {
    forkedConflictNote,
    actionTaken: 'FORKED_CONFLICT_NOTE',
  };
}
