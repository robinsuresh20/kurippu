# Google Drive Storage Design, Concurrency & Data Integrity

## 1. Core Persistence Philosophy & Engineering Realities

In Kurippu, **Google Drive is the authoritative cloud storage system**, while client-side storage (IndexedDB) acts as an **offline-first staging buffer and high-speed read cache**.

### Critical Realities of Distributed Cloud Storage:
1. **No Distributed Locks in Drive API v3**: Google Drive API v3 does **not** provide atomic compare-and-swap, distributed locking, or HTTP conditional updates (`If-Match`) on standard file contents. Preflight version checks narrow the collision window but **cannot prevent race conditions**: two browser tabs or devices can read file `version 4` at the same time, make concurrent modifications, and both send writes. The second write will overwrite the first at the Drive storage layer.
2. **Conflict Preservation Over Overwrites**: Because silent overwrites must never destroy user work, Kurippu employs a **Conflict Forking & Sibling Preservation Strategy**. Whenever a potential collision or stale base is detected, the application creates a separate conflict branch/note rather than overwriting remote bytes.
3. **The Manifest is a Synchronized Index, Not an Unrecoverable Single Point of Failure**: `manifest.json` provides fast tree topology and search index hydration. However, every individual note file (`notes/<noteId>.json`) is **self-describing**. If the manifest is ever desynchronized, corrupted, or deleted, a reconciliation scanner can rebuild the manifest by aggregating individual note headers.
4. **Realistic Persistence Boundaries**: No client-side storage system can guarantee "zero data loss" or "100% recovery" under all hardware and OS failure modes. IndexedDB can fail due to storage quotas (`QuotaExceededError`), browser disk corruption, aggressive OS disk cleanup, or private browsing restrictions. `navigator.storage.persist()` is a browser request that reduces eviction probability, not an absolute guarantee.

---

## 2. Robust Folder & File Discovery via `appProperties`

### 2.1 Private Discovery via `appProperties`
Rather than relying on human-readable folder names (which users can rename or relocate in Google Drive), Kurippu discovers its storage hierarchy through private `appProperties`. These key-value pairs are attached to Drive resources and are visible and queryable **only by this application under the authorized OAuth Client ID**.

```typescript
// Root Folder Metadata
{
  "name": "Kurippu Knowledge Base",
  "mimeType": "application/vnd.google-apps.folder",
  "appProperties": {
    "kurippuApp": "true",
    "kurippuRole": "root",
    "kurippuWorkspaceId": "default",
    "kurippuSchemaVersion": "1"
  }
}

// Manifest Metadata
{
  "name": "manifest.json",
  "mimeType": "application/json",
  "appProperties": {
    "kurippuApp": "true",
    "kurippuRole": "manifest",
    "kurippuWorkspaceId": "default"
  }
}

// Self-Describing Note Metadata
{
  "name": "01JF8X4Z7B9R.json",
  "mimeType": "application/json",
  "appProperties": {
    "kurippuApp": "true",
    "kurippuRole": "note",
    "kurippuNoteId": "01JF8X4Z7B9R",
    "kurippuWorkspaceId": "default"
  }
}
```

### 2.2 Discovery Query
To find the root folder on a clean browser or second device:
```http
GET /drive/v3/files?q=appProperties has { key='kurippuRole' and value='root' } and trashed=false&fields=files(id, name, appProperties)
```
If the root folder is moved into a subfolder or renamed by the user, this query still locates it reliably without creating redundant folders.

---

## 3. Data Schemas: Self-Describing Storage

### 3.1 Self-Describing Note Schema (`notes/<noteId>.json`)
Each note document contains all structural, relational, and cryptographic metadata needed to preserve its identity and reconstruct the hierarchy independently:

```typescript
export interface NoteDocument {
  id: string;                         // Nanoid (21 chars)
  schemaVersion: number;              // 1
  title: string;                      // Display title
  type: 'text' | 'code' | 'search';   // Note classification
  icon?: string;                      // Emoji or icon identifier
  
  /** Self-describing tree placement for reconstruction */
  branches: {
    parentNoteId: string;             // 'root' or ancestor noteId
    position: number;                 // Sibling sort index
    prefix?: string;                  // Clone title prefix
  }[];

  /** Semantic metadata */
  attributes: NoteAttribute[];        // Labels (#tag) and Relations (~rel)
  
  /** Content Payload */
  content: {
    type: 'doc';
    content: any[];                   // Tiptap / ProseMirror Document AST
  };

  /** Indexing, relationships & integrity */
  plainTextPreview: string;           // Plain text excerpt for search
  outlinks: string[];                 // Referenced target note IDs
  attachmentIds: string[];            // Referenced binary blob IDs
  contentHash: string;                // SHA-256 of canonical content AST

  /** Revision & Concurrency Auditing */
  createdAt: string;                  // ISO 8601
  updatedAt: string;                  // ISO 8601
  revisionId: string;                 // UUID generated on each edit commit
  baseRevisionId?: string;            // Revision ID this edit was based upon
  baseDriveVersion?: number;          // Remote Drive version at checkout
  clientTimestamp: number;            // Milliseconds epoch
  driveFileId?: string;               // Direct Drive file ID
  isDeleted: boolean;                 // Soft delete flag
  deletedAt?: string;
}

export interface NoteAttribute {
  type: 'label' | 'relation';
  name: string;
  value?: string;
  isInheritable?: boolean;
}
```

### 3.2 Application Manifest Schema (`manifest.json`)
```typescript
export interface ApplicationManifest {
  schemaVersion: number;
  workspaceId: string;
  rootNoteId: string;
  lastModified: string;
  revisionSequence: number;           // Monotonically increasing revision counter
  notes: Record<string, NoteHeader>;  // Map of noteId -> NoteHeader
  branches: BranchRecord[];
}

export interface NoteHeader {
  id: string;
  title: string;
  type: 'text' | 'code' | 'search';
  icon?: string;
  attributes: NoteAttribute[];
  contentHash: string;
  driveFileId: string;
  driveVersion?: number;
  updatedAt: string;
  isDeleted: boolean;
  deletedAt?: string;
  isFavorite?: boolean;
  isArchived?: boolean;
}

export interface BranchRecord {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  position: number;
  prefix?: string;
}
```

---

## 4. Concurrency & Conflict Strategy: Conflict Preservation

Because Drive API v3 provides no atomic locks, we implement **Conflict Preservation via Automatic Forking**:

```mermaid
flowchart TD
    Save[Initiate Note Save to Drive] --> Preflight[Fetch Remote File Metadata: version, modifiedTime, md5]
    Preflight --> CheckVer{Remote version > baseDriveVersion\nOR contentHash changed?}

    CheckVer -- No (Clean) --> DirectWrite[PATCH /upload/drive/v3/files/{id}\nUpdate baseDriveVersion]
    
    CheckVer -- Yes (Diverged) --> DownloadRemote[Download Remote Note Content]
    DownloadRemote --> CompareContent{Is local content identical\nto remote content?}
    
    CompareContent -- Yes (Identical) --> UpdateBase[Adopt Remote version\nNo action needed]
    CompareContent -- No (Different) --> ForkConflict[FORK CONFLICT NOTE\nCreate new note: 'Title (Conflict Copy)']
    
    ForkConflict --> SaveForkToDrive[Save Conflict Note to Drive & Manifest]
    SaveForkToDrive --> AlertUser[Display Visual Conflict Banner\nBoth copies preserved in tree]
```

### 4.1 How Conflict Forking Eliminates Lost Updates
If Client A and Client B both load Note 1 (`baseDriveVersion = 3`):
1. Client A updates Note 1. Drive sets Note 1 to `version 4`.
2. Client B tries to save Note 1. Preflight check reveals remote is at `version 4` (higher than Client B's base `3`).
3. Client B downloads the remote content. Because Client B's edits differ from Client A's edits, Client B **does not overwrite Note 1**.
4. Client B creates a sibling note: `"Note 1 (Conflict Copy - Device B - 2026-11-02 12:30)"` with a new unique ID, places it under the same parent branch, and saves it.
5. Both Client A's edits and Client B's edits exist safely side-by-side. The user is alerted with a non-intrusive conflict notification to review or merge them.

---

## 5. Formal Three-Way Manifest Merge Algorithm

To handle concurrent note tree modifications (creations, renames, moves, deletions) from multiple clients:

### 5.1 The Three States:
- **Base ($M_{base}$)**: The manifest snapshot at the time the client last synced.
- **Local ($M_{local}$)**: The client's current local manifest containing uncommitted offline or recent changes.
- **Remote ($M_{remote}$)**: The current manifest fetched from Google Drive.

### 5.2 Note Dictionary ($N$) Merge Rules:
For every note ID $k \in (N_{base} \cup N_{local} \cup N_{remote})$:

1. **Created Concurrently**:
   - $k \in N_{local} \setminus N_{base}$ and $k \in N_{remote} \setminus N_{base}$:
     - If both notes have the same ID (extremely rare due to Nanoid entropy) but differing content: Keep both by generating a new ID for the local note.
     - If IDs differ: Both notes are preserved in the merged manifest.
2. **Modified on One Side Only**:
   - $N_{local}[k] \neq N_{base}[k]$ and $N_{remote}[k] == N_{base}[k]$: Apply local modification.
   - $N_{local}[k] == N_{base}[k]$ and $N_{remote}[k] \neq N_{base}[k]$: Apply remote modification.
3. **Modified Concurrently on Both Sides**:
   - Both sides modified metadata for note $k$:
     - Title: If titles differ, retain local title and append remote title as alternate label `#alias`.
     - Attributes: Merge the attribute sets: $Attrs_{merged} = Attrs_{local} \cup Attrs_{remote}$ (union by key-value).
     - Timestamps: Set $updatedAt = \max(updatedAt_{local}, updatedAt_{remote})$.
4. **Deleted vs. Modified Concurrently**:
   - $k$ deleted in Local ($N_{local}[k].isDeleted == true$) but modified in Remote: **Preservation wins**. Resurrect note $k$ with remote modifications; move it to an `"Unorganized / Resurrected"` folder.
   - $k$ deleted in Remote but modified in Local: **Preservation wins**. Retain local note $k$ as active and clear remote deletion flag.

### 5.3 Branch Hierarchy Merge Rules:
1. **Concurrent Sibling Moves**:
   - If Local moved note $k$ to parent $P_1$ and Remote moved note $k$ to parent $P_2$:
     - **DAG Preservation**: Because Kurippu supports multi-parent branches (cloning), the note is assigned branches under **both** $P_1$ and $P_2$. The user can view the note in both locations without broken references.
2. **Cycle Prevention**:
   - Before applying any parent assignment $P \rightarrow C$, the merge engine runs a cycle detection DFS. If assigning parent $P$ creates a cycle ($C$ is an ancestor of $P$), the move is rejected, and note $C$ is placed under the root note with a warning notification.

---

## 6. Persistence Guarantees & Known Failure Modes

### 6.1 Accurate Persistence States:
- **`PERSISTED_LOCAL`**: Committed to IndexedDB.
- **`SYNC_QUEUED`**: Scheduled in `sync_queue` in IndexedDB.
- **`COMMITTED_REMOTE`**: Drive API returned HTTP 200/201.

### 6.2 Known Failure Modes & Engineering Mitigations:
1. **IndexedDB Transaction Aborts / Quota**:
   - If `QuotaExceededError` occurs, write-ahead commits fail. The app catches the error, displays an urgent modal: *"Browser storage full. Export backup immediately to prevent data loss"*, and disables editing until space is cleared.
2. **Browser Storage Eviction**:
   - `navigator.storage.persist()` is called on startup. If the browser grants persistent storage, eviction probability is minimized. However, private/incognito browsing or total OS disk depletion can still purge browser databases.
3. **Power Cut / Crash During Write**:
   - IndexedDB transactions are atomic: a write either completes or rolls back. An interrupted write never leaves a partially serialized JSON file in IndexedDB.
4. **Pending Sync Visibility**:
   - All pending changes are counted in real-time (`sync_queue.count()`). If the user attempts to close or reload the window while jobs are pending, a standard `beforeunload` browser prompt warns: *"You have unsynchronized changes that have not yet uploaded to Google Drive. Leave anyway?"*

---

## 7. Manifest Reconstruction & Recovery Protocol

If `manifest.json` is deleted or corrupted:
1. App queries Google Drive:
   ```http
   GET /drive/v3/files?q='{notesFolderId}' in parents and appProperties has { key='kurippuRole' and value='note' } and trashed=false
   ```
2. Iterates over note files and downloads headers.
3. Because each note is self-describing, the reconstruction algorithm parses `branches`, `title`, `attributes`, and `contentHash` from each note file.
4. Generates a fresh `manifest.json`, uploads it to Google Drive, and repopulates the local IndexedDB database.
