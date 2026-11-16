// The public facade: `createDriveSync(config)` wires the real (or injected) Drive api, auth and store into a
// SyncEngine, lazily, so constructing it never touches window, localStorage or IndexedDB.

import { isConfigured, resolveConfig, type CollectionLabel, type DriveSyncConfig, type ResolvedConfig } from "./config";
import { RestDriveApi, type DriveApi } from "./drive/api";
import { GisDriveAuth, type DriveAuth } from "./drive/auth";
import { pickDriveFiles } from "./drive/picker";
import { SyncEngine, type Conflict, type ItemStatus, type PendingRemoteDelete, type SyncStatus } from "./engine/engine";
import { createIdbSyncStore } from "./store/idbSyncStore";
import { createMemorySyncStore } from "./store/memorySyncStore";
import type { SyncStore } from "./store/syncStore";
import { FakeAuth } from "./testing/fakeAuth";
import { FakeDrive } from "./testing/fakeDrive";

export type PickFiles = (opts: { token: string; apiKey: string; appId: string; mimeTypes: string[] }) => Promise<string[]>;

export interface DriveSyncDeps {
  api?: DriveApi;
  auth?: DriveAuth;
  store?: SyncStore;
  /** Replaces the Google Picker (tests). */
  pick?: PickFiles;
}

/** Read-only description of a declared collection, for UI (upload-setting controls, import messages). */
export interface DriveCollectionInfo {
  kind: string;
  /** What people call the kind (default: the kind itself for both forms). */
  label: CollectionLabel;
  type: "documents" | "files";
  /** Choices for a files collection's upload setting; empty for documents. */
  uploadSettings: { value: string; label: string }[];
  /** The files collection's default upload setting; "" for documents. */
  defaultUploadSetting: string;
}

export interface DriveSync {
  /** The site's declared collections, in config order. */
  readonly collections: readonly DriveCollectionInfo[];
  /** False when the Google client id, api key or app id is missing: every action then rejects with "not configured". */
  readonly configured: boolean;
  readonly status: SyncStatus;
  readonly conflicts: Conflict[];
  readonly pendingDeletes: PendingRemoteDelete[];
  /** Resumes a stored connection (silently) and starts syncing. Safe to call more than once. No-op when not configured. */
  start(): Promise<void>;
  /** Stops syncing and timers. No-op when not configured. */
  stop(): void;
  /** Calls `cb` with the new status on every change. Returns an unsubscribe function. */
  subscribe(cb: (status: SyncStatus) => void): () => void;
  /** Interactive Google sign-in and first sync. Must be called from a user gesture (click or tap): it can open a Google popup. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  syncNow(): Promise<void>;
  resolveConflict(kind: string, id: string, choice: "local" | "remote" | "both"): Promise<void>;
  confirmDeletes(items: { kind: string; id: string }[], accept: boolean): Promise<void>;
  upload(kind: string, id: string): Promise<void>;
  download(kind: string, id: string, onProgress?: (fraction: number) => void): Promise<Blob>;
  removeLocal(kind: string, id: string): Promise<void>;
  itemStatus(kind: string, id: string): ItemStatus;
  uploadSetting(kind: string): string;
  setUploadSetting(kind: string, value: string): Promise<void>;
  /**
   * Opens the Google Picker and adopts the chosen files. Must be called from a user gesture (click or tap): it asks
   * Google for a token and opens the picker, which can open popups. Returns the number of new items per collection kind.
   */
  importFromDrive(): Promise<Record<string, number>>;
}

const DISCONNECTED: SyncStatus = Object.freeze({
  state: "disconnected",
  email: null,
  name: null,
  picture: null,
  lastSyncAt: null,
  conflicts: Object.freeze([]) as unknown as SyncStatus["conflicts"],
  pendingRemoteDeletes: Object.freeze([]) as unknown as SyncStatus["pendingRemoteDeletes"],
  uploads: Object.freeze({}) as SyncStatus["uploads"],
  error: null,
});

const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/** MIME types the picker should offer: documents' `adopt.extensions` plus files' `importMedia.mimeTypes`, de-duplicated. */
export function importMimeTypes(config: ResolvedConfig): string[] {
  const out = new Set<string>();
  for (const col of config.documents) {
    for (const ext of col.adopt?.extensions ?? []) out.add(MIME_BY_EXTENSION[ext.toLowerCase()] ?? col.mimeType);
  }
  for (const col of config.files) for (const m of col.importMedia?.mimeTypes ?? []) out.add(m);
  return [...out];
}

function fakeModeRequested(config: DriveSyncConfig): boolean {
  if (!config.devFake) return false;
  try {
    return localStorage.getItem(`${config.namespace}.fakeDrive`) === "1";
  } catch {
    return false;
  }
}

export function createDriveSync(config: DriveSyncConfig, deps: DriveSyncDeps = {}): DriveSync {
  const resolved = resolveConfig(config); // throws on a bad config, configured or not
  const hasGoogle = isConfigured(config);
  const injected = Boolean(deps.api && deps.auth);
  // Fake mode is decided on first use, because it reads localStorage.
  let fakeMode: boolean | null = null;
  const isFake = () => (fakeMode ??= !injected && fakeModeRequested(config));
  const usable = () => injected || isFake() || hasGoogle;

  const listeners = new Set<(s: SyncStatus) => void>();
  let engine: SyncEngine | null = null;
  let auth: DriveAuth | null = null;
  let store: SyncStore | null = null;
  let stopTimers: (() => void) | null = null;
  let started: Promise<void> | null = null;

  const notConfigured = () => new Error(`Drive sync is not configured for "${config.namespace}": the Google client id, API key and app id are required.`);

  function need(): SyncEngine {
    if (engine) return engine;
    if (!usable()) throw notConfigured();
    let api = deps.api;
    let a = deps.auth;
    let s = deps.store;
    if (isFake()) {
      api ??= new FakeDrive({ namespace: config.namespace });
      a ??= new FakeAuth();
      s ??= createMemorySyncStore();
    } else {
      a ??= new GisDriveAuth({ clientId: config.google.clientId, namespace: config.namespace });
      const authForApi = a;
      api ??= new RestDriveApi(() => authForApi.getToken({ interactive: false }));
      s ??= createIdbSyncStore(`${config.namespace}-sync`);
    }
    auth = a;
    store = s;
    engine = new SyncEngine({ config: resolved, api, auth: a, store: s });
    engine.onStatus((st) => {
      for (const cb of [...listeners]) cb(st);
    });
    return engine;
  }

  const timers = () => {
    stopTimers?.();
    stopTimers = engine ? engine.handleVisibilityAndTimers() : null;
  };

  const reject = <T>(fn: (e: SyncEngine) => Promise<T>): Promise<T> => {
    try {
      return fn(need());
    } catch (e) {
      return Promise.reject(e);
    }
  };

  function fileCollection(kind: string) {
    const col = resolved.files.find((c) => c.kind === kind);
    if (!col) throw new Error(`"${kind}" is not a file collection`);
    return col;
  }

  const collections: DriveCollectionInfo[] = [...resolved.byKind.values()].map((c) =>
    c.type === "files"
      ? { kind: c.kind, label: c.label ?? { one: c.kind, other: c.kind }, type: "files", uploadSettings: c.uploadSettings.map((u) => ({ value: u.value, label: u.label })), defaultUploadSetting: c.defaultUploadSetting }
      : { kind: c.kind, label: c.label ?? { one: c.kind, other: c.kind }, type: "documents", uploadSettings: [], defaultUploadSetting: "" },
  );

  const currentStatus = (): SyncStatus => (engine ? engine.getStatus() : DISCONNECTED);

  return {
    collections,
    get configured() {
      return usable();
    },
    get status() {
      return currentStatus();
    },
    get conflicts() {
      return currentStatus().conflicts;
    },
    get pendingDeletes() {
      return currentStatus().pendingRemoteDeletes;
    },

    start() {
      if (!usable()) return Promise.resolve();
      started ??= (async () => {
        const e = need();
        timers();
        try {
          if (await store!.getMeta("conn")) await e.connect({ interactive: false });
        } catch (err) {
          config.onError?.(err instanceof Error ? err.message : String(err));
        }
      })();
      return started;
    },
    stop() {
      stopTimers?.();
      stopTimers = null;
      engine?.stop();
      started = null;
    },
    subscribe(cb) {
      if (!usable()) return () => undefined;
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async connect() {
      const e = need();
      await e.connect({ interactive: true });
      timers();
    },
    disconnect: () => reject((e) => e.disconnect()),
    syncNow: () => reject((e) => e.syncNow()),
    resolveConflict: (kind, id, choice) => reject((e) => e.resolveConflict(kind, id, choice)),
    confirmDeletes: (items, accept) => reject((e) => e.resolveRemoteDeletes(items, accept)),
    upload: (kind, id) => reject((e) => e.upload(kind, id)),
    download: (kind, id, onProgress) => reject((e) => e.download(kind, id, onProgress)),
    removeLocal: (kind, id) => reject((e) => e.removeLocal(kind, id)),
    itemStatus(kind, id) {
      if (!usable()) throw notConfigured();
      return engine ? engine.itemStatus(kind, id) : "local";
    },
    uploadSetting(kind) {
      if (!usable()) throw notConfigured();
      return engine ? engine.getUploadSetting(kind) : fileCollection(kind).defaultUploadSetting;
    },
    setUploadSetting: (kind, value) => reject((e) => e.setUploadSetting(kind, value)),

    importFromDrive() {
      return reject(async (e) => {
        const counts: Record<string, number> = {};
        for (const col of resolved.byKind.values()) counts[col.kind] = 0;
        const token = await auth!.getToken({ interactive: true });
        const pick = deps.pick ?? pickDriveFiles;
        const ids = await pick({ token, apiKey: config.google.apiKey, appId: config.google.appId, mimeTypes: importMimeTypes(resolved) });
        if (ids.length === 0) return counts;
        const added = await e.importFiles(ids);
        for (const [kind, list] of Object.entries(added)) counts[kind] = list.length;
        return counts;
      });
    },
  };
}
