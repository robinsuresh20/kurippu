import { openDB, DBSchema, IDBPDatabase, wrap } from 'idb';
import { NoteDocument, ApplicationManifest, SyncJob } from '../../types/storage';

export class AccountMismatchError extends Error {
  constructor(public requestedAccount: string, public activeAccount: string | null) {
    super(`Account partition mismatch: operation requested account "${requestedAccount}" but active account is "${activeAccount}".`);
    this.name = 'AccountMismatchError';
  }
}

export class StaleSessionError extends Error {
  constructor(public sessionAtStart: number, public currentSession: number) {
    super(`Stale session rejected: operation started under session ${sessionAtStart} but active session is now ${currentSession}.`);
    this.name = 'StaleSessionError';
  }
}

export class LegacyDatabaseUnavailableError extends Error {
  constructor(
    message = 'Legacy database existence cannot be safely established: indexedDB.databases() is unavailable in this environment.'
  ) {
    super(message);
    this.name = 'LegacyDatabaseUnavailableError';
  }
}

interface KurippuDBSchema extends DBSchema {
  notes: {
    key: string;
    value: NoteDocument;
  };
  manifest: {
    key: string;
    value: ApplicationManifest;
  };
  sync_queue: {
    key: number;
    value: SyncJob;
    indexes: { 'by_status': string };
  };
}

const DB_VERSION = 1;

let currentAccountId: string | null = null;
let activeDb: IDBPDatabase<KurippuDBSchema> | null = null;
let activeDbPromise: Promise<IDBPDatabase<KurippuDBSchema>> | null = null;
let currentSessionId = 0;

/**
 * Sets the active account partition for IndexedDB.
 * Closes the existing connection and resets the database promise.
 * Pass null when disconnected / logged out.
 */
export function setActiveAccount(accountId: string | null): void {
  if (currentAccountId === accountId) {
    return;
  }
  currentSessionId++;
  if (activeDb) {
    try {
      activeDb.close();
    } catch (err) {
      console.warn('[Cache] Error closing database connection:', err);
    }
    activeDb = null;
  }
  activeDbPromise = null;
  currentAccountId = accountId;
}

export function getActiveAccountId(): string | null {
  return currentAccountId;
}

export function getActiveAccountSessionId(): number {
  return currentSessionId;
}

// Test-injectable helpers for isolated testing without mutating real databases
const DEFAULT_LEGACY_DB_NAME = 'kurippu_local_cache';
let activeLegacyDbName = DEFAULT_LEGACY_DB_NAME;
let legacyDatabaseExistenceCheckerForTesting: ((dbName: string) => Promise<boolean | 'unsupported' | null>) | null = null;
let dbOpenWrapperForTesting: ((openFn: () => Promise<IDBPDatabase<KurippuDBSchema>>) => Promise<IDBPDatabase<KurippuDBSchema>>) | null = null;

export function setLegacyDbNameForTesting(name: string | null): void {
  activeLegacyDbName = name || DEFAULT_LEGACY_DB_NAME;
}

export function setLegacyDatabaseExistenceCheckerForTesting(
  checker: typeof legacyDatabaseExistenceCheckerForTesting
): void {
  legacyDatabaseExistenceCheckerForTesting = checker;
}

export function setDbOpenWrapperForTesting(wrapper: typeof dbOpenWrapperForTesting): void {
  dbOpenWrapperForTesting = wrapper;
}

/**
 * Opens existing legacy database without version upgrade or blank database creation.
 * If the database did not exist, the onupgradeneeded event fires with oldVersion === 0,
 * which is immediately aborted to prevent creating a blank database on disk.
 */
function openExistingLegacyDB(name: string): Promise<IDBPDatabase<KurippuDBSchema>> {
  return new Promise((resolve, reject) => {
    let upgradeTriggered = false;
    let isSettled = false;
    const req = indexedDB.open(name); // No version requested: opens current existing version

    req.onupgradeneeded = () => {
      upgradeTriggered = true;
      if (req.transaction) {
        try {
          req.transaction.abort();
        } catch {}
      }
    };

    req.onsuccess = () => {
      if (isSettled) {
        try {
          req.result.close();
        } catch {}
        return;
      }

      if (upgradeTriggered) {
        isSettled = true;
        try {
          req.result.close();
        } catch {}
        reject(new Error('Legacy database did not exist or required an upgrade'));
        return;
      }

      try {
        const wrapped = wrap(req.result) as IDBPDatabase<KurippuDBSchema>;
        isSettled = true;
        resolve(wrapped);
      } catch (err) {
        isSettled = true;
        try {
          req.result.close();
        } catch {}
        reject(err);
      }
    };

    req.onerror = () => {
      if (!isSettled) {
        isSettled = true;
        reject(req.error || new Error('Failed to open legacy database'));
      }
    };

    req.onblocked = () => {
      if (!isSettled) {
        isSettled = true;
        reject(new Error('Legacy database open blocked'));
      }
    };
  });
}

/**
 * Detects whether the legacy shared cache database exists.
 * 1. Primary check: uses non-mutating `indexedDB.databases()` where supported.
 * 2. Fallback: returns 'unsupported' in legacy engines without databases().
 */
async function hasLegacyDatabase(dbName: string = activeLegacyDbName): Promise<boolean | 'unsupported'> {
  if (legacyDatabaseExistenceCheckerForTesting) {
    const injected = await legacyDatabaseExistenceCheckerForTesting(dbName);
    if (injected !== null) return injected;
  }

  if (typeof indexedDB === 'undefined') {
    return 'unsupported';
  }

  // Standards-compliant non-mutating check when supported (Chromium, Safari 14+, Firefox 126+)
  if (typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases();
      return dbs.some(db => db.name === dbName);
    } catch {
      // Fall through to unsupported if blocked by security sandbox
    }
  }

  return 'unsupported';
}

export function getLocalDB(accountId?: string, expectedSessionId?: number): Promise<IDBPDatabase<KurippuDBSchema>> {
  if (expectedSessionId !== undefined && expectedSessionId !== currentSessionId) {
    return Promise.reject(new StaleSessionError(expectedSessionId, currentSessionId));
  }

  const targetAccount = accountId || currentAccountId;
  if (!targetAccount) {
    return Promise.reject(
      new Error('IndexedDB access denied: no authenticated account partition is currently active.')
    );
  }

  // Prevent cross-account reads/writes if an explicit accountId does not match current active account
  if (accountId && currentAccountId !== null && accountId !== currentAccountId) {
    return Promise.reject(new AccountMismatchError(accountId, currentAccountId));
  }

  if (currentAccountId === null) {
    return Promise.reject(
      new Error('IndexedDB access denied: no authenticated account partition is currently active.')
    );
  }

  if (!activeDbPromise) {
    const sessionAtOpen = currentSessionId;
    const dbName = `kurippu_cache_${targetAccount}`;
    const doOpen = () =>
      openDB<KurippuDBSchema>(dbName, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('notes')) {
            db.createObjectStore('notes', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('manifest')) {
            db.createObjectStore('manifest');
          }
          if (!db.objectStoreNames.contains('sync_queue')) {
            const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
            queueStore.createIndex('by_status', 'status');
          }
        },
      });

    const openPromise = (async () => {
      const db = dbOpenWrapperForTesting ? await dbOpenWrapperForTesting(doOpen) : await doOpen();

      // Abort if an account switch occurred while opening
      if (sessionAtOpen !== currentSessionId) {
        db.close();
        throw new StaleSessionError(sessionAtOpen, currentSessionId);
      }
      activeDb = db;
      return db;
    })().catch(err => {
      // Clear activeDbPromise ONLY if this exact promise is still the active connection
      // and the session has not advanced to a newer account or connection
      if (activeDbPromise === openPromise && currentSessionId === sessionAtOpen) {
        activeDbPromise = null;
      }
      throw err;
    });

    activeDbPromise = openPromise;
  }
  return activeDbPromise;
}

export interface LegacyCacheSummary {
  exists: boolean;
  notesCount: number;
  pendingJobsCount: number;
  failedJobsCount: number;
  noteTitles: string[];
}

/**
 * Inspects the legacy shared database in readonly mode.
 * Never clears, deletes, mutates, or upgrades the legacy database.
 */
export async function inspectLegacyCache(): Promise<LegacyCacheSummary> {
  const emptySummary: LegacyCacheSummary = {
    exists: false,
    notesCount: 0,
    pendingJobsCount: 0,
    failedJobsCount: 0,
    noteTitles: [],
  };

  const existence = await hasLegacyDatabase();
  // Confirmed absent by indexedDB.databases() or unsupported engine: return empty summary
  if (existence === false || existence === 'unsupported') {
    return emptySummary;
  }

  // Existence was confirmed: open existing legacy DB without version upgrade.
  // If opening fails, surface the error rather than masking it as an absent database.
  const legacyDb = await openExistingLegacyDB(activeLegacyDbName);
  try {
    if (!legacyDb.objectStoreNames.contains('notes')) {
      return emptySummary;
    }

    const notes = await legacyDb.getAll('notes');
    const allJobs = legacyDb.objectStoreNames.contains('sync_queue')
      ? await legacyDb.getAll('sync_queue')
      : [];
    const pendingJobsCount = allJobs.filter(j => j.status === 'pending' || j.status === 'in_flight').length;
    const failedJobsCount = allJobs.filter(j => j.status === 'failed').length;
    const noteTitles = notes.map(n => n.title || 'Untitled Note');

    return {
      exists: notes.length > 0 || allJobs.length > 0,
      notesCount: notes.length,
      pendingJobsCount,
      failedJobsCount,
      noteTitles,
    };
  } finally {
    legacyDb.close();
  }
}

export interface LegacyCacheImportResult {
  importedNotesCount: number;
  importedJobsCount: number;
  skippedNotesCount: number;
}

// Account- and session-scoped migration coordination Map
const activeMigrations = new Map<string, Promise<LegacyCacheImportResult>>();

// Test seam for synchronizing migration phases in tests
let migrationBeforeWriteHook: (() => Promise<void>) | null = null;

export function setMigrationBeforeWriteHookForTesting(hook: (() => Promise<void>) | null): void {
  migrationBeforeWriteHook = hook;
}

/**
 * Safely imports legacy cached notes, manifest, and sync jobs into the active account partition.
 * The legacy database is preserved unchanged and never deleted.
 * Idempotent: Skips notes that already exist in target, avoids duplicate jobs, and sanitizes foreign Drive IDs.
 * Concurrency guard: Reuses in-flight promise for the same account and session; rejects cross-account requests.
 */
export function importLegacyCacheToActiveAccount(
  targetPermissionId: string
): Promise<LegacyCacheImportResult> {
  const activeAccount = getActiveAccountId();
  const currentSession = getActiveAccountSessionId();

  if (!targetPermissionId || targetPermissionId !== activeAccount) {
    return Promise.reject(new AccountMismatchError(targetPermissionId, activeAccount));
  }

  const coordinationKey = `${targetPermissionId}:${currentSession}`;
  const existingMigration = activeMigrations.get(coordinationKey);
  if (existingMigration) {
    return existingMigration;
  }

  const migrationPromise = _runImportLegacyCache(targetPermissionId, currentSession).finally(() => {
    // Each migration removes ONLY its own coordinator entry
    if (activeMigrations.get(coordinationKey) === migrationPromise) {
      activeMigrations.delete(coordinationKey);
    }
  });

  activeMigrations.set(coordinationKey, migrationPromise);
  return migrationPromise;
}

async function _runImportLegacyCache(
  targetPermissionId: string,
  migrationSessionId: number
): Promise<LegacyCacheImportResult> {
  const assertSessionValid = () => {
    if (currentAccountId !== targetPermissionId) {
      throw new AccountMismatchError(targetPermissionId, currentAccountId);
    }
    if (currentSessionId !== migrationSessionId) {
      throw new StaleSessionError(migrationSessionId, currentSessionId);
    }
  };

  assertSessionValid();

  // 1. Check legacy database existence
  const existence = await hasLegacyDatabase();
  if (existence === false) {
    // Confirmed absent by non-mutating check: clean verified no-op
    return { importedNotesCount: 0, importedJobsCount: 0, skippedNotesCount: 0 };
  }
  if (existence === 'unsupported') {
    // Existence cannot be established safely: do not silently create a blank DB
    throw new LegacyDatabaseUnavailableError();
  }

  // 2. Read legacy data (read-only; legacy database is never mutated, upgraded, or cleared)
  // If openExistingLegacyDB fails, do NOT report a successful no-op; surface the failure.
  const legacyDb = await openExistingLegacyDB(activeLegacyDbName);
  let legacyNotes: NoteDocument[];
  let legacyManifest: ApplicationManifest | undefined;
  let legacyJobs: SyncJob[];
  try {
    if (!legacyDb.objectStoreNames.contains('notes')) {
      return { importedNotesCount: 0, importedJobsCount: 0, skippedNotesCount: 0 };
    }
    legacyNotes = await legacyDb.getAll('notes');
    legacyManifest = legacyDb.objectStoreNames.contains('manifest')
      ? await legacyDb.get('manifest', 'current')
      : undefined;
    legacyJobs = legacyDb.objectStoreNames.contains('sync_queue')
      ? await legacyDb.getAll('sync_queue')
      : [];
  } finally {
    legacyDb.close();
  }

  // 2. Validate session before acquiring target database connection
  assertSessionValid();
  const targetDb = await getLocalDB(targetPermissionId, migrationSessionId);

  // Test seam: pause before destination write transaction begins
  if (migrationBeforeWriteHook) {
    await migrationBeforeWriteHook();
  }

  // 3. Validate session before beginning destination write transaction
  assertSessionValid();

  // Atomically execute all destination mutations in a single readwrite transaction.
  // If any write fails or a JavaScript error occurs before completion, the transaction
  // is explicitly aborted, rolling back all stores (notes, manifest, sync_queue) atomically.
  const tx = targetDb.transaction(['notes', 'manifest', 'sync_queue'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const manifestStore = tx.objectStore('manifest');
  const queueStore = tx.objectStore('sync_queue');

  let importedNotesCount = 0;
  let skippedNotesCount = 0;
  let importedJobsCount = 0;

  try {
    // Step 1: Copy notes into target partition without overwriting existing destination notes
    const newlyImportedNoteIds = new Set<string>();
    for (const note of legacyNotes) {
      const existing = await notesStore.get(note.id);
      if (existing) {
        skippedNotesCount++;
        continue;
      }
      // Cleanse foreign Google Drive file IDs and versions from legacy note
      const sanitizedNote: NoteDocument = {
        ...note,
        driveFileId: undefined,
        baseDriveVersion: undefined,
        duplicateDriveFileIds: undefined,
      };
      await notesStore.put(sanitizedNote);
      newlyImportedNoteIds.add(sanitizedNote.id);
      importedNotesCount++;
    }

    // Step 2: Safe manifest merge
    let targetManifest = await manifestStore.get('current');
    if (!targetManifest) {
      targetManifest = {
        schemaVersion: 1,
        workspaceId: 'default',
        rootNoteId: 'root',
        lastModified: new Date().toISOString(),
        revisionSequence: 1,
        notes: {},
        branches: [],
      };
    }

    let updatedManifest = false;
    for (const noteId of newlyImportedNoteIds) {
      if (!targetManifest.notes[noteId]) {
        const importedNote = await notesStore.get(noteId);
        const legacyHeader = legacyManifest?.notes?.[noteId];
        if (importedNote) {
          targetManifest.notes[noteId] = {
            id: importedNote.id,
            title: importedNote.title,
            type: importedNote.type,
            icon: importedNote.icon,
            attributes: importedNote.attributes || [],
            contentHash: importedNote.contentHash || '',
            driveFileId: undefined,
            driveVersion: undefined,
            duplicateDriveFileIds: undefined,
            updatedAt: importedNote.updatedAt || new Date().toISOString(),
            isDeleted: importedNote.isDeleted ?? false,
            deletedAt: importedNote.deletedAt,
          };
          updatedManifest = true;
        } else if (legacyHeader) {
          targetManifest.notes[noteId] = {
            ...legacyHeader,
            driveFileId: undefined,
            driveVersion: undefined,
            duplicateDriveFileIds: undefined,
          };
          updatedManifest = true;
        }
      }
    }

    // Preserve branch structure for newly imported notes from legacy manifest
    if (legacyManifest?.branches) {
      const existingBranchIds = new Set(targetManifest.branches.map(b => b.branchId));
      for (const branch of legacyManifest.branches) {
        if (newlyImportedNoteIds.has(branch.noteId) && !existingBranchIds.has(branch.branchId)) {
          targetManifest.branches.push(branch);
          existingBranchIds.add(branch.branchId);
          updatedManifest = true;
        }
      }
    }

    if (updatedManifest) {
      await manifestStore.put(targetManifest, 'current');
    }

    // Step 3: Inspect and requeue only safe jobs: SAVE_NOTE for notes that exist in target partition
    // Deduplicate against existing pending, in_flight, or failed jobs in targetDb
    const existingJobs = await queueStore.getAll();
    const existingJobTargetIds = new Set(
      existingJobs
        .filter(j => j.status === 'pending' || j.status === 'in_flight' || j.status === 'failed')
        .map(j => `${j.type}:${j.targetId}`)
    );

    for (const job of legacyJobs) {
      // Only import safe job types (SAVE_NOTE) for notes that actually exist in the target partition
      if (job.type !== 'SAVE_NOTE') {
        continue;
      }
      const noteExistsInTarget = await notesStore.get(job.targetId);
      if (!noteExistsInTarget) {
        continue;
      }
      const jobKey = `${job.type}:${job.targetId}`;
      if (existingJobTargetIds.has(jobKey)) {
        continue; // Skip duplicate job (including when destination already has a failed/pending job)
      }

      // Always use the destination note's actual content rather than stale legacy job payload
      const sanitizedPayload: NoteDocument = {
        ...noteExistsInTarget,
        driveFileId: undefined,
        baseDriveVersion: undefined,
        duplicateDriveFileIds: undefined,
      };

      const jobToImport: SyncJob = {
        jobId: job.jobId || `legacy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        type: 'SAVE_NOTE',
        targetId: job.targetId,
        payload: sanitizedPayload,
        clientTimestamp: job.clientTimestamp || Date.now(),
        retryCount: 0,
        status: 'pending',
      };
      await queueStore.add(jobToImport);
      existingJobTargetIds.add(jobKey);
      importedJobsCount++;
    }

    // Session validation prior to transaction commit
    assertSessionValid();

    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Transaction may already be aborted or inactive
    }
    await tx.done.catch(() => {});
    throw err;
  }

  // 4. Validate session after transaction completion
  assertSessionValid();

  return {
    importedNotesCount,
    importedJobsCount,
    skippedNotesCount,
  };
}

export async function requestPersistentStorage(): Promise<{ persisted: boolean; quota?: number; usage?: number }> {
  let persisted = false;
  let quota: number | undefined;
  let usage: number | undefined;

  if (typeof navigator !== 'undefined' && navigator.storage) {
    if (navigator.storage.persist) {
      persisted = await navigator.storage.persist();
    }
    if (navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      quota = estimate.quota;
      usage = estimate.usage;
    }
  }

  return { persisted, quota, usage };
}

export async function saveNoteLocal(note: NoteDocument, accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  await db.put('notes', note);
}

export async function getNoteLocal(id: string, accountId?: string, expectedSessionId?: number): Promise<NoteDocument | undefined> {
  const db = await getLocalDB(accountId, expectedSessionId);
  return db.get('notes', id);
}

export async function listNotesLocal(accountId?: string, includeDeleted = false, expectedSessionId?: number): Promise<NoteDocument[]> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const notes = await db.getAll('notes');
  return includeDeleted ? notes : notes.filter(n => !n.isDeleted);
}

export async function deleteNoteLocal(id: string, accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  await db.delete('notes', id);
}

export async function saveManifestLocal(manifest: ApplicationManifest, accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  await db.put('manifest', manifest, 'current');
}

export async function getManifestLocal(accountId?: string, expectedSessionId?: number): Promise<ApplicationManifest | undefined> {
  const db = await getLocalDB(accountId, expectedSessionId);
  return db.get('manifest', 'current');
}

/**
 * Enqueues a sync job, coalescing pending jobs for the same targetId and type.
 * If a pending job already exists, its payload and timestamp are updated in-place.
 */
export async function enqueueOrCoalesceSyncJob(job: Omit<SyncJob, 'id'>, accountId?: string, expectedSessionId?: number): Promise<number> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readwrite');
  const index = tx.store.index('by_status');
  let cursor = await index.openCursor('pending');
  let existingId: number | null = null;

  while (cursor) {
    if (cursor.value.targetId === job.targetId && cursor.value.type === job.type) {
      existingId = cursor.value.id!;
      const updatedJob: SyncJob = {
        ...cursor.value,
        payload: job.payload,
        clientTimestamp: job.clientTimestamp,
        retryCount: 0,
      };
      await cursor.update(updatedJob);
      break;
    }
    cursor = await cursor.continue();
  }

  if (existingId !== null) {
    await tx.done;
    return existingId;
  }

  const id = await tx.store.add(job as SyncJob);
  await tx.done;
  return id;
}

export async function enqueueSyncJob(job: Omit<SyncJob, 'id'>, accountId?: string, expectedSessionId?: number): Promise<number> {
  return enqueueOrCoalesceSyncJob(job, accountId, expectedSessionId);
}

export async function hasPendingJobForNote(noteId: string, accountId?: string, expectedSessionId?: number): Promise<boolean> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readonly');
  const index = tx.store.index('by_status');
  for (const status of ['pending', 'in_flight', 'failed'] as const) {
    let cursor = await index.openCursor(status);
    while (cursor) {
      if (cursor.value.targetId === noteId) {
        return true;
      }
      cursor = await cursor.continue();
    }
  }
  return false;
}

export async function recoverInterruptedJobs(accountId?: string, expectedSessionId?: number): Promise<number> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readwrite');
  const index = tx.store.index('by_status');
  let cursor = await index.openCursor('in_flight');
  let recoveredCount = 0;
  while (cursor) {
    const job = cursor.value;
    job.status = 'pending';
    await cursor.update(job);
    recoveredCount++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return recoveredCount;
}

export async function retryFailedJobs(accountId?: string, expectedSessionId?: number): Promise<number> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readwrite');
  const index = tx.store.index('by_status');
  let cursor = await index.openCursor('failed');
  let retriedCount = 0;
  while (cursor) {
    const job = cursor.value;
    job.status = 'pending';
    job.retryCount = 0;
    job.lastError = undefined;
    await cursor.update(job);
    retriedCount++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return retriedCount;
}

export async function peekNextPendingJob(accountId?: string, expectedSessionId?: number): Promise<SyncJob | undefined> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readonly');
  const index = tx.store.index('by_status');
  const cursor = await index.openCursor('pending');
  return cursor ? cursor.value : undefined;
}

export async function updateSyncJob(job: SyncJob, accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  await db.put('sync_queue', job);
}

export async function removeSyncJob(id: number, accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  await db.delete('sync_queue', id);
}

export async function removePendingJobsForNote(noteId: string, accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readwrite');
  const index = tx.store.index('by_status');
  let cursor = await index.openCursor('pending');
  while (cursor) {
    if (cursor.value.targetId === noteId) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function getPendingJobCount(accountId?: string, expectedSessionId?: number): Promise<number> {
  const db = await getLocalDB(accountId, expectedSessionId);
  const tx = db.transaction('sync_queue', 'readonly');
  const index = tx.store.index('by_status');
  return index.count('pending');
}

export async function getAllQueueJobs(accountId?: string, expectedSessionId?: number): Promise<SyncJob[]> {
  const db = await getLocalDB(accountId, expectedSessionId);
  return db.getAll('sync_queue');
}

export async function clearLocalDatabase(accountId?: string, expectedSessionId?: number): Promise<void> {
  const db = await getLocalDB(accountId, expectedSessionId);
  await db.clear('notes');
  await db.clear('manifest');
  await db.clear('sync_queue');
}
