import { NoteDocument, ApplicationManifest, NoteHeader, BranchRecord } from '../../types/storage';
import { computeContentHash } from './hash';

export async function reconstructManifestFromNotes(
  notes: NoteDocument[],
  workspaceId = 'default',
  rootNoteId = 'root'
): Promise<ApplicationManifest> {
  const reconstructedNotes: Record<string, NoteHeader> = {};
  const reconstructedBranches: BranchRecord[] = [];

  for (const note of notes) {
    const hash = note.contentHash || (await computeContentHash(note.content));
    reconstructedNotes[note.id] = {
      id: note.id,
      title: note.title,
      type: note.type,
      icon: note.icon,
      attributes: note.attributes || [],
      contentHash: hash,
      driveFileId: note.driveFileId,
      driveVersion: note.baseDriveVersion,
      updatedAt: note.updatedAt || new Date().toISOString(),
      isDeleted: note.isDeleted ?? false,
      deletedAt: note.deletedAt,
    };

    if (note.branches && note.branches.length > 0) {
      for (const branch of note.branches) {
        reconstructedBranches.push({
          branchId: `${branch.parentNoteId}_${note.id}`,
          noteId: note.id,
          parentNoteId: branch.parentNoteId,
          position: branch.position,
          prefix: branch.prefix,
        });
      }
    } else {
      // Default to root if no branch specified
      reconstructedBranches.push({
        branchId: `root_${note.id}`,
        noteId: note.id,
        parentNoteId: rootNoteId,
        position: 0,
      });
    }
  }

  return {
    schemaVersion: 1,
    workspaceId,
    rootNoteId,
    lastModified: new Date().toISOString(),
    revisionSequence: 1,
    notes: reconstructedNotes,
    branches: reconstructedBranches,
  };
}
