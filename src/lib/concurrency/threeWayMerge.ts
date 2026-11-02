import { ApplicationManifest, NoteHeader, BranchRecord } from '../../types/storage';

export interface MergeResult {
  mergedManifest: ApplicationManifest;
  conflictNotes: string[];
  resurrectedNotes: string[];
  warnings: string[];
}

export function threeWayManifestMerge(
  base: ApplicationManifest,
  local: ApplicationManifest,
  remote: ApplicationManifest
): MergeResult {
  const conflictNotes: string[] = [];
  const resurrectedNotes: string[] = [];
  const warnings: string[] = [];

  const mergedNotes: Record<string, NoteHeader> = {};
  const allNoteIds = new Set<string>([
    ...Object.keys(base.notes || {}),
    ...Object.keys(local.notes || {}),
    ...Object.keys(remote.notes || {}),
  ]);

  for (const id of allNoteIds) {
    const bNote = base.notes?.[id];
    const lNote = local.notes?.[id];
    const rNote = remote.notes?.[id];

    // Case 1: Added only locally
    if (!bNote && lNote && !rNote) {
      mergedNotes[id] = { ...lNote };
      continue;
    }

    // Case 2: Added only remotely
    if (!bNote && !lNote && rNote) {
      mergedNotes[id] = { ...rNote };
      continue;
    }

    // Case 3: Added concurrently on both sides
    if (!bNote && lNote && rNote) {
      if (lNote.contentHash === rNote.contentHash) {
        mergedNotes[id] = { ...lNote };
      } else {
        conflictNotes.push(id);
        warnings.push(`Note ${id} created concurrently with divergent contents.`);
        // Local takes precedence for header, but preserve remote attributes
        mergedNotes[id] = {
          ...lNote,
          attributes: mergeAttributes(lNote.attributes, rNote.attributes),
          updatedAt: new Date(Math.max(Date.parse(lNote.updatedAt || '0'), Date.parse(rNote.updatedAt || '0'))).toISOString(),
        };
      }
      continue;
    }

    // At this point, bNote exists
    if (bNote) {
      // Case 4: Deleted in both
      if ((!lNote || lNote.isDeleted) && (!rNote || rNote.isDeleted)) {
        if (lNote || rNote) {
          const sample = lNote || rNote!;
          mergedNotes[id] = { ...sample, isDeleted: true };
        }
        continue;
      }

      // Case 5: Deleted locally, but modified remotely -> PRESERVATION WINS
      if ((!lNote || lNote.isDeleted) && rNote && !rNote.isDeleted) {
        if (rNote.contentHash !== bNote.contentHash || rNote.updatedAt !== bNote.updatedAt) {
          resurrectedNotes.push(id);
          warnings.push(`Note "${rNote.title}" was deleted locally but updated remotely; resurrecting.`);
          mergedNotes[id] = { ...rNote, isDeleted: false };
        } else {
          // Clean deletion: remote didn't modify it
          mergedNotes[id] = { ...(lNote || bNote), isDeleted: true };
        }
        continue;
      }

      // Case 6: Deleted remotely, but modified locally -> PRESERVATION WINS
      if (lNote && !lNote.isDeleted && (!rNote || rNote.isDeleted)) {
        if (lNote.contentHash !== bNote.contentHash || lNote.updatedAt !== bNote.updatedAt) {
          resurrectedNotes.push(id);
          warnings.push(`Note "${lNote.title}" was deleted remotely but modified locally; preserving.`);
          mergedNotes[id] = { ...lNote, isDeleted: false };
        } else {
          mergedNotes[id] = { ...(rNote || bNote), isDeleted: true };
        }
        continue;
      }

      // Case 7: Both modified or active
      if (lNote && rNote) {
        const localModified = lNote.contentHash !== bNote.contentHash || lNote.updatedAt !== bNote.updatedAt;
        const remoteModified = rNote.contentHash !== bNote.contentHash || rNote.updatedAt !== bNote.updatedAt;

        if (localModified && !remoteModified) {
          mergedNotes[id] = { ...lNote };
        } else if (!localModified && remoteModified) {
          mergedNotes[id] = { ...rNote };
        } else if (!localModified && !remoteModified) {
          mergedNotes[id] = { ...lNote };
        } else {
          // Both modified!
          if (lNote.contentHash !== rNote.contentHash) {
            conflictNotes.push(id);
            warnings.push(`Concurrent modifications on note "${lNote.title}".`);
          }
          // Merge attributes, take latest title, update timestamp
          const chosenTitle = Date.parse(lNote.updatedAt || '0') >= Date.parse(rNote.updatedAt || '0') ? lNote.title : rNote.title;
          mergedNotes[id] = {
            ...lNote,
            title: chosenTitle,
            attributes: mergeAttributes(lNote.attributes, rNote.attributes),
            contentHash: lNote.contentHash, // local content active; conflict forking handles file body
            updatedAt: new Date(Math.max(Date.parse(lNote.updatedAt || '0'), Date.parse(rNote.updatedAt || '0'))).toISOString(),
          };
        }
      }
    }
  }

  // Branch Hierarchy Merge (Multi-Parent DAG Preservation)
  const mergedBranches = mergeBranches(base.branches || [], local.branches || [], remote.branches || []);

  const mergedManifest: ApplicationManifest = {
    schemaVersion: Math.max(base.schemaVersion || 1, local.schemaVersion || 1, remote.schemaVersion || 1),
    workspaceId: local.workspaceId || base.workspaceId || 'default',
    rootNoteId: local.rootNoteId || base.rootNoteId || 'root',
    lastModified: new Date().toISOString(),
    revisionSequence: Math.max(base.revisionSequence || 0, local.revisionSequence || 0, remote.revisionSequence || 0) + 1,
    notes: mergedNotes,
    branches: mergedBranches,
  };

  return {
    mergedManifest,
    conflictNotes,
    resurrectedNotes,
    warnings,
  };
}

function mergeAttributes(localAttrs: any[] = [], remoteAttrs: any[] = []): any[] {
  const map = new Map<string, any>();
  for (const a of remoteAttrs) {
    map.set(`${a.type}_${a.name}`, a);
  }
  for (const a of localAttrs) {
    map.set(`${a.type}_${a.name}`, a);
  }
  return Array.from(map.values());
}

function mergeBranches(base: BranchRecord[], local: BranchRecord[], remote: BranchRecord[]): BranchRecord[] {
  const branchMap = new Map<string, BranchRecord>();

  // Helper key for branch identity: noteId + parentNoteId
  const keyOf = (b: BranchRecord) => `${b.noteId}->${b.parentNoteId}`;

  const localKeys = new Set(local.map(keyOf));
  const remoteKeys = new Set(remote.map(keyOf));

  // A base branch is kept ONLY if at least one side (local or remote) still contains it.
  // If neither side contains it, both sides deleted or moved away from it!
  for (const b of base) {
    const k = keyOf(b);
    if (localKeys.has(k) || remoteKeys.has(k)) {
      branchMap.set(k, b);
    }
  }

  // Apply remote changes
  for (const b of remote) {
    branchMap.set(keyOf(b), b);
  }

  // Apply local changes (multi-parent preservation preserves both if moved to different parents)
  for (const b of local) {
    branchMap.set(keyOf(b), b);
  }

  const branches = Array.from(branchMap.values());
  return preventCycles(branches);
}

function preventCycles(branches: BranchRecord[]): BranchRecord[] {
  // Construct parent adjacency: noteId -> list of parentNoteIds
  const parentMap = new Map<string, string[]>();
  for (const b of branches) {
    if (!parentMap.has(b.noteId)) {
      parentMap.set(b.noteId, []);
    }
    parentMap.get(b.noteId)!.push(b.parentNoteId);
  }

  // Detect if target is an ancestor of candidate
  const isAncestor = (ancestor: string, child: string, visited = new Set<string>()): boolean => {
    if (visited.has(child)) return false;
    visited.add(child);

    const parents = parentMap.get(child) || [];
    for (const p of parents) {
      if (p === ancestor) return true;
      if (p !== 'root' && isAncestor(ancestor, p, visited)) return true;
    }
    return false;
  };

  const safeBranches: BranchRecord[] = [];
  for (const b of branches) {
    // If moving child note to be parent of an existing ancestor, cycle detected!
    if (b.parentNoteId !== 'root' && isAncestor(b.noteId, b.parentNoteId)) {
      console.warn(`[ThreeWayMerge] Cycle detected: Note ${b.noteId} cannot have parent ${b.parentNoteId}. Fallback to root.`);
      safeBranches.push({ ...b, parentNoteId: 'root' });
    } else {
      safeBranches.push(b);
    }
  }

  return safeBranches;
}
