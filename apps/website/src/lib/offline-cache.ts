/**
 * Offline cache for the last sync snapshot.
 *
 * Uses IndexedDB to store the full snapshot tables so the UI can hydrate
 * immediately on page load without waiting for the WebSocket handshake.
 * The cache is invalidated on non-initial sync_reset (server state changed
 * from under us) and refreshed whenever we receive a new snapshot.
 */

const DB_NAME = "b3-chat-offline";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "last";

export type CachedSnapshot = {
  tables: Record<string, Record<string, any>>;
  lastServerSeq: number;
  cachedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function readCachedSnapshot(): Promise<CachedSnapshot | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(SNAPSHOT_KEY);
      request.onsuccess = () => {
        const result = request.result as CachedSnapshot | undefined;
        resolve(result ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function writeCachedSnapshot(
  tables: Record<string, Record<string, any>>,
  lastServerSeq: number,
) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ tables, lastServerSeq, cachedAt: Date.now() }, SNAPSHOT_KEY);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB is best-effort; don't let cache failures break sync
  }
}

export async function clearCachedSnapshot() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(SNAPSHOT_KEY);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort
  }
}
