export interface NoteAttribute {
  type: 'label' | 'relation';
  name: string;
  value?: string;
  isInheritable?: boolean;
}

export interface NoteBranch {
  parentNoteId: string;
  position: number;
  prefix?: string;
}

export interface NoteDocument {
  id: string;
  schemaVersion: number;
  title: string;
  type: 'text' | 'code' | 'search';
  icon?: string;
  branches: NoteBranch[];
  attributes: NoteAttribute[];
  content: {
    type: 'doc';
    content: any[];
  };
  plainTextPreview: string;
  outlinks: string[];
  attachmentIds: string[];
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  revisionId: string;
  baseRevisionId?: string;
  baseDriveVersion?: number;
  clientTimestamp: number;
  driveFileId?: string;
  isDeleted: boolean;
  deletedAt?: string;
}

export interface BranchRecord {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  position: number;
  prefix?: string;
}

export interface NoteHeader {
  id: string;
  title: string;
  type: 'text' | 'code' | 'search';
  icon?: string;
  attributes: NoteAttribute[];
  contentHash: string;
  driveFileId?: string;
  driveVersion?: number;
  updatedAt: string;
  isDeleted: boolean;
  deletedAt?: string;
  isFavorite?: boolean;
  isArchived?: boolean;
}

export interface ApplicationManifest {
  schemaVersion: number;
  workspaceId: string;
  rootNoteId: string;
  lastModified: string;
  revisionSequence: number;
  notes: Record<string, NoteHeader>;
  branches: BranchRecord[];
}

export type SyncJobType = 'SAVE_NOTE' | 'SAVE_MANIFEST' | 'DELETE_NOTE';

export interface SyncJob {
  id?: number;
  jobId: string;
  type: SyncJobType;
  targetId: string;
  payload: any;
  clientTimestamp: number;
  retryCount: number;
  status: 'pending' | 'in_flight' | 'failed';
  lastError?: string;
}

export type PersistenceState =
  | 'IDLE'
  | 'PERSISTED_LOCAL'
  | 'SYNC_QUEUED'
  | 'SYNCING'
  | 'COMMITTED_REMOTE'
  | 'OFFLINE'
  | 'CONFLICT_DIVERGED'
  | 'ERROR';

export interface DriveFolderInfo {
  rootFolderId: string;
  notesFolderId: string;
  manifestFileId?: string;
}

export interface IStorageAdapter {
  discoverOrCreateAppFolders(): Promise<DriveFolderInfo>;
  getManifest(folderInfo: DriveFolderInfo): Promise<{ manifest: ApplicationManifest; version?: number } | null>;
  saveManifest(folderInfo: DriveFolderInfo, manifest: ApplicationManifest, baseVersion?: number): Promise<{ fileId: string; version: number }>;
  getNote(noteId: string, folderInfo: DriveFolderInfo): Promise<{ note: NoteDocument; version?: number } | null>;
  saveNote(note: NoteDocument, folderInfo: DriveFolderInfo): Promise<{ fileId: string; version: number; contentHash: string }>;
  listDriveNotes(folderInfo: DriveFolderInfo): Promise<{ fileId: string; name: string; appProperties?: Record<string, string>; version?: number }[]>;
  deleteNoteFile(fileId: string): Promise<void>;
}
