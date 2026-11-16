import { afterEach, describe, expect, it } from "vitest";
import { createIdbSyncStore } from "../src/store/idbSyncStore";
import { createMemorySyncStore } from "../src/store/memorySyncStore";
import { itemKey, queueKey, type SyncStore } from "../src/store/syncStore";

const opened: Array<{ reset(): Promise<void> }> = [];
const makers: Array<[string, () => SyncStore]> = [
  ["memory", () => createMemorySyncStore()],
  [
    "idb",
    () => {
      const s = createIdbSyncStore("test-sync");
      opened.push(s);
      return s;
    },
  ],
];

afterEach(async () => {
  for (const s of opened.splice(0)) await s.reset();
  for (const name of ["test-sync", "a-sync", "b-sync"]) {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
});

const item = (id: string, kind = "song") => ({
  kind,
  id,
  driveFileId: `d-${id}`,
  lastSyncedHash: "h",
  lastRemoteVersion: "3",
});

describe("key helpers", () => {
  it("builds kind:id and kind:id:media keys", () => {
    expect(itemKey("song", "a")).toBe("song:a");
    expect(queueKey("upsert", "clip", "c")).toBe("clip:c");
    expect(queueKey("delete", "clip", "c")).toBe("clip:c");
    expect(queueKey("uploadMedia", "clip", "c")).toBe("clip:c:media");
  });
});

describe.each(makers)("SyncStore (%s)", (_name, make) => {
  it("puts, gets, lists and deletes items keyed kind:id", async () => {
    const s = make();
    const saved = await s.putItem(item("a"));
    expect(saved.key).toBe("song:a");
    await s.putItem(item("a", "clip"));
    expect(await s.getItem("song", "a")).toMatchObject({ driveFileId: "d-a" });
    expect(await s.listItems()).toHaveLength(2);
    expect(await s.listItems("clip")).toHaveLength(1);
    await s.putItem({ ...item("a"), lastRemoteVersion: "4", deletedLocally: true });
    expect((await s.getItem("song", "a"))?.lastRemoteVersion).toBe("4");
    await s.deleteItem("song", "a");
    expect(await s.getItem("song", "a")).toBeUndefined();
  });

  it("de-duplicates the queue per kind:id, keeping the first enqueuedAt and the latest op", async () => {
    const s = make();
    await s.enqueue("upsert", "song", "a", 10);
    await s.enqueue("upsert", "song", "b", 20);
    await s.updateQueueItem("song:a", { attempts: 3 });
    const again = await s.enqueue("delete", "song", "a", 30);
    expect(again).toMatchObject({ op: "delete", enqueuedAt: 10, attempts: 0 });
    const q = await s.listQueue();
    expect(q.map((x) => `${x.key}:${x.op}`)).toEqual(["song:a:delete", "song:b:upsert"]);
  });

  it("keeps clip meta and media ops separate, and preserves a resumable URL for the same media op", async () => {
    const s = make();
    await s.enqueue("upsert", "clip", "c", 1);
    await s.enqueue("uploadMedia", "clip", "c", 2);
    expect(await s.listQueue()).toHaveLength(2);
    await s.updateQueueItem("clip:c:media", { resumableUrl: "https://u/1", attempts: 1 });
    await s.enqueue("uploadMedia", "clip", "c", 5);
    const media = (await s.listQueue()).find((x) => x.op === "uploadMedia");
    expect(media).toMatchObject({ resumableUrl: "https://u/1", attempts: 0, enqueuedAt: 2 });
  });

  it("updates attempts and dequeues", async () => {
    const s = make();
    await s.enqueue("upsert", "song", "a", 1);
    await s.updateQueueItem("song:a", { attempts: 2 });
    expect((await s.listQueue())[0].attempts).toBe(2);
    await s.updateQueueItem("song:missing", { attempts: 1 });
    await s.dequeue("song:a");
    expect(await s.listQueue()).toEqual([]);
  });

  it("gets, sets and deletes meta values", async () => {
    const s = make();
    expect(await s.getMeta("changesPageToken")).toBeUndefined();
    await s.setMeta("changesPageToken", "99");
    await s.setMeta("folders", { root: "r", songs: "s" });
    expect(await s.getMeta<string>("changesPageToken")).toBe("99");
    expect(await s.getMeta("folders")).toEqual({ root: "r", songs: "s" });
    await s.deleteMeta("changesPageToken");
    expect(await s.getMeta("changesPageToken")).toBeUndefined();
  });
});

describe("idb layout", () => {
  it("uses db version 1 with items, queue (enqueuedAt index) and meta", async () => {
    const s = createIdbSyncStore("a-sync");
    opened.push(s);
    await s.setMeta("x", 1);
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("a-sync");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(["items", "meta", "queue"]);
    const tx = db.transaction(["items", "queue"]);
    expect(tx.objectStore("items").keyPath).toBe("key");
    expect(tx.objectStore("queue").keyPath).toBe("key");
    expect([...tx.objectStore("queue").indexNames]).toEqual(["enqueuedAt"]);
    db.close();
  });

  it("two databases don't share data", async () => {
    const a = createIdbSyncStore("a-sync");
    const b = createIdbSyncStore("b-sync");
    opened.push(a, b);
    await a.putItem(item("x"));
    expect(await b.listItems()).toEqual([]);
  });
});
