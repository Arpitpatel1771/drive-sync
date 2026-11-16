// IndexedDB-backed SyncStore. The layout (version 1; `items` and `queue` keyed by
// `key`, `queue` indexed by `enqueuedAt`, out-of-line `meta`) matches what Taalmel
// already wrote, so existing databases open unchanged. Every helper rejects with
// IndexedDB's own error. The open connection is cached per store instance.

import { itemKey, queueKey, type QueueItem, type SyncItem, type SyncStore } from "./syncStore";

const DB_VERSION = 1;
const ITEMS = "items";
const QUEUE = "queue";
const META = "meta";

export function createIdbSyncStore(dbName: string): SyncStore & { reset(): Promise<void> } {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: "key" }).createIndex("enqueuedAt", "enqueuedAt");
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error(`Failed to open IndexedDB database '${dbName}'`));
      };
    });
    return dbPromise;
  }

  function run<T>(store: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error ?? req.error ?? new Error("IndexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        })
    );
  }

  return {
    getItem(kind, id) {
      return run(ITEMS, "readonly", (s) => s.get(itemKey(kind, id)) as IDBRequest<SyncItem | undefined>);
    },
    async putItem(item) {
      const record: SyncItem = { ...item, key: itemKey(item.kind, item.id) };
      await run(ITEMS, "readwrite", (s) => s.put(record));
      return record;
    },
    async deleteItem(kind, id) {
      await run(ITEMS, "readwrite", (s) => s.delete(itemKey(kind, id)));
    },
    listItems(kind) {
      return run(ITEMS, "readonly", (s) => s.getAll() as IDBRequest<SyncItem[]>).then((all) =>
        kind ? all.filter((i) => i.kind === kind) : all
      );
    },
    async enqueue(op, kind, id, now = Date.now()) {
      const key = queueKey(op, kind, id);
      const db = await open();
      return new Promise<QueueItem>((resolve, reject) => {
        const tx = db.transaction(QUEUE, "readwrite");
        const store = tx.objectStore(QUEUE);
        let record: QueueItem = { key, op, kind, id, enqueuedAt: now, attempts: 0 };
        const get = store.get(key) as IDBRequest<QueueItem | undefined>;
        get.onsuccess = () => {
          const prev = get.result;
          if (prev) {
            record = { ...record, enqueuedAt: prev.enqueuedAt };
            // A new upsert/delete supersedes the old one; a resumable session stays valid for the same media op.
            if (prev.op === op && prev.resumableUrl) record.resumableUrl = prev.resumableUrl;
          }
          store.put(record);
        };
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      });
    },
    listQueue() {
      return run(QUEUE, "readonly", (s) => s.getAll() as IDBRequest<QueueItem[]>).then((all) =>
        all.sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      );
    },
    async updateQueueItem(key, patch) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(QUEUE, "readwrite");
        const store = tx.objectStore(QUEUE);
        const get = store.get(key) as IDBRequest<QueueItem | undefined>;
        get.onsuccess = () => {
          if (get.result) store.put({ ...get.result, ...patch });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      });
    },
    async dequeue(key) {
      await run(QUEUE, "readwrite", (s) => s.delete(key));
    },
    getMeta<T = unknown>(key: string) {
      return run(META, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
    },
    async setMeta(key, value) {
      await run(META, "readwrite", (s) => s.put(value, key));
    },
    async deleteMeta(key) {
      await run(META, "readwrite", (s) => s.delete(key));
    },
    /** Test-only: closes the cached connection so the database can be deleted. */
    async reset() {
      if (dbPromise) (await dbPromise).close();
      dbPromise = null;
    },
  };
}
