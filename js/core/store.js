// Tiny promise wrapper over one IndexedDB object store (key → structured-clone value).
const DB_NAME = 'kerf';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (!('indexedDB' in self)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const store = {
  get: (key) => tx('readonly', s => s.get(key)),
  set: (key, value) => tx('readwrite', s => s.put(value, key)),
  del: (key) => tx('readwrite', s => s.delete(key)),
};
