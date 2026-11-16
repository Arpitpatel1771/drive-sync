// React binding for a DriveSync: status via useSyncExternalStore, start() in an effect, errors to a toast.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DriveCollectionInfo, DriveSync } from "../createDriveSync";
import type { ItemStatus, SyncStatus } from "../engine/types";

export interface DriveSyncValue {
  /** Google ids are present (or an injected / fake drive). */
  configured: boolean;
  /** The provider has mounted and called `drive.start()`. */
  ready: boolean;
  status: SyncStatus;
  conflictsOpen: boolean;
  setConflictsOpen: (open: boolean) => void;
  /** Interactive connect: call from a click. */
  connect: DriveSync["connect"];
  disconnect: DriveSync["disconnect"];
  syncNow: DriveSync["syncNow"];
  resolveConflict: DriveSync["resolveConflict"];
  confirmDeletes: DriveSync["confirmDeletes"];
  upload: DriveSync["upload"];
  download: DriveSync["download"];
  removeLocal: DriveSync["removeLocal"];
  itemStatus: (kind: string, id: string) => ItemStatus;
  uploadSetting: (kind: string) => string;
  setUploadSetting: DriveSync["setUploadSetting"];
  importFromDrive: DriveSync["importFromDrive"];
  /** The site's declared collections (kind, type, upload settings). */
  collections: readonly DriveCollectionInfo[];
  /** The site's toast, for component messages (no-op without a provider `toast`). */
  toast: (message: string, tone: "error" | "info") => void;
  /** Upload progress 0..1 for an item, 0 when it is not uploading. */
  uploadProgress: (kind: string, id: string) => number;
}

const EMPTY_STATUS: SyncStatus = {
  state: "disconnected",
  email: null,
  name: null,
  picture: null,
  lastSyncAt: null,
  conflicts: [],
  pendingRemoteDeletes: [],
  uploads: {},
  error: null,
};

const notConfigured = () => Promise.reject(new Error("Drive sync is not configured."));
const DEFAULT_VALUE: DriveSyncValue = {
  configured: false,
  ready: false,
  status: EMPTY_STATUS,
  conflictsOpen: false,
  setConflictsOpen: () => {},
  connect: notConfigured,
  disconnect: notConfigured,
  syncNow: notConfigured,
  resolveConflict: notConfigured,
  confirmDeletes: notConfigured,
  upload: notConfigured,
  download: notConfigured,
  removeLocal: notConfigured,
  itemStatus: () => "local",
  uploadSetting: () => "",
  setUploadSetting: notConfigured,
  importFromDrive: notConfigured,
  uploadProgress: () => 0,
  collections: [],
  toast: () => {},
};

const DriveSyncContext = createContext<DriveSyncValue>(DEFAULT_VALUE);

export function useDriveSync(): DriveSyncValue {
  return useContext(DriveSyncContext);
}

/** A stable-snapshot store over `drive.status` (which may return a fresh object on every read). */
export function createStatusStore(drive: DriveSync) {
  let snapshot: SyncStatus = drive.status;
  return {
    getSnapshot: () => snapshot,
    subscribe(onChange: () => void) {
      snapshot = drive.status;
      const off = drive.subscribe((s) => {
        snapshot = s;
        onChange();
      });
      // A change between the render and the subscription must not be missed.
      onChange();
      return off;
    },
  };
}

/** The message to toast for a status error, or null when it is empty or the same as the previous one. */
export function nextToast(prevError: string | null, error: string | null): string | null {
  return error && error !== prevError ? error : null;
}

export interface DriveSyncProviderProps {
  drive: DriveSync;
  toast?: (message: string, tone: "error" | "info") => void;
  children: ReactNode;
}

export function DriveSyncProvider({ drive, toast, children }: DriveSyncProviderProps) {
  const store = useMemo(() => createStatusStore(drive), [drive]);
  const status = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    drive.start().catch((err: unknown) => {
      toastRef.current?.(err instanceof Error ? err.message : String(err), "error");
    });
    setReady(true);
    return () => {
      setReady(false);
      drive.stop();
    };
  }, [drive]);

  // One toast per new error message.
  useEffect(() => {
    const message = nextToast(lastError.current, status.error);
    if (message) toastRef.current?.(message, "error");
    lastError.current = status.error;
  }, [status.error]);

  const value = useMemo<DriveSyncValue>(() => {
    const configured = drive.configured;
    return {
      configured,
      ready,
      status,
      conflictsOpen,
      setConflictsOpen,
      connect: () => drive.connect(),
      disconnect: () => drive.disconnect(),
      syncNow: () => drive.syncNow(),
      resolveConflict: (kind, id, choice) => drive.resolveConflict(kind, id, choice),
      confirmDeletes: (items, accept) => drive.confirmDeletes(items, accept),
      upload: (kind, id) => drive.upload(kind, id),
      download: (kind, id, onProgress) => drive.download(kind, id, onProgress),
      removeLocal: (kind, id) => drive.removeLocal(kind, id),
      itemStatus: (kind, id) => (configured ? drive.itemStatus(kind, id) : "local"),
      uploadSetting: (kind) => (configured ? drive.uploadSetting(kind) : ""),
      setUploadSetting: (kind, v) => drive.setUploadSetting(kind, v),
      importFromDrive: () => drive.importFromDrive(),
      uploadProgress: (kind, id) => status.uploads[`${kind}:${id}`] ?? 0,
      collections: drive.collections,
      toast: (message, tone) => toastRef.current?.(message, tone),
    };
  }, [drive, ready, status, conflictsOpen]);

  return <DriveSyncContext.Provider value={value}>{children}</DriveSyncContext.Provider>;
}
