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
    // A synchronous throw (e.g. a value that can't be cloned) must abort the
    // transaction: otherwise the requests already queued in it still commit,
    // and a "failed" multi-key write lands half-done.
    try { out = fn(store); } catch (e) { try { tx.abort(); } catch { /* already done */ } reject(e); return; }
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
  /**
   * Write several keys in ONE transaction: all land or none do. Group state,
   * cursor and transcript must move together — a ratchet that advanced
   * without its cursor re-fetches messages it can no longer decrypt, and
   * their plaintext is gone for good.
   */
  setMany: (entries) => withStore("readwrite", (s) => { for (const [k, v] of entries) s.put(v, k); }),
  delMany: (keys) => withStore("readwrite", (s) => { for (const k of keys) s.delete(k); }),
  /** Delete every key `match(key)` accepts, in one transaction. */
  deleteWhere: async (match) => {
    const keys = await withStore("readonly", (s) => s.getAllKeys());
    const doomed = keys.filter(match);
    if (doomed.length) await store.delMany(doomed);
    return doomed.length;
  },
};

/** Every key this store holds for `handle` (they are all "<kind>:<handle>…"). */
export const belongsTo = (handle) => (key) => String(key).split(":")[1] === handle;

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
  pendingCommit: (handle, groupId) => `pc:${handle}:${groupId}`,   // { before, epoch, since } while a commit is in flight
  leafRegistered: (handle, groupId) => `lr:${handle}:${groupId}`,  // this device's leaf key is in the directory
  evictionReport: (handle, groupId) => `ev:${handle}:${groupId}`,  // an eviction the server hasn't heard of yet
};
