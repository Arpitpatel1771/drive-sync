// Types shared by the engine and its collection handlers.

import type { DriveApi, DriveFile } from "../drive/api";
import type { ResolvedConfig } from "../config";
import type { Props } from "../props";
import type { SyncItem, SyncStore } from "../store/syncStore";

export type SyncState = "disconnected" | "idle" | "syncing" | "offline" | "authRequired" | "retrying" | "driveFull";

export interface Conflict {
  kind: string;
  id: string;
  localTitle: string;
  remoteTitle: string;
  localText: string;
  remoteText: string;
  /** Epoch ms. */
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  driveFileId: string;
  remoteVersion: string;
}

export interface PendingRemoteDelete {
  kind: string;
  id: string;
  title: string;
}

export type ItemStatus = "local" | "uploading" | "inDrive" | "notDownloaded" | "otherDevice";

export interface SyncStatus {
  state: SyncState;
  email: string | null;
  /** Google display name and picture URL (cosmetic; null until known). */
  name: string | null;
  picture: string | null;
  lastSyncAt: number | null;
  conflicts: Conflict[];
  pendingRemoteDeletes: PendingRemoteDelete[];
  /** Upload progress 0..1 per `kind:id`, for items whose media is being uploaded right now. */
  uploads: Record<string, number>;
  /** Message of the last unexpected error (for a toast), or null. */
  error: string | null;
}

/** Stored under meta `conn`. `folders` is keyed by folder id: `root`, `hidden`, each collection's folder id, each file collection's metaFolder id. */
export interface Connection {
  email: string | null;
  folders: Record<string, string>;
}

export interface LocalDoc {
  body: string;
  hash: string;
  updatedAt: number;
  title: string;
  /** The local item this was read from (the site's own type). */
  item: unknown;
}

export interface RemoteDoc {
  text: string;
  hash: string;
  updatedAt: number;
  /** Parsed JSON body for settings and file-collection sidecars. */
  json?: Record<string, unknown>;
}

/** What the engine needs from itself inside a handler. */
export interface HandlerContext {
  readonly api: DriveApi;
  readonly store: SyncStore;
  readonly config: ResolvedConfig;
  readonly props: Props;
  now(): number;
  /** Drive folder id for a folder id of the config (`root`, `hidden`, a collection folder...). */
  folder(id: string): string;
}

/** Everything the engine does per kind of synced thing (a documents collection, a files collection's sidecars, settings). */
export interface Handler {
  /** The SyncItem / queue kind. `settings` for settings. */
  readonly kind: string;
  /** MIME type of the item's own Drive file. */
  readonly bodyMime: string;
  /** The appProperties kind of the item's own Drive file (`kind`, `${kind}Meta` or `settings`). */
  readonly driveKind: string;
  readonly conflicts: "ask" | "newest";
  readonly remoteDelete: "ask" | "follow" | "ignore";
  /** Ids of every local item. */
  listIds(): Promise<string[]>;
  readLocal(id: string): Promise<LocalDoc | null>;
  readRemote(id: string, file: DriveFile): Promise<RemoteDoc | null>;
  /** Applies a remote document locally (silently). Returns the resulting local content hash, and the media file id when one was found. */
  applyRemote(id: string, remote: RemoteDoc): Promise<{ hash: string; mediaFileId?: string }>;
  /** Name, parent folder and MIME type for a new Drive file. */
  createSpec(id: string, local: LocalDoc): Promise<{ name: string; parent: string; mimeType: string }>;
  /** Runs after the content of an existing file was replaced; may rename it. Returns the file as it is now. */
  afterUpdate(id: string, item: SyncItem, local: LocalDoc, file: DriveFile, remoteMeta: DriveFile): Promise<DriveFile>;
  /** Title of the local item (for the "deleted in Drive" question); undefined when it no longer exists locally. */
  localTitle(id: string): Promise<string | undefined>;
  remoteTitle(id: string, remote: RemoteDoc): string;
  /** Removes the local item (silently), after a remote delete the user accepted or the collection follows. */
  deleteLocal(id: string): Promise<void>;
}
