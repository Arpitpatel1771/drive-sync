export const VERSION = "0.1.0";

export { createDriveSync, type DriveCollectionInfo, type DriveSync, type DriveSyncDeps, type PickFiles } from "./createDriveSync";
export {
  documents,
  files,
  type ChangeEvent,
  type CollectionLabel,
  type Collection,
  type DocumentCollection,
  type DocumentCollectionOptions,
  type DocumentStore,
  type DriveSyncConfig,
  type FileCollection,
  type FileCollectionOptions,
  type FileStore,
  type FolderSpec,
  type SettingsSync,
  type UploadSetting,
} from "./config";
export type { Conflict, ItemStatus, PendingRemoteDelete, SyncState, SyncStatus } from "./engine/engine";
export { DriveError, type DriveApi, type DriveFile } from "./drive/api";
export { AuthRequiredError, type DriveAuth, type DriveProfile } from "./drive/auth";
export type { SyncStore, SyncItem, QueueItem } from "./store/syncStore";
