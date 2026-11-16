# @arpitpatel/drive-sync

Offline-first Google Drive sync for small web apps, extracted from [Taalmel](https://taalmel.patel1771.com). Your app keeps its own local storage; this package mirrors it to the user's own Google Drive (`drive.file` scope, so it only sees files the app created or the user picked), resolves conflicts, and ships optional React components.

- ESM only, no runtime dependencies. `react` and `react-dom` (`>=18`) are optional peers, needed only for `@arpitpatel/drive-sync/react`.
- Tokens live in memory only. Sign-in popups open only from a user gesture; a returning user is resumed silently.
- Entry points: `@arpitpatel/drive-sync` (core), `/react`, `/testing`, `/styles.css`.

## Install

```sh
npm install @arpitpatel/drive-sync
```

## Google Cloud setup (once per site)

Each site uses its own Google Cloud project, so one site's quota or consent screen never affects another.

1. Create a project and enable the **Google Drive API** and the **Google Picker API**.
2. Configure the OAuth consent screen. The only Drive scope needed is `https://www.googleapis.com/auth/drive.file` (the package also asks for `email profile` to show the account).
3. Create an **OAuth client ID** of type "Web application" and add the site's origins under **Authorized JavaScript origins** (for example `https://example.com` and `http://localhost:5173`). No redirect URIs are needed.
4. Create an **API key** (used by the Picker) and restrict it to your site's referrers and to the Picker/Drive APIs.
5. Note the project number: it is the Picker `appId`.

Nothing here is secret (client id, API key and app id are public by design), but keep them out of the package and read them from the site's environment at runtime, for example `import.meta.env.VITE_GOOGLE_CLIENT_ID`. If any of the three is empty, `createDriveSync` still works: `drive.configured` is `false`, every action rejects with a "not configured" error and the React components render nothing, except `DriveSettingsPanel`, which shows a not-configured note.

## Core usage

`examples/minimal.tsx` is a runnable version of this snippet, type-checked by `tsc`.

```ts
import { createDriveSync, documents, files } from "@arpitpatel/drive-sync";

export const drive = createDriveSync({
  google: {
    clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
    apiKey: import.meta.env.VITE_GOOGLE_API_KEY ?? "",
    appId: import.meta.env.VITE_GOOGLE_APP_ID ?? "",
  },
  appName: "Notebook",       // root folder name in Drive
  namespace: "notebook",     // prefix for appProperties, IndexedDB and localStorage keys (letters, digits, - and _ only)
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
      fromFile: (text, id, existing) => parseNote(text, id, existing),
      fileName: (n) => n.title || "Untitled",
      titleOf: (n) => n.title || "Untitled",
      updatedAt: (n) => n.updatedAt,
    }),
    files<Recording>({
      kind: "recording",
      folder: { id: "recordings", name: "Recordings" },
      metaFolder: { id: "recordingMeta", name: "Recording info" },
      store: recordingStore,
      idOf: (r) => r.id,
      meta: (r) => ({ name: r.name, takenAt: r.takenAt }),
      fromMeta: (m, id, existing) => recordingFromMeta(m, id, existing),
      fileName: (r) => `${r.name}.webm`,
      mimeType: () => "audio/webm",
      titleOf: (r) => r.name,
      uploadSettings: [
        { value: "all", label: "Upload all recordings" },
        { value: "none", label: "Keep recordings on this device" },
      ],
      defaultUploadSetting: "none",
      uploadPolicy: (_r, setting) => setting === "all",
    }),
  ],
});
```

Two collection kinds:

- `documents`: each item is one text file in Drive (`toFile` / `fromFile`). Options: `conflicts: "ask" | "newest"` (default `"ask"`), `remoteDelete: "ask" | "follow" | "ignore"` (default `"ask"`), `onKeepBoth`, and `adopt: { extensions }` to let Import adopt untagged files.
- `files`: each item has a media blob plus a small JSON sidecar of metadata (`meta` / `fromMeta`) in `metaFolder`. Whether the media itself is uploaded is decided by `uploadPolicy(item, setting)` and a per-device upload setting. Media over 8 MB uploads in resumable chunks and survives a reload mid-upload. Optional: `importMedia` for Import, `remoteDelete`.

Both take an optional `label: { one, other }` (default: the kind) used wherever the package names a kind to people: the remote-delete list (`one`), the import message (`one` + "(s)", e.g. "Imported 2 song(s)") and the upload-setting heading (`other`). `drive.collections[i].label` exposes it.

Rules checked when you call `createDriveSync` (it throws a clear error): kinds must be unique, must not be `folder` or `settings` or another files collection's `<kind>Meta`, must not contain `:`, and no two collections may share a folder id.

Add a collection later and existing users pick it up on their next sync (its folder is found or created, nothing else is touched). Files in Drive of a kind the site no longer declares are ignored, never trashed.

### Calling the API

```ts
drive.start();                       // resume a stored connection silently and begin syncing
await drive.connect();               // interactive Google sign-in
await drive.importFromDrive();       // Google Picker; resolves to { kind: newItemCount }
await drive.syncNow();
await drive.resolveConflict("note", id, "local" | "remote" | "both");
await drive.confirmDeletes([{ kind: "note", id }], true);   // true: delete here too, false: keep and re-upload
await drive.upload("recording", id);
await drive.download("recording", id, (fraction) => {});
await drive.removeLocal("recording", id);
drive.itemStatus("recording", id);
drive.uploadSetting("recording"); await drive.setUploadSetting("recording", "all");
await drive.disconnect();
```

**`connect()` and `importFromDrive()` must be called from a user gesture** (a click or tap handler). They can open a Google popup, which browsers block otherwise. Everything else, including the silent resume in `start()`, never opens a popup; when Google needs the user again the status becomes `authRequired` ("Drive: sign in to resume").

### Status

`drive.status` (and `subscribe(cb)`) is a `SyncStatus`: `state`, `email`, `name`, `picture`, `lastSyncAt` (ms or `null`), `conflicts`, `pendingRemoteDeletes`, `uploads` (progress 0..1 per `kind:id`) and `error` (last unexpected error message, or `null`). `drive.conflicts` and `drive.pendingDeletes` are shortcuts to the two lists.

### Store contract

Each collection's `store` is the site's own storage. The engine writes to it (`save`, `remove`, `setBlob`) when it pulls from Drive. **Your `onChange` callbacks must fire for the user's own changes only, never for those engine writes**, or every pull would be pushed straight back to Drive. In practice: have the user-facing code paths emit `onChange`, and keep `save`/`remove`/`setBlob` themselves silent.

### Remote deletes

When an item disappears from Drive, `remoteDelete` decides what happens: `"ask"` queues it in `status.pendingRemoteDeletes` for `confirmDeletes`, `"follow"` deletes it locally, `"ignore"` keeps the local copy. On a **files** collection, `"ignore"` also forgets the link to the Drive media file, so a later local re-create uploads a new media file rather than reusing the old one.

### Settings sync

Pass `settings: { load, save, onChange, deviceLocal }` to sync site settings as `<hiddenFolder>/settings.json` (default hidden folder `.<namespace>`). Fields listed in `deviceLocal` never leave the device.

### Migrating a site

`legacyMediaFileId(item)` on a files collection is for sites whose store already kept the Drive media file id on the item (Taalmel's `clip.driveFileId`). It runs once per device and copies the id into the engine's own sync record, so nothing is re-uploaded. The package also keeps Taalmel's exact on-Drive format (folder ids, appProperties, `kind:id` queue keys, IndexedDB layout) so existing Taalmel data keeps working; for a new site choose any `namespace` and ids you like.

### Dev fake drive

Set `devFake: true` in the config, then in the browser console run `localStorage.setItem("<namespace>.fakeDrive", "1")` and reload. The site now uses an in-memory fake Drive and fake sign-in (no Google ids needed), so you can build and demo sync flows offline. Without the localStorage flag, `devFake` does nothing, so it is safe to leave on in production code.

## React

```tsx
import { DriveSyncProvider, DriveStatusChip, DriveAccountChip, DriveConflictDialog, DriveDeleteConfirm, DriveItemBadge, useDriveSync } from "@arpitpatel/drive-sync/react";
import "@arpitpatel/drive-sync/styles.css";

<DriveSyncProvider drive={drive} toast={(message, tone) => showToast(message, tone)}>
  <DriveStatusChip />
  <DriveAccountChip />
  <DriveItemBadge kind="note" id={note.id} />
  <DriveConflictDialog />
  <DriveDeleteConfirm />
  {/* ... */}
</DriveSyncProvider>
```

`DriveSyncProvider` calls `drive.start()` on mount and reports errors through `toast`. Components: `DriveStatusChip`, `DriveAccountChip` (avatar, menu, connect/sync/import/disconnect), `DriveSettingsPanel` (the same as an inline panel), `DriveConflictDialog`, `DriveDeleteConfirm`, `DriveItemBadge`. Build your own UI with `useDriveSync()` (status, `connect`, `syncNow`, `itemStatus`, `collections`, ...). All components render safely on a server or before Google's scripts load. Status chip texts: "Synced", "Syncing…", "Offline — saved locally", "Drive: sign in to resume", "Retrying", "Drive full — uploads paused", "N conflicts".

### Theming

Colours, radius and font come only from these CSS variables. The stylesheet declares no defaults for them: every use falls back inline (`var(--drive-accent, #1a73e8)`), so the package looks right with none set. Set any of them on `:root` or on any ancestor container of the components:

`--drive-accent`, `--drive-surface`, `--drive-surface-2`, `--drive-text`, `--drive-text-muted`, `--drive-border`, `--drive-danger`, `--drive-radius`, `--drive-font`.

```css
:root {
  --drive-accent: var(--accent);
  --drive-surface: var(--card);
  --drive-radius: 12px;
}
```

### Render overrides

Every component takes `className`. Menus and dialogs can be replaced with the site's own container (popover, modal) via a render prop that receives `{ open, onClose, title, children }`, where `children` is the package's own content:

```tsx
<DriveAccountChip renderMenu={({ open, onClose, title, children }) => <MyPopover open={open} onClose={onClose} label={title}>{children}</MyPopover>} />
<DriveConflictDialog renderDialog={(p) => <MyModal {...p} />} renderVersion={(conflict, side) => <Preview conflict={conflict} side={side} />} />
<DriveDeleteConfirm renderDialog={(p) => <MyModal {...p} />} />
```

`DriveAccountChip` also takes `compact`, `onOpenSettings`, `uploadLabel(kind)` and `icons`: a partial map of `connect` (replaces the Google "G" on the sign-in button), `resume`, `conflicts`, `sync`, `upload`, `import`, `settings` and `disconnect`, each rendered before that menu item's label.

## Testing entry

`@arpitpatel/drive-sync/testing` exports `FakeDrive` (an in-memory Drive API), `FakeAuth` (always signed in; set `needInteraction = true` to simulate an expired Google session) and `createMemorySyncStore()`. Inject them to test your own integration without Google:

```ts
import { createDriveSync } from "@arpitpatel/drive-sync";
import { FakeAuth, FakeDrive, createMemorySyncStore } from "@arpitpatel/drive-sync/testing";

const drive = createDriveSync(config, {
  api: new FakeDrive({ namespace: config.namespace }),
  auth: new FakeAuth(),
  store: createMemorySyncStore(),
});
```

## License

MIT
