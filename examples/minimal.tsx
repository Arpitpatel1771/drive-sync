// The README example as code: one documents collection (notes) and one files collection (recordings).
// Typechecked by `tsc --noEmit` through the "@arpitpatel/drive-sync" path alias in tsconfig.json.

import { createDriveSync, documents, files, type ChangeEvent, type DocumentStore, type FileStore } from "@arpitpatel/drive-sync";
import { DriveAccountChip, DriveConflictDialog, DriveDeleteConfirm, DriveItemBadge, DriveStatusChip, DriveSyncProvider } from "@arpitpatel/drive-sync/react";
import "@arpitpatel/drive-sync/styles.css";

interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

interface Recording {
  id: string;
  name: string;
  takenAt: number;
  updatedAt: number;
  durationSec: number;
}

/**
 * A site's own storage. This one is in memory; yours would wrap IndexedDB or localStorage.
 * Contract: fire `onChange` for the user's own edits only, never for writes the engine makes through save/remove/setBlob.
 */
function memoryStore<T extends { id: string }>(): DocumentStore<T> & FileStore<T> & { userSave(item: T): Promise<void> } {
  const items = new Map<string, T>();
  const blobs = new Map<string, Blob>();
  const listeners = new Set<(c: ChangeEvent) => void>();
  return {
    list: async () => [...items.values()],
    get: async (id) => items.get(id),
    save: async (id, item) => void items.set(id, item),
    remove: async (id) => void (items.delete(id), blobs.delete(id)),
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    getBlob: async (id) => blobs.get(id) ?? null,
    setBlob: async (id, blob) => void (blob ? blobs.set(id, blob) : blobs.delete(id)),
    // What the site calls when the user edits something: write locally, then tell the engine.
    async userSave(item) {
      items.set(item.id, item);
      listeners.forEach((cb) => cb({ type: "save", id: item.id }));
    },
  };
}

const noteStore = memoryStore<Note>();
const recordingStore = memoryStore<Recording>();

export const drive = createDriveSync({
  // Public Google ids come from the site's own env at build time. No secrets belong here.
  google: {
    clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
    apiKey: import.meta.env.VITE_GOOGLE_API_KEY ?? "",
    appId: import.meta.env.VITE_GOOGLE_APP_ID ?? "",
  },
  appName: "Notebook",
  namespace: "notebook",
  devFake: true,
  collections: [
    documents<Note>({
      kind: "note",
      folder: { id: "notes", name: "Notes" },
      extension: ".md",
      mimeType: "text/markdown",
      store: noteStore,
      idOf: (n) => n.id,
      toFile: (n) => `# ${n.title}\n\n${n.body}`,
      fromFile: (text, id, existing) => {
        const [first = "", ...rest] = text.split("\n");
        return { id, title: first.replace(/^#\s*/, ""), body: rest.join("\n").trim(), updatedAt: existing?.updatedAt ?? Date.now() };
      },
      fileName: (n) => n.title || "Untitled",
      titleOf: (n) => n.title || "Untitled",
      updatedAt: (n) => n.updatedAt,
      onKeepBoth: (remote) => ({ ...remote, id: crypto.randomUUID(), title: `${remote.title} (Drive copy)` }),
    }),
    files<Recording>({
      kind: "recording",
      folder: { id: "recordings", name: "Recordings" },
      metaFolder: { id: "recordingMeta", name: "Recording info" },
      store: recordingStore,
      idOf: (r) => r.id,
      meta: (r) => ({ name: r.name, takenAt: r.takenAt, durationSec: r.durationSec, updatedAt: r.updatedAt }),
      fromMeta: (m, id, existing) => ({
        id,
        name: String(m.name ?? existing?.name ?? ""),
        takenAt: Number(m.takenAt ?? existing?.takenAt ?? 0),
        durationSec: Number(m.durationSec ?? existing?.durationSec ?? 0),
        updatedAt: Number(m.updatedAt ?? Date.now()),
      }),
      fileName: (r) => `${r.name || "Recording"}.webm`,
      mimeType: () => "audio/webm",
      titleOf: (r) => r.name || "Recording",
      uploadSettings: [
        { value: "all", label: "Upload all recordings" },
        { value: "none", label: "Keep recordings on this device" },
      ],
      defaultUploadSetting: "none",
      uploadPolicy: (_r, setting) => setting === "all",
    }),
  ],
  onError: (message) => console.error(message),
});

export function App() {
  return (
    <DriveSyncProvider drive={drive} toast={(message, tone) => console.log(tone, message)}>
      <header>
        <DriveStatusChip />
        <DriveAccountChip />
      </header>
      <ul>
        <li>
          Morning notes <DriveItemBadge kind="note" id="n1" />
        </li>
      </ul>
      <DriveConflictDialog />
      <DriveDeleteConfirm />
    </DriveSyncProvider>
  );
}
