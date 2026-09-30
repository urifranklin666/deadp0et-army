/**
 * Local secret store (IndexedDB).
 *
 * Holds the only copy of this device's MLS private key material and group
 * ratchet state. The server has none of it and cannot reconstruct it — losing
 * this store means losing access to past groups, which is the intended
 * property, not a bug. Keep that in mind before "clearing site data".
 */

const DB_NAME = "deadp0et";
const DB_VERSION = 1;
const STORE = "kv";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    // Unwrap the IDBRequest. Resolving to the request itself when .result is
    // undefined would hand callers a truthy object for a MISSING key, which
    // reads as "found" and blows up downstream.
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const store = {
  get: (key) => withStore("readonly", (s) => s.get(key)),
  set: (key, value) => withStore("readwrite", (s) => s.put(value, key)),
  del: (key) => withStore("readwrite", (s) => s.delete(key)),
  clear: () => withStore("readwrite", (s) => s.clear()),
};

/* ------------------------------------------------------------------ keys */
/* Namespaced per handle so two accounts on one browser never collide. */

export const K = {
  device: (handle) => `device:${handle}`,
  keyPackage: (handle) => `kp:${handle}`,
  keyPackagePool: (handle) => `kps:${handle}`,   // ref(b64) -> exported KeyPackage
  groupState: (handle, groupId) => `gs:${handle}:${groupId}`,
  cursor: (handle, groupId) => `cur:${handle}:${groupId}`,
  history: (handle, groupId) => `hist:${handle}:${groupId}`,
  ydoc: (handle, groupId) => `ydoc:${handle}:${groupId}`,
};
