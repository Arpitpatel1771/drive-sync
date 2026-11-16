// Drive sync engine. Local storage stays the primary copy; this module mirrors it to Drive in the
// background. All I/O is injected (DriveApi, DriveAuth, SyncStore, the site's collections) so it runs
// against FakeDrive and in-memory stores in tests. Collection-specific logic lives in documents.ts,
// files.ts and settings.ts; folders.ts owns the Drive folder tree.

import type { ChangeEvent, ResolvedConfig } from "../config";
import { listAllFiles, type DriveApi, type DriveFile } from "../drive/api";
import type { DriveAuth } from "../drive/auth";
import { props as makeProps, type Props } from "../props";
import { queueKey, type QueueItem, type QueueOp, type SyncItem, type SyncStore } from "../store/syncStore";
import { DocumentsHandler } from "./documents";
import { FilesHandler, updatedAtKey } from "./files";
import { ensureFolders, missingFolders } from "./folders";
import { loadConflicts, migrateLegacyMedia, readUploadSetting, uploadSettingKey } from "./migrate";
import { SETTINGS_ID, SETTINGS_KIND, SETTINGS_UPDATED_AT, SettingsHandler } from "./settings";
import type { Conflict, Connection, Handler, HandlerContext, ItemStatus, LocalDoc, PendingRemoteDelete, RemoteDoc, SyncState, SyncStatus } from "./types";
import { backoffMs, classify } from "./util";

export type { Conflict, ItemStatus, PendingRemoteDelete, SyncState, SyncStatus, Connection } from "./types";
export { backoffMs } from "./util";

export interface SyncEngineOptions {
  config: ResolvedConfig;
  api: DriveApi;
  auth: DriveAuth;
  store: SyncStore;
  now?: () => number;
  randomId?: () => string;
  /** Flush debounce in ms. null disables every internal timer (tests). Default 2000. */
  debounceMs?: number | null;
  /** Resumable upload chunk size. Default 8 MB. */
  chunkSize?: number;
}

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const PULL_INTERVAL_MS = 60 * 1000;
const META_KEYS = ["conn", "changesPageToken", "lastSyncAt", "conflicts", "pendingDeletes", SETTINGS_UPDATED_AT];

export class SyncEngine {
  private readonly config: ResolvedConfig;
  private readonly rawApi: DriveApi;
  private readonly api: DriveApi;
  private readonly auth: DriveAuth;
  private readonly store: SyncStore;
  private readonly props: Props;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly debounceMs: number | null;
  private readonly chunkSize: number;

  /** Every synced kind: documents kinds, `settings` (when configured), files kinds. */
  private readonly handlers = new Map<string, Handler>();
  /** appProperties kind of a Drive file → what it is. `meta` is an item's own file, `media` a files collection's media. */
  private readonly byDriveKind = new Map<string, { handler: Handler; role: "meta" | "media" }>();

  private conn: Connection | null = null;
  private conflicts: Conflict[] = [];
  private pendingDeletes: PendingRemoteDelete[] = [];
  private uploads: Record<string, number> = {};
  private lastSyncAt: number | null = null;
  private uploadSettings = new Map<string, string>();
  private itemStatuses = new Map<string, ItemStatus>();
  private flags = { authRequired: false, offline: false, retrying: false, driveFull: false };
  private error: string | null = null;
  private syncing = 0;
  private failures = 0;
  private needFlush = false;
  private listeners = new Set<(s: SyncStatus) => void>();
  private unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by stop()/disconnect(), cleared by start()/connect(): while set, no flush timer is armed. */
  private stopped = false;
  /** Set when the stored sync state could not be read: the engine stays inert so it cannot push from a guessed state. */
  private loadFailed = false;
  /** Bumped whenever a flush processed queue entries or a pull received changes; the full status refresh runs only after that. */
  private activity = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingEvents = new Set<Promise<void>>();
  private touched = new Set<string>();
  private timersCleanup: (() => void) | null = null;
  private readonly ready: Promise<void>;

  constructor(opts: SyncEngineOptions) {
    this.config = opts.config;
    this.rawApi = opts.api;
    this.auth = opts.auth;
    this.store = opts.store;
    this.props = makeProps(opts.config.namespace);
    this.now = opts.now ?? (() => Date.now());
    this.randomId = opts.randomId ?? (() => crypto.randomUUID());
    this.debounceMs = opts.debounceMs === undefined ? 2000 : opts.debounceMs;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
    this.api = new Proxy(this.rawApi, {
      get: (target, prop) => {
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => this.withAuth(() => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      },
    });

    const ctx: HandlerContext = {
      api: this.api,
      store: this.store,
      config: this.config,
      props: this.props,
      now: () => this.now(),
      folder: (id) => this.folder(id),
    };
    for (const col of this.config.documents) this.register(new DocumentsHandler(col, ctx));
    if (this.config.settings) this.register(new SettingsHandler(this.config.settings, ctx));
    const env = {
      chunkSize: this.chunkSize,
      setting: (kind: string) => this.getUploadSetting(kind),
      progress: (key: string, fraction: number | null) => {
        if (fraction === null) delete this.uploads[key];
        else this.uploads[key] = fraction;
        this.emit();
      },
      pushUpsert: (kind: string, id: string) => this.pushUpsert(kind, id),
      enqueue: (op: "upsert" | "uploadMedia", kind: string, id: string) => this.enqueue(op, kind, id),
    };
    for (const col of this.config.files) {
      const h = new FilesHandler(col, ctx, env);
      this.register(h);
      this.byDriveKind.set(col.kind, { handler: h, role: "media" });
      this.uploadSettings.set(col.kind, col.defaultUploadSetting);
    }
    this.ready = this.loadPersisted();
  }

  private register(h: Handler): void {
    this.handlers.set(h.kind, h);
    this.byDriveKind.set(h.driveKind, { handler: h, role: "meta" });
  }

  private handler(kind: string): Handler {
    const h = this.handlers.get(kind);
    if (!h) throw new Error(`Unknown kind "${kind}".`);
    return h;
  }

  private filesHandler(kind: string): FilesHandler {
    const h = this.handlers.get(kind);
    if (!(h instanceof FilesHandler)) throw new Error(`"${kind}" is not a files collection.`);
    return h;
  }

  private documentsHandler(kind: string): DocumentsHandler {
    const h = this.handlers.get(kind);
    if (!(h instanceof DocumentsHandler)) throw new Error(`"${kind}" is not a documents collection.`);
    return h;
  }

  // -------------------------------------------------------------------- status

  /** The last snapshot handed out; reused while nothing changed so UI stores see a stable object. Dropped on every emit. */
  private snapshot: { status: SyncStatus; json: string } | null = null;

  /** The same object until the status changes (or the engine emits), then a new one. */
  getStatus(): SyncStatus {
    const status = this.buildStatus();
    const json = JSON.stringify(status);
    if (this.snapshot && this.snapshot.json === json) return this.snapshot.status;
    this.snapshot = { status, json };
    return status;
  }

  private buildStatus(): SyncStatus {
    let state: SyncState;
    if (!this.conn) state = "disconnected";
    else if (this.syncing > 0) state = "syncing";
    else if (this.flags.authRequired) state = "authRequired";
    else if (this.flags.offline) state = "offline";
    else if (this.flags.retrying) state = "retrying";
    else if (this.flags.driveFull) state = "driveFull";
    else state = "idle";
    return {
      state,
      email: this.auth.email() ?? this.conn?.email ?? null,
      name: this.auth.profile()?.name ?? null,
      picture: this.auth.profile()?.picture ?? null,
      lastSyncAt: this.lastSyncAt,
      conflicts: this.conflicts.map((c) => ({ ...c })),
      pendingRemoteDeletes: this.pendingDeletes.map((d) => ({ ...d })),
      uploads: { ...this.uploads },
      error: this.error,
    };
  }

  onStatus(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    this.snapshot = null;
    const s = this.getStatus();
    for (const cb of [...this.listeners]) {
      try {
        cb(s);
      } catch (err) {
        console.error("sync status listener failed", err);
      }
    }
  }

  /** The upload setting chosen for a files collection (device-local, kept in sync meta). */
  getUploadSetting(kind: string): string {
    const v = this.uploadSettings.get(kind);
    if (v === undefined) throw new Error(`"${kind}" is not a files collection.`);
    return v;
  }

  async setUploadSetting(kind: string, value: string): Promise<void> {
    await this.ready;
    this.filesHandler(kind);
    this.uploadSettings.set(kind, value);
    await this.store.setMeta(uploadSettingKey(kind), value);
    this.emit();
    if (this.conn) {
      await this.scanLocal();
      this.scheduleFlush();
    }
  }

  /** What the item's badge shows. Items this engine knows nothing about count as `local`. Kept current by the engine after every sync. */
  itemStatus(kind: string, id: string): ItemStatus {
    if (this.uploads[`${kind}:${id}`] !== undefined) return "uploading";
    return this.itemStatuses.get(`${kind}:${id}`) ?? "local";
  }

  private async refreshStatus(kind: string, id: string): Promise<void> {
    const h = this.handlers.get(kind);
    if (!(h instanceof FilesHandler)) return;
    const s = await h.status(id);
    if (s === undefined) this.itemStatuses.delete(`${kind}:${id}`);
    else this.itemStatuses.set(`${kind}:${id}`, s);
  }

  private async refreshStatuses(): Promise<void> {
    const next = new Map<string, ItemStatus>();
    for (const col of this.config.files) {
      const h = this.filesHandler(col.kind);
      for (const id of await h.listIds()) {
        const s = await h.status(id);
        if (s !== undefined) next.set(`${col.kind}:${id}`, s);
      }
    }
    this.itemStatuses = next;
  }

  private async loadPersisted(): Promise<void> {
    try {
      this.conn = (await this.store.getMeta<Connection>("conn")) ?? null;
      this.conflicts = await loadConflicts(this.store, this.config.documents[0]?.kind);
      this.pendingDeletes = (await this.store.getMeta<PendingRemoteDelete[]>("pendingDeletes")) ?? [];
      this.lastSyncAt = (await this.store.getMeta<number>("lastSyncAt")) ?? null;
      for (const col of this.config.files) {
        this.uploadSettings.set(col.kind, (await readUploadSetting(this.store, col.kind, this.config.files)) ?? col.defaultUploadSetting);
      }
      await migrateLegacyMedia(this.store, this.config.files);
      await this.refreshStatuses();
      this.emit();
    } catch (err) {
      console.error("sync state failed to load", err);
      // Inert: nothing stored is deleted, but nothing runs from a half-read state either.
      this.loadFailed = true;
      this.conn = null;
      this.error = `Sync state could not be read: ${err instanceof Error ? err.message : String(err)}`;
      this.emit();
    }
  }

  private persistLists(): Promise<void> {
    return Promise.all([
      this.store.setMeta("conflicts", this.conflicts),
      this.store.setMeta("pendingDeletes", this.pendingDeletes),
    ]).then(() => undefined);
  }

  // ----------------------------------------------------------------- lifecycle

  /**
   * First connect: links the Drive folders and merges. With stored connection
   * metadata it just resumes (a silent connect that needs interaction leaves the
   * engine in `authRequired`; the sign-in chip then calls connect({ interactive: true })).
   */
  async connect(opts: { interactive: boolean }): Promise<void> {
    await this.ready;
    if (this.loadFailed) throw new Error(this.error ?? "Sync state could not be read.");
    this.stopped = false;
    if (this.conn) {
      try {
        await this.auth.getToken({ interactive: opts.interactive });
      } catch (e) {
        if (classify(e) === "auth" && !opts.interactive) {
          this.flags.authRequired = true;
          this.start();
          this.emit();
          return;
        }
        throw e;
      }
      this.flags.authRequired = false;
      this.start();
      await this.scanLocal();
      await this.syncNow();
      return;
    }
    await this.auth.getToken({ interactive: opts.interactive });
    await this.exclusive(async () => {
      this.syncing++;
      this.emit();
      try {
        const folders = await ensureFolders(this.api, this.config, this.props);
        const startToken = await this.api.getStartPageToken();
        this.conn = { email: this.auth.email(), folders };
        await this.store.setMeta("conn", this.conn);
        await this.mergeFirstConnect();
        await this.store.setMeta("changesPageToken", startToken);
        this.start();
        await this.scanLocal();
        await this.flush();
        this.lastSyncAt = this.now();
        await this.store.setMeta("lastSyncAt", this.lastSyncAt);
        this.clearFlags();
        await this.refreshStatuses().catch(() => undefined); // badge refresh only; the connect already succeeded
      } catch (e) {
        // A failed first connect leaves the engine disconnected so the user can retry.
        this.conn = null;
        await this.store.deleteMeta("conn");
        this.handleError(e);
        throw e;
      } finally {
        this.syncing--;
        this.emit();
      }
    });
  }

  /** Stops sync and forgets the connection. Local data and Drive files are untouched. */
  async disconnect(): Promise<void> {
    await this.ready;
    this.stop();
    await this.chain.catch(() => undefined); // errors already surfaced to the callers that queued them
    for (const i of await this.store.listItems()) await this.store.deleteItem(i.kind, i.id);
    for (const q of await this.store.listQueue()) await this.store.dequeue(q.key);
    for (const k of META_KEYS) await this.store.deleteMeta(k);
    for (const col of this.config.files) {
      for (const id of await this.filesHandler(col.kind).listIds()) await this.store.deleteMeta(updatedAtKey(col.kind, id));
    }
    this.conn = null;
    this.conflicts = [];
    this.pendingDeletes = [];
    this.uploads = {};
    this.lastSyncAt = null;
    this.clearFlags();
    this.failures = 0;
    await this.refreshStatuses().catch(() => undefined); // badge refresh only; disconnect must finish
    this.auth.signOut();
    this.emit();
  }

  /** Subscribes to local changes and schedules a first flush. No-op when not connected. */
  start(): void {
    if (!this.conn) return;
    this.stopped = false;
    if (this.unsubscribers.length === 0) this.subscribe();
    this.scheduleFlush();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubscribers.splice(0)) u();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timersCleanup?.();
    this.timersCleanup = null;
  }

  /** Change events come from each collection's `store.onChange` and `settings.onChange`. */
  private subscribe(): void {
    for (const col of [...this.config.documents, ...this.config.files]) {
      this.unsubscribers.push(col.store.onChange((evt) => void this.handleLocalChange(col.kind, evt)));
    }
    const settings = this.config.settings;
    if (settings) {
      this.unsubscribers.push(settings.onChange(() => void this.handleLocalChange(SETTINGS_KIND, { type: "save", id: SETTINGS_ID })));
    }
  }

  /** Wires focus / visibility / online events and a 60 s pull interval. Returns a cleanup function. */
  handleVisibilityAndTimers(): () => void {
    if (typeof window === "undefined") return () => undefined;
    const sync = () => void this.syncNow().catch(() => undefined); // doSync reports failures in status; nobody awaits this
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    const onOnline = () => {
      this.flags.offline = false;
      sync();
    };
    window.addEventListener("focus", sync);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") sync();
    }, PULL_INTERVAL_MS);
    const cleanup = () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
    this.timersCleanup?.();
    this.timersCleanup = cleanup;
    return cleanup;
  }

  private scheduleFlush(delay: number | null = this.debounceMs): void {
    if (delay === null || !this.conn || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow().catch(() => undefined); // doSync reports failures in status; nobody awaits this
    }, delay);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn(), () => fn());
    this.chain = run.catch(() => undefined); // keeps the queue moving; `run` itself still rejects to the caller
    return run;
  }

  // ------------------------------------------------------------------ syncing

  /** Flushes the queue, then pulls remote changes. */
  syncNow(): Promise<void> {
    return this.exclusive(() => this.doSync(true));
  }

  /** Pulls remote changes only. */
  pull(): Promise<void> {
    return this.exclusive(() => this.doSync(false));
  }

  private clearFlags(): void {
    this.flags = { authRequired: false, offline: false, retrying: false, driveFull: this.flags.driveFull };
    this.error = null;
  }

  private async doSync(push: boolean): Promise<void> {
    await this.ready;
    if (!this.conn || this.loadFailed) return;
    await Promise.all([...this.pendingEvents]);
    const activityBefore = this.activity;
    this.syncing++;
    this.flags = { ...this.flags, authRequired: false, offline: false, retrying: false };
    this.error = null;
    this.emit();
    try {
      await this.ensureMissingFolders();
      if (push) await this.flush();
      this.needFlush = false;
      await this.pullInternal();
      if (this.needFlush) {
        this.needFlush = false;
        await this.flush();
      }
      this.failures = 0;
      this.lastSyncAt = this.now();
      await this.store.setMeta("lastSyncAt", this.lastSyncAt);
    } catch (e) {
      this.handleError(e);
    } finally {
      // The badges only change when something was pushed or pulled (or a step failed half way).
      if (this.activity !== activityBefore || this.failures > 0) await this.refreshStatuses().catch(() => undefined); // badge refresh only
      this.syncing--;
      this.emit();
    }
  }

  private handleError(e: unknown): void {
    const c = classify(e);
    this.failures++;
    if (c === "auth") this.flags.authRequired = true;
    else if (c === "offline") this.flags.offline = true;
    else if (c === "full") this.flags.driveFull = true;
    else {
      this.flags.retrying = true;
      if (c === "other" || c === "notFound") this.error = e instanceof Error ? e.message : String(e);
    }
    if (c !== "auth") this.scheduleFlush(this.debounceMs === null ? null : backoffMs(this.failures));
  }

  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (classify(e) !== "auth") throw e;
      await this.auth.getToken({ interactive: false }); // AuthRequiredError when Google needs the user
      return fn();
    }
  }

  // ------------------------------------------------------------- local changes

  /** Entry point for a collection's change events (the subscribed listeners call this). */
  handleLocalChange(kind: string, evt: ChangeEvent): Promise<void> {
    const p = this.onLocalChange(kind, evt)
      .catch((err) => console.error("sync enqueue failed", err))
      .finally(() => this.pendingEvents.delete(p));
    this.pendingEvents.add(p);
    return p;
  }

  /** Resolves once the change events received so far have been turned into queue entries. */
  async settled(): Promise<void> {
    await Promise.all([...this.pendingEvents]);
  }

  private async enqueue(op: QueueOp, kind: string, id: string): Promise<void> {
    this.touched.add(queueKey(op, kind, id));
    await this.store.enqueue(op, kind, id, this.now());
  }

  private async onLocalChange(kind: string, evt: ChangeEvent): Promise<void> {
    const h = this.handlers.get(kind);
    if (!h) return;
    const op: QueueOp = evt.type === "delete" ? "delete" : "upsert";
    if (h instanceof SettingsHandler) {
      await this.store.setMeta(SETTINGS_UPDATED_AT, this.now());
      await this.enqueue("upsert", SETTINGS_KIND, SETTINGS_ID);
    } else if (h instanceof DocumentsHandler) {
      if (op === "delete") {
        this.conflicts = this.conflicts.filter((c) => !(c.kind === kind && c.id === evt.id));
        await this.persistLists();
      }
      await this.enqueue(op, kind, evt.id);
    } else if (h instanceof FilesHandler) {
      if (op === "delete") {
        await this.store.dequeue(queueKey("uploadMedia", kind, evt.id));
        this.touched.add(queueKey("uploadMedia", kind, evt.id));
        await this.enqueue("delete", kind, evt.id);
      } else {
        await this.store.setMeta(updatedAtKey(kind, evt.id), this.now());
        await this.enqueue("upsert", kind, evt.id);
        if (await h.wantsMediaUpload(evt.id)) await this.enqueue("uploadMedia", kind, evt.id);
      }
      await this.refreshStatus(kind, evt.id);
      this.emit();
    }
    this.scheduleFlush();
  }

  /** Enqueues anything local that Drive hasn't seen (after connect/resume, or a setting change). */
  private async scanLocal(): Promise<void> {
    for (const h of this.handlers.values()) {
      for (const id of await h.listIds()) {
        if (this.conflicts.some((c) => c.kind === h.kind && c.id === id)) continue;
        const item = await this.store.getItem(h.kind, id);
        const doc = await h.readLocal(id);
        if (doc && (!item || item.lastSyncedHash !== doc.hash)) await this.enqueue("upsert", h.kind, id);
        if (h instanceof FilesHandler && (await h.wantsMediaUpload(id))) await this.enqueue("uploadMedia", h.kind, id);
      }
    }
  }

  // ---------------------------------------------------------------- folders

  private folder(id: string): string {
    const f = this.conn?.folders[id];
    if (!f) throw new Error(this.conn ? `Drive folder "${id}" is not set up.` : "Drive is not connected.");
    return f;
  }

  /** A site that added a collection after users connected: finds or creates just the folders its stored connection lacks. */
  private async ensureMissingFolders(): Promise<void> {
    if (!this.conn || !missingFolders(this.config, this.conn.folders)) return;
    const folders = await ensureFolders(this.api, this.config, this.props, this.conn.folders);
    this.conn = { ...this.conn, folders };
    await this.store.setMeta("conn", this.conn);
  }

  // --------------------------------------------------------------- push (one item)

  private async link(kind: string, id: string, file: DriveFile, hash: string, mediaFileId?: string): Promise<void> {
    const cur = await this.store.getItem(kind, id);
    await this.store.putItem({
      kind,
      id,
      driveFileId: file.id,
      lastSyncedHash: hash,
      lastRemoteVersion: file.version,
      mediaFileId: cur?.mediaFileId ?? mediaFileId,
    });
  }

  /** `prev` can be a stub (no `driveFileId`) that only remembers the media file of an item whose sidecar isn't in Drive yet. */
  private async pushCreate(h: Handler, id: string, local: LocalDoc, prev: SyncItem | undefined): Promise<void> {
    const spec = await h.createSpec(id, local);
    const file = await this.api.createFile(
      { name: spec.name, mimeType: spec.mimeType, parents: [spec.parent], appProperties: this.props.tag(h.driveKind, id) },
      new Blob([local.body], { type: spec.mimeType })
    );
    await this.store.putItem({
      kind: h.kind,
      id,
      driveFileId: file.id,
      lastSyncedHash: local.hash,
      lastRemoteVersion: file.version,
      mediaFileId: prev?.mediaFileId,
      mediaRev: prev?.mediaRev,
    });
  }

  private async pushUpdate(h: Handler, id: string, item: SyncItem, local: LocalDoc, remoteMeta: DriveFile): Promise<void> {
    let file = await this.api.updateMedia(item.driveFileId, new Blob([local.body], { type: h.bodyMime }));
    file = await h.afterUpdate(id, item, local, file, remoteMeta);
    await this.store.putItem({ ...item, lastSyncedHash: local.hash, lastRemoteVersion: file.version });
  }

  // ------------------------------------------------------------------- queue

  private async flush(): Promise<void> {
    if (!this.conn) return;
    let quota = false;
    for (const q of await this.store.listQueue()) {
      this.activity++;
      this.touched.delete(q.key);
      try {
        await this.runOp(q);
        if (!this.touched.has(q.key)) await this.store.dequeue(q.key);
      } catch (e) {
        const c = classify(e);
        if (c === "notFound") {
          await this.onKnownFileMissing(q);
          if (!this.touched.has(q.key)) await this.store.dequeue(q.key);
          continue;
        }
        if (c === "full" && q.op === "uploadMedia") {
          quota = true;
          continue; // keep it queued; metadata keeps syncing
        }
        await this.store.updateQueueItem(q.key, { attempts: q.attempts + 1 }).catch(() => undefined); // best effort; the original error is rethrown below
        throw e;
      }
    }
    this.flags.driveFull = quota;
  }

  private async runOp(q: QueueItem): Promise<void> {
    if (!this.handlers.has(q.kind)) return; // queued by an older version of the site for a kind it no longer declares
    if (q.op === "upsert") await this.pushUpsert(q.kind, q.id);
    else if (q.op === "delete") await this.pushDelete(q.kind, q.id);
    else await this.filesHandler(q.kind).uploadMedia(q);
  }

  /** A 404 on a file we know about means it was deleted in Drive. */
  private async onKnownFileMissing(q: QueueItem): Promise<void> {
    const item = await this.store.getItem(q.kind, q.id);
    if (q.op === "delete") {
      await this.store.deleteItem(q.kind, q.id);
      return;
    }
    if (!item) return;
    if (q.op === "uploadMedia") {
      await this.store.putItem({ ...item, mediaFileId: undefined });
      return;
    }
    await this.remoteGone(q.kind, q.id);
  }

  private async pushDelete(kind: string, id: string): Promise<void> {
    const item = await this.store.getItem(kind, id);
    if (!item) return;
    const trash = async (fileId: string) => {
      try {
        await this.api.trash(fileId);
      } catch (e) {
        if (classify(e) !== "notFound") throw e;
      }
    };
    if (item.driveFileId) await trash(item.driveFileId);
    if (item.mediaFileId) await trash(item.mediaFileId);
    await this.store.deleteItem(kind, id);
    if (this.handlers.get(kind) instanceof FilesHandler) await this.store.deleteMeta(updatedAtKey(kind, id));
  }

  private async pushUpsert(kind: string, id: string): Promise<void> {
    const h = this.handler(kind);
    if (this.conflicts.some((c) => c.kind === kind && c.id === id)) return;
    const local = await h.readLocal(id);
    if (!local) return;
    const item = await this.store.getItem(kind, id);
    if (!item?.driveFileId) return this.pushCreate(h, id, local, item);
    if (item.lastSyncedHash === local.hash) return;
    const meta = await this.api.getMetadata(item.driveFileId);
    if (meta.trashed) return this.remoteGone(kind, id);
    if (meta.version !== item.lastRemoteVersion) {
      const remote = await h.readRemote(id, meta);
      if (remote && remote.hash !== item.lastSyncedHash) {
        if (remote.hash === local.hash) return this.link(kind, id, meta, local.hash);
        const outcome = await this.bothChanged(h, id, item, local, remote, meta);
        if (outcome === "done") return;
        // newest wins and local is newer: fall through and overwrite
        item.lastRemoteVersion = meta.version;
      } else {
        item.lastRemoteVersion = meta.version; // only metadata (name) changed remotely
      }
    }
    await this.pushUpdate(h, id, item, local, meta);
  }

  // ---------------------------------------------------------------- reconcile

  /**
   * Both sides changed, with different content. Collections that ask become conflicts; the others
   * resolve by newest updatedAt. Returns "pushLocal" when local should overwrite Drive.
   */
  private async bothChanged(
    h: Handler,
    id: string,
    item: SyncItem | undefined,
    local: LocalDoc,
    remote: RemoteDoc,
    file: DriveFile
  ): Promise<"done" | "pushLocal"> {
    const kind = h.kind;
    if (h.conflicts === "ask") {
      const conflict: Conflict = {
        kind,
        id,
        localTitle: local.title,
        remoteTitle: h.remoteTitle(id, remote),
        localText: local.body,
        remoteText: remote.text,
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
        driveFileId: file.id,
        remoteVersion: file.version,
      };
      // The item keeps the OLD remote version until resolved, so a later pull still sees a newer one.
      if (!item) await this.link(kind, id, file, "");
      this.conflicts = [...this.conflicts.filter((c) => !(c.kind === kind && c.id === id)), conflict];
      await this.persistLists();
      await this.store.dequeue(queueKey("upsert", kind, id));
      this.emit();
      return "done";
    }
    if (remote.updatedAt > local.updatedAt) {
      const applied = await h.applyRemote(id, remote);
      await this.link(kind, id, file, applied.hash, applied.mediaFileId);
      return "done";
    }
    await this.link(kind, id, file, item?.lastSyncedHash ?? "");
    return "pushLocal";
  }

  private async reconcileRemote(kind: string, id: string, file: DriveFile): Promise<void> {
    const h = this.handler(kind);
    const raw = await this.store.getItem(kind, id);
    const item = raw?.driveFileId ? raw : undefined; // a stub only remembers a media file
    if (item && item.driveFileId !== file.id) return; // a duplicate file for the same id
    if (item && item.lastRemoteVersion === file.version) return; // echo of our own write
    this.dropPendingDelete(kind, id);

    const remote = await h.readRemote(id, file);
    if (!remote) return;
    const conflict = this.conflicts.find((c) => c.kind === kind && c.id === id);
    if (conflict) {
      conflict.remoteText = remote.text;
      conflict.remoteTitle = h.remoteTitle(id, remote);
      conflict.remoteUpdatedAt = remote.updatedAt;
      conflict.remoteVersion = file.version;
      await this.persistLists();
      this.emit();
      return;
    }
    const local = await h.readLocal(id);
    if (!local) {
      if (raw) return; // deleted locally; the queued delete will trash the file
      const applied = await h.applyRemote(id, remote);
      await this.link(kind, id, file, applied.hash, applied.mediaFileId);
      return;
    }
    if (!item) {
      if (local.hash === remote.hash) return this.link(kind, id, file, local.hash);
      await this.settleBoth(h, id, undefined, local, remote, file);
      return;
    }
    if (remote.hash === item.lastSyncedHash) {
      await this.store.putItem({ ...item, lastRemoteVersion: file.version }); // rename or no-op
      return;
    }
    if (local.hash === item.lastSyncedHash) {
      const applied = await h.applyRemote(id, remote);
      await this.link(kind, id, file, applied.hash, applied.mediaFileId);
      return;
    }
    if (local.hash === remote.hash) return this.link(kind, id, file, local.hash);
    await this.settleBoth(h, id, item, local, remote, file);
  }

  private async settleBoth(h: Handler, id: string, item: SyncItem | undefined, local: LocalDoc, remote: RemoteDoc, file: DriveFile): Promise<void> {
    const outcome = await this.bothChanged(h, id, item, local, remote, file);
    if (outcome === "pushLocal") {
      await this.enqueue("upsert", h.kind, id);
      this.needFlush = true;
    }
  }

  private dropPendingDelete(kind: string, id: string): void {
    const before = this.pendingDeletes.length;
    this.pendingDeletes = this.pendingDeletes.filter((d) => !(d.kind === kind && d.id === id));
    if (this.pendingDeletes.length !== before) void this.persistLists();
  }

  /**
   * Drive deleted or trashed this file. Per the collection's `remoteDelete`: `ask` queues the question,
   * `follow` deletes the local item, `ignore` keeps it and only forgets the link (settings always ignore).
   */
  private async remoteGone(kind: string, id: string): Promise<void> {
    const h = this.handler(kind);
    if (h.remoteDelete === "ignore") {
      await this.store.deleteItem(kind, id);
      return;
    }
    await this.store.dequeue(queueKey("upsert", kind, id));
    const title = await h.localTitle(id);
    if (title === undefined) {
      await this.store.deleteItem(kind, id);
      return;
    }
    if (h.remoteDelete === "follow") {
      await this.dropLocal(h, id);
      return;
    }
    if (!this.pendingDeletes.some((d) => d.kind === kind && d.id === id)) {
      this.pendingDeletes = [...this.pendingDeletes, { kind, id, title }];
      await this.persistLists();
      this.emit();
    }
  }

  /** Deletes the local item and forgets everything the engine knows about it. */
  private async dropLocal(h: Handler, id: string): Promise<void> {
    await h.deleteLocal(id);
    await this.store.deleteItem(h.kind, id);
    await this.store.dequeue(queueKey("upsert", h.kind, id));
    await this.store.dequeue(queueKey("uploadMedia", h.kind, id));
  }

  // --------------------------------------------------------------------- pull

  private async pullInternal(): Promise<void> {
    let token = await this.store.getMeta<string>("changesPageToken");
    if (!token) {
      await this.store.setMeta("changesPageToken", await this.api.getStartPageToken());
      return;
    }
    for (;;) {
      const page = await this.api.listChanges(token);
      if (page.changes.length > 0) this.activity++;
      for (const ch of page.changes) await this.handleRemoteChange(ch.fileId, ch.removed ? undefined : ch.file);
      if (page.nextPageToken) {
        token = page.nextPageToken;
        await this.store.setMeta("changesPageToken", token);
      } else {
        if (page.newStartPageToken) await this.store.setMeta("changesPageToken", page.newStartPageToken);
        return;
      }
    }
  }

  /** Dispatches by the file's kind tag; files of a kind this site doesn't declare are ignored. */
  private async handleRemoteChange(fileId: string, file?: DriveFile): Promise<void> {
    if (!file || file.trashed) return this.onFileGone(fileId);
    const { kind, id } = this.props.read(file);
    if (!kind || !id) return;
    const target = this.byDriveKind.get(kind);
    if (!target) return;
    if (target.role === "media") return this.filesHandler(target.handler.kind).attachMedia(id, file);
    return this.reconcileRemote(target.handler.kind, target.handler.kind === SETTINGS_KIND ? SETTINGS_ID : id, file);
  }

  private async onFileGone(fileId: string): Promise<void> {
    for (const item of await this.store.listItems()) {
      if (item.driveFileId === fileId) {
        if (this.handlers.has(item.kind)) await this.remoteGone(item.kind, item.id);
      } else if (item.mediaFileId === fileId && this.handlers.get(item.kind) instanceof FilesHandler) {
        await this.store.putItem({ ...item, mediaFileId: undefined });
      }
    }
  }

  private async mergeFirstConnect(): Promise<void> {
    for (const h of this.handlers.values()) {
      const files = await listAllFiles(this.api, { appProperties: { [this.props.kindKey]: h.driveKind } });
      const seen = new Set<string>();
      for (const f of files) {
        const id = h.kind === SETTINGS_KIND ? SETTINGS_ID : this.props.read(f).id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        await this.reconcileRemote(h.kind, id, f);
      }
    }
    for (const col of this.config.files) {
      const h = this.filesHandler(col.kind);
      for (const f of await listAllFiles(this.api, { appProperties: { [this.props.kindKey]: col.kind } })) {
        const id = this.props.read(f).id;
        if (id) await h.attachMedia(id, f);
      }
    }
    if (this.needFlush) this.needFlush = false;
  }

  // ----------------------------------------------------------- conflict/deletes

  async resolveConflict(kind: string, id: string, choice: "local" | "remote" | "both"): Promise<void> {
    await this.ready;
    return this.exclusive(async () => {
      const c = this.conflicts.find((x) => x.kind === kind && x.id === id);
      if (!c) return;
      const h = this.documentsHandler(kind);
      const item = await this.store.getItem(kind, id);
      if (choice === "remote") {
        const applied = await h.applyRemote(id, { text: c.remoteText, hash: "", updatedAt: c.remoteUpdatedAt });
        await this.store.putItem({
          kind,
          id,
          driveFileId: c.driveFileId,
          lastSyncedHash: applied.hash,
          lastRemoteVersion: c.remoteVersion,
        });
      } else {
        if (choice === "both") {
          const newId = this.randomId();
          const remoteItem = h.col.fromFile(c.remoteText, newId);
          await h.col.store.save(newId, h.col.onKeepBoth ? h.col.onKeepBoth(remoteItem) : remoteItem);
          await this.enqueue("upsert", kind, newId);
        }
        // Local overwrites Drive: acknowledge the remote version, keep the local change pending.
        await this.store.putItem({
          kind,
          id,
          driveFileId: c.driveFileId,
          lastSyncedHash: item?.lastSyncedHash ?? "",
          lastRemoteVersion: c.remoteVersion,
        });
        await this.enqueue("upsert", kind, id);
      }
      this.conflicts = this.conflicts.filter((x) => !(x.kind === kind && x.id === id));
      await this.persistLists();
      this.emit();
      await this.doSync(true);
    });
  }

  /** `items` come from `pendingRemoteDeletes`. Accepting deletes them here; declining uploads them again. */
  async resolveRemoteDeletes(items: { kind: string; id: string }[], accept: boolean): Promise<void> {
    await this.ready;
    return this.exclusive(async () => {
      const chosen = this.pendingDeletes.filter((d) => items.some((i) => i.kind === d.kind && i.id === d.id));
      for (const d of chosen) {
        const h = this.handler(d.kind);
        if (accept) {
          await this.dropLocal(h, d.id);
        } else {
          // Re-upload: forget the link so the next push creates the file again (keeping a known media file).
          const item = await this.store.getItem(d.kind, d.id);
          await this.store.deleteItem(d.kind, d.id);
          if (item?.mediaFileId) {
            await this.store.putItem({
              kind: d.kind,
              id: d.id,
              driveFileId: "",
              lastSyncedHash: "",
              lastRemoteVersion: "",
              mediaFileId: item.mediaFileId,
              mediaRev: item.mediaRev,
            });
          }
          await this.enqueue("upsert", d.kind, d.id);
        }
      }
      this.pendingDeletes = this.pendingDeletes.filter((d) => !chosen.includes(d));
      await this.persistLists();
      this.emit();
      await this.doSync(true);
    });
  }

  // ------------------------------------------------------------------- media

  /** Queues a manual upload of the item's media and runs it now. */
  async upload(kind: string, id: string): Promise<void> {
    await this.ready;
    this.filesHandler(kind);
    if (!this.conn) throw new Error("Drive is not connected.");
    await this.enqueue("upsert", kind, id);
    await this.enqueue("uploadMedia", kind, id);
    await this.syncNow();
  }

  /** Downloads the item's media from Drive, stores it locally (silently) and returns it. */
  async download(kind: string, id: string, onProgress?: (fraction: number) => void): Promise<Blob> {
    await this.ready;
    const blob = await this.filesHandler(kind).download(id, onProgress);
    await this.refreshStatus(kind, id);
    this.emit();
    return blob;
  }

  /** Frees the local copy of an item that is in Drive. */
  async removeLocal(kind: string, id: string): Promise<void> {
    await this.ready;
    await this.filesHandler(kind).removeLocal(id);
    await this.refreshStatus(kind, id);
    this.emit();
  }

  // ------------------------------------------------------------------ import

  /**
   * Adopts files the user picked in Drive: a documents collection's `adopt` files and a files
   * collection's `importMedia` files. Returns the new local ids per kind.
   */
  async importFiles(fileIds: string[]): Promise<Record<string, string[]>> {
    await this.ready;
    if (!this.conn) throw new Error("Drive is not connected.");
    return this.exclusive(async () => {
      await this.ensureMissingFolders();
      const out: Record<string, string[]> = {};
      for (const col of this.config.documents) if (col.adopt) out[col.kind] = [];
      for (const col of this.config.files) if (col.importMedia) out[col.kind] = [];
      for (const fileId of fileIds) {
        const file = await this.api.getMetadata(fileId);
        const target = this.importTarget(file);
        if (!target) continue;
        const tagged = this.props.read(file);
        const existingId = tagged.kind === target.kind ? tagged.id : undefined;
        const id = existingId ?? this.randomId();
        const h = this.handler(target.kind);
        if (h instanceof DocumentsHandler) {
          if (!(await h.importFile(file, id, existingId))) continue;
        } else if (h instanceof FilesHandler) {
          if (!(await h.importFile(file, id, existingId))) continue;
        }
        out[target.kind].push(id);
      }
      await this.doSync(true);
      return out;
    });
  }

  /** Documents are tried before media, in the order the site declared them. */
  private importTarget(file: DriveFile): { kind: string } | undefined {
    for (const col of this.config.documents) {
      const h = this.documentsHandler(col.kind);
      if (h.accepts(file)) return { kind: col.kind };
    }
    for (const col of this.config.files) {
      if (this.filesHandler(col.kind).accepts(file)) return { kind: col.kind };
    }
    return undefined;
  }
}
