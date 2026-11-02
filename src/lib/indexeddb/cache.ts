import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { NoteDocument, ApplicationManifest, SyncJob } from '../../types/storage';

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

const DB_NAME = 'kurippu_local_cache';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<KurippuDBSchema>> | null = null;

export function getLocalDB(): Promise<IDBPDatabase<KurippuDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<KurippuDBSchema>(DB_NAME, DB_VERSION, {
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
  }
  return dbPromise;
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

export async function saveNoteLocal(note: NoteDocument): Promise<void> {
  const db = await getLocalDB();
  await db.put('notes', note);
}

export async function getNoteLocal(id: string): Promise<NoteDocument | undefined> {
  const db = await getLocalDB();
  return db.get('notes', id);
}

export async function listNotesLocal(): Promise<NoteDocument[]> {
  const db = await getLocalDB();
  return db.getAll('notes');
}

export async function deleteNoteLocal(id: string): Promise<void> {
  const db = await getLocalDB();
  await db.delete('notes', id);
}

export async function saveManifestLocal(manifest: ApplicationManifest): Promise<void> {
  const db = await getLocalDB();
  await db.put('manifest', manifest, 'current');
}

export async function getManifestLocal(): Promise<ApplicationManifest | undefined> {
  const db = await getLocalDB();
  return db.get('manifest', 'current');
}

export async function enqueueSyncJob(job: Omit<SyncJob, 'id'>): Promise<number> {
  const db = await getLocalDB();
  return db.add('sync_queue', job as SyncJob);
}

export async function peekNextPendingJob(): Promise<SyncJob | undefined> {
  const db = await getLocalDB();
  const tx = db.transaction('sync_queue', 'readonly');
  const index = tx.store.index('by_status');
  const cursor = await index.openCursor('pending');
  return cursor ? cursor.value : undefined;
}

export async function updateSyncJob(job: SyncJob): Promise<void> {
  const db = await getLocalDB();
  await db.put('sync_queue', job);
}

export async function removeSyncJob(id: number): Promise<void> {
  const db = await getLocalDB();
  await db.delete('sync_queue', id);
}

export async function getPendingJobCount(): Promise<number> {
  const db = await getLocalDB();
  const tx = db.transaction('sync_queue', 'readonly');
  const index = tx.store.index('by_status');
  return index.count('pending');
}

export async function getAllQueueJobs(): Promise<SyncJob[]> {
  const db = await getLocalDB();
  return db.getAll('sync_queue');
}

export async function clearLocalDatabase(): Promise<void> {
  const db = await getLocalDB();
  await db.clear('notes');
  await db.clear('manifest');
  await db.clear('sync_queue');
}
