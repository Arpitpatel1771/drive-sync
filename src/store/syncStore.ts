// Local sync bookkeeping: the link between local entities and Drive files, the
// pending-operation queue, and a small key/value meta area.

/** Link between a local entity and its Drive file. For file collections, driveFileId is the meta (sidecar) file. */
export interface SyncItem {
  /** `kind:id`. */
  key: string;
  kind: string;
  id: string;
  driveFileId: string;
  /** SHA-256 of the content at the last successful sync. */
  lastSyncedHash: string;
  lastRemoteVersion: string;
  /** File collections only: the media file, once uploaded. */
  mediaFileId?: string;
  /** File collections only: the `mediaRev` of the media last uploaded (absent = 0). */
  mediaRev?: number;
  deletedLocally?: boolean;
}

export type QueueOp = "upsert" | "delete" | "uploadMedia";

export interface QueueItem {
  /** `kind:id`, or `kind:id:media` for uploadMedia so a meta op and a media op don't collide. */
  key: string;
  op: QueueOp;
  kind: string;
  id: string;
  enqueuedAt: number;
  attempts: number;
  resumableUrl?: string;
}

export const itemKey = (kind: string, id: string) => `${kind}:${id}`;
export const queueKey = (op: QueueOp, kind: string, id: string) =>
  op === "uploadMedia" ? `${kind}:${id}:media` : `${kind}:${id}`;

export interface SyncStore {
  getItem(kind: string, id: string): Promise<SyncItem | undefined>;
  putItem(item: Omit<SyncItem, "key">): Promise<SyncItem>;
  deleteItem(kind: string, id: string): Promise<void>;
  listItems(kind?: string): Promise<SyncItem[]>;
  /** Adds an operation, replacing any pending one for the same key (the latest op wins). */
  enqueue(op: QueueOp, kind: string, id: string, now?: number): Promise<QueueItem>;
  /** Oldest first. */
  listQueue(): Promise<QueueItem[]>;
  updateQueueItem(key: string, patch: Partial<Pick<QueueItem, "attempts" | "resumableUrl">>): Promise<void>;
  dequeue(key: string): Promise<void>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
}
