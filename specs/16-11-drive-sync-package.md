# drive-sync: Google Drive storage as a package (design spec)

Status: draft for review, 2026-11-16.
Problem: Taalmel's Google Drive sync (`taalmel-guitar-trainer/src/drive/`, spec `specs/28-10-drive-sync.md` there) is wired to Taalmel's songs, recordings and settings. The owner is building more sites and wants each of them to store its data in the user's Drive the same way, without copying the code.

The package is that feature, extracted whole: sign-in, the Drive calls, resumable uploads, the picker, the background sync engine (queue, retries, conflicts, deletes, first-connect merge, import), media that can live in Drive only, and the React UI. Taalmel becomes its first user.

---

## 1. Principles

- **The whole feature, nothing Taalmel-specific.** Every behaviour in Taalmel's Drive spec stays, but songs, clips and settings become examples of generic **collections** a site declares.
- **Each site stays on its own.** Each site uses its own Google Cloud project (client ID, API key, app ID) and its own consent screen. With the `drive.file` scope a site only ever sees files it created or the user picked, so sites can't see each other's data.
- **Local storage stays the primary copy.** The site keeps its own storage (IndexedDB or anything else); the package mirrors it to Drive in the background and writes pulled changes back through the site's functions. The site works instantly and offline.
- **Browser-only.** No server, no client secret, Google scripts loaded on demand.
- **Configurable UI.** Ready-made React components with default styling, theme variables, `className` on every component, and the headless hook for sites that want their own UI.
- **Taalmel users notice nothing.** Existing Drive folders, files and local sync state keep working after Taalmel switches to the package (§7).

## 2. Package shape

- **Name:** `@arpitpatel/drive-sync`, published to npm, public. It holds no secrets: Google IDs come from each site at runtime.
- **Repo:** `~/Documents/code/personal/drive-sync`, its own git repository.
- **Entry points:**
  - `@arpitpatel/drive-sync`: the core. No React, no DOM beyond `fetch`, IndexedDB and the Google scripts.
  - `@arpitpatel/drive-sync/react`: provider, hook and components. React is a peer dependency (≥ 18).
  - `@arpitpatel/drive-sync/testing`: `FakeDrive`, a fake auth and an in-memory sync store, so sites can test their own integration.
  - `@arpitpatel/drive-sync/styles.css`: default styling for the components.
- **Build:** TypeScript, ESM only, type declarations included, built with `tsup` (or Vite library mode). Tests with Vitest.
- **No runtime dependencies** besides React as a peer.

## 3. Configuration

```ts
const drive = createDriveSync({
  google: { clientId, apiKey, appId },   // the site's own Google Cloud project
  appName: "Taalmel",                    // root folder name in Drive
  namespace: "taalmel",                  // prefix for appProperties, IndexedDB and localStorage keys (§4.1)
  collections: [ /* §5 */ ],
  settings: { load, save, deviceLocal: ["calibration"], onChange },   // optional (§5.3)
  hiddenFolder: ".taalmel",              // optional, default `.${namespace}`: where metadata lives
  onError: (message) => toast(message),  // optional
});
```

- **Missing Google IDs:** `drive.configured` is `false`, the UI shows "Not configured", and nothing else happens.
- **Scopes:** `drive.file email profile`, as today.

## 4. Drive layout and identity

```
<appName>/
  <collection folder>/   <file name>.<ext>     one folder per collection, e.g. Songs/, Recordings/
  <hiddenFolder>/        settings.json
                         <collection>/<id>.json   sidecar metadata for file collections
```

### 4.1 Namespace

`namespace` keeps everything the package stores apart per site and keeps Taalmel's existing data valid:

- **appProperties on every file:** `{ <namespace>Kind, <namespace>Id }`, e.g. `taalmelKind: "song"`, `taalmelId`. Identity is the id, never the file name or location, so renaming or moving a file in Drive keeps the link.
- **Local sync database:** IndexedDB `<namespace>-sync` (Taalmel: `taalmel-sync`, unchanged).
- **Cached profile:** localStorage `<namespace>.driveProfile`.
- **Root folder:** found by `<namespace>Kind: "folder"`, so another device reuses it.

### 4.2 Kinds

Each collection declares its `kind` string (Taalmel: `"song"`, `"clip"`); the package reserves `"folder"` and `"settings"`. A file collection's sidecar uses `<kind>Meta` (Taalmel: `"clipMeta"`).

## 5. Collections

A site declares what to sync as a list of collections. There are two types.

### 5.1 Document collections

Items that are one text file each, edited by people and apps (Taalmel's songs).

```ts
documents<Song>({
  kind: "song",
  folder: "Songs",
  extension: ".txt",
  mimeType: "text/plain",
  store: { list, get, save, remove, onChange },   // the site's storage
  toFile: (song) => song.text,                     // what goes in Drive
  fromFile: (text, id, existing) => ({ ...existing, id, text }),
  fileName: (song) => titleOf(song.text),          // sanitised, " (2)" added on clashes
  conflicts: "ask",                                // or "newest"
  remoteDelete: "ask",                             // or "follow" / "ignore"
  adopt: { extensions: [".txt"] },                 // optional: untagged files picked via Import
})
```

- **`store.onChange(cb)`:** the site calls `cb({ type: "save" | "delete", id })` after every local change; the package enqueues the push. The UI never calls sync directly.
- **Hashing:** SHA-256 of `toFile(item)`, compared with the last synced hash, as today.
- **`conflicts: "ask"`:** both versions kept until the user resolves: keep this device's, keep Drive's, or keep both (the Drive version is saved as a new item through `onKeepBoth(item) => item`, which Taalmel uses to retitle it "Title (Drive)"). **`"newest"`:** newest `updatedAt` wins, no prompt.
- **`remoteDelete: "ask"`:** batched "Deleted in Drive, delete here too?". Declining re-uploads.
- **Renames:** changing what `fileName` returns renames the Drive file. Renaming in Drive changes nothing locally.
- **Deletes:** a local delete moves the Drive file to the trash.
- **Unparseable remote content:** stored anyway; the site decides how to show it.

### 5.2 File collections

Large binary items that can live in Drive only, with small metadata always synced (Taalmel's recordings).

```ts
files<Clip>({
  kind: "clip",
  folder: "Recordings",
  store: { list, get, save, remove, getBlob, setBlob, onChange },
  meta: (clip) => ({ name, durationSec, flags, peaks, hasVideo, mimeType, createdAt }),   // sidecar JSON
  fromMeta: (meta, id, existing) => ({ ...existing, ...meta, id }),
  fileName: (clip) => `${clip.name}.${extensionFor(clip)}`,
  mimeType: (clip) => clip.mimeType,
  uploadPolicy: (clip, setting) => setting === "all" || (setting === "audio" && !clip.hasVideo),
  uploadSettings: ["off", "audio", "all"],   // the choices the UI offers, default "audio"
  remoteDelete: "ask",
  importMedia: { mimeTypes: ["video/*", "audio/*"], create },  // optional: create(blob, name, id) builds the item (Taalmel probes duration and peaks)
})
```

- **Metadata always syncs:** every item gets a sidecar in `<hiddenFolder>/<kind>/<id>.json`, newest `updatedAt` wins. Other devices see the item without its media.
- **Media upload:** when `uploadPolicy` allows it or the user clicks Upload. Resumable, 8 MB chunks, session URL kept in the queue so a reload resumes, a new session when Google rejects the saved one (the recent fix stays).
- **Item status for the UI:** `local`, `uploading N%`, `inDrive`, `inDrive · not downloaded`, `otherDevice` (meta only, media never uploaded).
- **Download on demand:** `drive.download(kind, id, onProgress)` fetches the media and calls `store.setBlob`.
- **Remove from this device:** `drive.removeLocal(kind, id)` calls `store.setBlob(id, null)` for items that are in Drive.
- **Delete:** local delete trashes both the media and the sidecar.
- **Renames** update the sidecar and rename the media file.
- **Drive full:** media uploads pause, metadata keeps syncing.

### 5.3 Settings

Optional, one JSON file `<hiddenFolder>/settings.json` holding `{ updatedAt, settings }`.

- **`deviceLocal`:** fields that never leave the device (Taalmel: `calibration`, `micEnabled`, `persistBannerDismissed`).
- **Merge:** newest `updatedAt` wins; local settings without one count as older. Device-local fields are always kept from this device.

## 6. Engine, status and UI

### 6.1 Engine

The engine is Taalmel's, generalised over collections; behaviour is unchanged:

- **Push:** debounced 2 s flush of a persisted, de-duplicated queue; retries with backoff 2 s → 5 min; flush on coming online and on a fresh token.
- **Pull:** `changes.list` on start, on tab focus, every 60 s while visible and after a push; each change reconciled per collection rules.
- **First connect:** find or create the folders, match by id: only local → upload, only remote → download, same hash → link, different → conflict (or newest, per collection).
- **Import:** Google Picker restricted to the collections' `adopt` extensions and `importMedia` types; picked files are adopted (assigned an id written to appProperties) and moved into the collection's folder.
- **Errors:** 401 → one silent refresh, then "sign in to resume"; 403 rate limit, 429, 5xx → back off; `storageQuotaExceeded` → Drive full; 404 → remote delete; network failure → offline. Local data is never deleted except by a user-confirmed delete.
- **Tokens:** memory only, silent refresh within 2 minutes of expiry, never a popup without a user gesture.

### 6.2 Core API

```ts
drive.configured; drive.status; drive.subscribe(cb)
drive.connect(); drive.disconnect(); drive.syncNow()
drive.conflicts; drive.resolveConflict(id, "local" | "remote" | "both")
drive.pendingDeletes; drive.confirmDeletes(ids, accept)
drive.upload(kind, id); drive.download(kind, id, onProgress); drive.removeLocal(kind, id)
drive.itemStatus(kind, id); drive.uploadSetting(kind); drive.setUploadSetting(kind, value)
drive.importFromDrive()   // → counts per collection
```

`status`: `{ state: "disconnected" | "idle" | "syncing" | "offline" | "authRequired" | "retrying" | "driveFull", email, name, lastSyncedAt, uploads, conflicts, pendingDeletes }`.

### 6.3 React

- **`<DriveSyncProvider drive={drive} toast={toast}>`** and **`useDriveSync()`**: status, actions, conflicts, re-render on change.
- **Components**, each optional:
  - `<DriveAccountChip>`: avatar or initials with a status dot; its menu has Connect, Sign in to resume, Resolve conflicts, Sync now, upload setting per file collection, Import from Drive, Disconnect.
  - `<DriveStatusChip>`: the status chip texts from Taalmel's spec ("Synced", "Syncing…", "Offline — saved locally", "Drive: sign in to resume", "Retrying", "Drive full — uploads paused", "N conflicts").
  - `<DriveConflictDialog>`: two versions side by side, with the three choices. The site can pass `renderVersion` to show its own preview.
  - `<DriveDeleteConfirm>`: the batched remote-delete question.
  - `<DriveSettingsPanel>`: connect/disconnect, account, upload settings, import.
  - `<DriveItemBadge kind id>`: the per-item status for file collections.
- **Theming:** components use CSS variables with defaults: `--drive-accent`, `--drive-surface`, `--drive-surface-2`, `--drive-text`, `--drive-text-muted`, `--drive-border`, `--drive-danger`, `--drive-radius`, `--drive-font`. A site maps them to its own tokens (Taalmel: `--drive-accent: var(--accent)` and so on). Every component takes `className`; menus and dialogs accept a `renderMenu` / `renderDialog` override so a site can show them in its own popover or bottom sheet (Taalmel uses its BottomSheet on phones).
- **Messages** go through the site's `toast`, so they look like the site's own.

## 7. Taalmel migration

- **Taalmel config:** `namespace: "taalmel"`, `appName: "Taalmel"`, `hiddenFolder: ".taalmel"`, collections `song` (documents, `.txt`, `Songs/`, conflicts ask) and `clip` (files, `Recordings/`, sidecar `clipMeta`), settings with the three device-local fields.
- **Unchanged on disk and in Drive:** folder tree, appProperties keys and values, the `taalmel-sync` database and its stores, queue items in flight (including saved resumable upload URLs), the cached profile key.
- **Code:** `src/drive/` is replaced by the package plus a small `src/driveConfig.ts` (the collections) and thin wrappers that keep Taalmel's current UI (AccountChip look, toasts, BottomSheet on phones).
- **Proof:** Taalmel's full test suite and the existing Drive engine tests (ported into the package) pass; a headless run against `FakeDrive` shows the chip states, conflict dialog, clip badges and Settings section unchanged; a migration test opens a `taalmel-sync` database written by the current code and syncs from it without re-uploading anything.
- **During development** Taalmel uses the package through a local link (`npm link` or a `file:` dependency); after publishing it installs the npm version.

## 8. Testing (package)

- **Ported:** Taalmel's engine, API, auth, sync DB and UI-helper tests, rewritten against a test site with one document collection, one file collection and settings.
- **Added:** two sites with different namespaces on one Drive never see each other's files or databases; a collection with `conflicts: "newest"`; `remoteDelete: "follow"`; a site with no settings and no file collections.
- **React:** `renderToStaticMarkup` tests for the components, as Taalmel does today.
- **Manual checklist** for each new site (needs a real Google account): connect, folder tree appears, edit syncs both ways within a minute, conflict resolves, a file uploads and downloads on a second device.

## 9. Delivery order

1. This spec, approved.
2. Implementation plan.
3. Build the package in this repo, with the ported tests.
4. Switch Taalmel to the package through a local link; all its tests and the Drive headless checks pass.
5. Publish to npm (asked first, since it's public), then point Taalmel at the published version. Deploying Taalmel is a separate push, asked for separately.

## 10. Out of scope

- A server or shared backend; sites reading each other's data.
- Storage other than Google Drive (Dropbox, OneDrive): the core keeps Drive behind the `DriveApi` interface, so a later provider is possible, but not designed here.
- Offline caching of the site itself (service worker).
- Real-time collaboration between two people editing the same item.
