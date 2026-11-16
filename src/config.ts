export interface FolderSpec {
  /** Stable id stored in the folder's appProperties (Taalmel: `songs`, `recordings`, `clips`). Unique per site. */
  id: string;
  /** Folder name shown in Drive. */
  name: string;
}

export interface ChangeEvent {
  type: "save" | "delete";
  id: string;
}

/**
 * The site's own storage for one collection.
 *
 * CONTRACT: call `onChange` listeners for the user's own local changes only. The engine itself writes through
 * `save`, `remove` and `setBlob` when it pulls from Drive; the site must NOT call its `onChange` callbacks for
 * those writes, or every pull would be pushed straight back.
 */
export interface DocumentStore<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  save(id: string, item: T): Promise<void>;
  remove(id: string): Promise<void>;
  /** Subscribe to local changes; returns an unsubscribe function. See the contract above. */
  onChange(cb: (change: ChangeEvent) => void): () => void;
}

/** Store for file collections: a document store plus the media blob. Same `onChange` contract applies to `setBlob`. */
export interface FileStore<T> extends DocumentStore<T> {
  getBlob(id: string): Promise<Blob | null>;
  /** `null` removes the media from this device. */
  setBlob(id: string, blob: Blob | null): Promise<void>;
}

/** How people see a collection's kind: `one` for a single item, `other` for several. Default: the kind itself. */
export interface CollectionLabel {
  one: string;
  other: string;
}

export interface DocumentCollectionOptions<T> {
  kind: string;
  /** Shown to people wherever the package names the kind (remote-delete list, import message, upload heading). */
  label?: CollectionLabel;
  folder: FolderSpec;
  extension: string;
  mimeType: string;
  store: DocumentStore<T>;
  idOf(item: T): string;
  toFile(item: T): string;
  fromFile(text: string, id: string, existing?: T): T;
  fileName(item: T): string;
  titleOf(item: T): string;
  updatedAt(item: T): number;
  /** Default `"ask"`. */
  conflicts?: "ask" | "newest";
  /** Default `"ask"`. */
  remoteDelete?: "ask" | "follow" | "ignore";
  /** Builds the item saved when the user keeps both versions on a conflict. */
  onKeepBoth?(remote: T): T;
  /** Untagged files picked via Import. */
  adopt?: { extensions: string[] };
}

export interface DocumentCollection<T = any> extends DocumentCollectionOptions<T> {
  type: "documents";
  conflicts: "ask" | "newest";
  remoteDelete: "ask" | "follow" | "ignore";
}

export interface UploadSetting {
  value: string;
  label: string;
}

export interface FileCollectionOptions<T> {
  kind: string;
  /** Shown to people wherever the package names the kind (remote-delete list, import message, upload heading). */
  label?: CollectionLabel;
  folder: FolderSpec;
  /** Folder (under the hidden folder) holding the `<id>.json` sidecars. */
  metaFolder: FolderSpec;
  store: FileStore<T>;
  idOf(item: T): string;
  meta(item: T): Record<string, unknown>;
  fromMeta(meta: Record<string, unknown>, id: string, existing?: T): T;
  fileName(item: T): string;
  mimeType(item: T): string;
  titleOf(item: T): string;
  uploadPolicy(item: T, setting: string): boolean;
  uploadSettings: UploadSetting[];
  defaultUploadSetting: string;
  /** Default `"ask"`. */
  remoteDelete?: "ask" | "follow" | "ignore";
  importMedia?: { mimeTypes: string[]; create(blob: Blob, name: string, id: string): Promise<T> };
  /**
   * For sites migrating from a store that kept the Drive media file id on the item itself (Taalmel's
   * `clip.driveFileId`). Run once per device: the id is copied into the engine's own sync record.
   */
  legacyMediaFileId?(item: T): string | undefined;
}

export interface FileCollection<T = any> extends FileCollectionOptions<T> {
  type: "files";
  remoteDelete: "ask" | "follow" | "ignore";
}

export type Collection = DocumentCollection | FileCollection;

export function documents<T>(opts: DocumentCollectionOptions<T>): DocumentCollection<T> {
  return { conflicts: "ask", remoteDelete: "ask", ...opts, type: "documents" } as DocumentCollection<T>;
}

export function files<T>(opts: FileCollectionOptions<T>): FileCollection<T> {
  return { remoteDelete: "ask", ...opts, type: "files" } as FileCollection<T>;
}

/** Optional site settings synced as `<hiddenFolder>/settings.json`. */
export interface SettingsSync<S = any> {
  load(): Promise<S>;
  save(s: S): Promise<void>;
  onChange(cb: () => void): () => void;
  /** Fields that never leave this device. */
  deviceLocal: (keyof S)[];
}

export interface DriveSyncConfig {
  google: { clientId: string; apiKey: string; appId: string };
  /** Root folder name in Drive. */
  appName: string;
  /** Prefix for appProperties, IndexedDB and localStorage keys. */
  namespace: string;
  collections: Collection[];
  settings?: SettingsSync;
  /** Default `"." + namespace`. */
  hiddenFolder?: string;
  onError?: (message: string) => void;
  devFake?: boolean;
}

export interface ResolvedConfig extends DriveSyncConfig {
  hiddenFolder: string;
  documents: DocumentCollection[];
  files: FileCollection[];
  byKind: Map<string, Collection>;
}

const RESERVED_KINDS = ["folder", "settings"];
const BUILT_IN_FOLDER_IDS = ["root", "hidden"];

/** Validates the config (throws `Error` on the first problem) and fills defaults. */
export function resolveConfig(c: DriveSyncConfig): ResolvedConfig {
  if (typeof c.namespace !== "string" || !/^[A-Za-z0-9_-]+$/.test(c.namespace)) {
    throw new Error(`namespace "${c.namespace}" must be non-empty and use only letters, digits, "-" and "_"`);
  }
  const cols = c.collections;

  for (const col of cols) {
    if (typeof col.kind !== "string" || col.kind.trim() === "") throw new Error("a collection has an empty kind");
  }

  const seen = new Set<string>();
  for (const col of cols) {
    if (seen.has(col.kind)) throw new Error(`duplicate kind "${col.kind}"`);
    seen.add(col.kind);
  }

  const sidecarKinds = new Set(cols.filter((x) => x.type === "files").map((x) => `${x.kind}Meta`));
  for (const col of cols) {
    if (RESERVED_KINDS.includes(col.kind) || sidecarKinds.has(col.kind)) {
      throw new Error(`kind "${col.kind}" is reserved`);
    }
  }

  for (const col of cols) {
    if (col.kind.includes(":")) throw new Error(`kind "${col.kind}" must not contain ":"`);
  }

  const folderIds = new Set<string>(BUILT_IN_FOLDER_IDS);
  for (const col of cols) {
    const ids = col.type === "files" ? [col.folder.id, col.metaFolder.id] : [col.folder.id];
    for (const id of ids) {
      if (folderIds.has(id)) throw new Error(`folder id "${id}" is used twice`);
      folderIds.add(id);
    }
  }

  return {
    ...c,
    hiddenFolder: c.hiddenFolder ?? `.${c.namespace}`,
    documents: cols.filter((x): x is DocumentCollection => x.type === "documents"),
    files: cols.filter((x): x is FileCollection => x.type === "files"),
    byKind: new Map(cols.map((x) => [x.kind, x])),
  };
}

/** True only when clientId, apiKey and appId are all non-empty strings. */
export function isConfigured(c: Pick<DriveSyncConfig, "google">): boolean {
  const g = c.google;
  return [g.clientId, g.apiKey, g.appId].every((v) => typeof v === "string" && v.length > 0);
}
