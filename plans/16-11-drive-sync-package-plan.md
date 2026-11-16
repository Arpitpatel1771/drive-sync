# drive-sync package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Taalmel's Google Drive sync into `@arpitpatel/drive-sync` (core + React + testing entry points), generalised over site-declared collections, then switch Taalmel to it with no change for existing users.

**Architecture:** The core is Taalmel's `src/drive/` (api, auth, picker, syncDb, engine) with every Taalmel type replaced by a `namespace` and a list of `documents()` / `files()` collections plus optional settings. A `createDriveSync(config)` facade owns the engine and exposes the §6.2 API; the React entry wraps it in a provider, hook and themable components. Taalmel keeps its storage and UI look, and supplies a `driveConfig.ts` of collections.

**Tech Stack:** TypeScript (ESM only), tsup, Vitest + fake-indexeddb, React ≥ 18 as an optional peer.

**Spec:** `specs/16-11-drive-sync-package.md` (this repo). Source being extracted: `../taalmel-guitar-trainer/src/drive/` and its spec `../taalmel-guitar-trainer/specs/28-10-drive-sync.md`.

## Global Constraints

- Package name `@arpitpatel/drive-sync`; entry points `.`, `./react`, `./testing`, `./styles.css`; ESM only with `.d.ts`; no runtime dependencies; `react` and `react-dom` are optional peers `>=18`.
- Scopes `https://www.googleapis.com/auth/drive.file email profile`. Tokens in memory only; silent refresh within 2 min of expiry (`TOKEN_REFRESH_MARGIN_MS = 120000`); never a popup without a user gesture.
- Flush debounce 2000 ms; backoff `min(2000 * 2^(failures-1), 300000)`; pull every 60 s while visible, on focus, on start and after a push; resumable chunk 8 MB (`8 * 1024 * 1024`).
- appProperties keys are `${namespace}Kind` / `${namespace}Id`; IndexedDB `${namespace}-sync` (stores `items` keyPath `key`, `queue` keyPath `key` with index `enqueuedAt`, `meta`, version 1); profile cache `${namespace}.driveProfile`; dev fake flag `${namespace}.fakeDrive`.
- Reserved kinds: `folder`, `settings`. Sidecar kind for a file collection: `${kind}Meta`.
- Status chip texts exactly: "Synced", "Syncing…", "Offline — saved locally", "Drive: sign in to resume", "Retrying", "Drive full — uploads paused", "N conflicts" (singular "1 conflict").
- Theme variables: `--drive-accent`, `--drive-surface`, `--drive-surface-2`, `--drive-text`, `--drive-text-muted`, `--drive-border`, `--drive-danger`, `--drive-radius`, `--drive-font`.
- Taalmel compatibility is binding: folder appProperties ids `root`, `songs`, `recordings`, `hidden`, `clips`; meta keys `conn`, `conflicts`, `pendingDeletes`, `lastSyncAt`, `uploadSetting`, `changesPageToken`, `settingsUpdatedAt`, `clipUpdatedAt:<id>`; queue keys `kind:id` and `kind:id:media`; Taalmel's device-local settings are `calibration`, `micEnabled`, `persistBannerDismissed`, `theme` (the code has `theme` too; the code wins over the old spec).
- Owner rules: no git commits and no `git push` unless the owner asks (each push asked separately); `npm publish` only after the owner says yes to that specific publish; headless Chrome always `--mute-audio`, closed after each run; never touch the owner's Vite on port 5173.

## Review Focus

1. **A Taalmel user mid-upload when they update** (queue item with `resumableUrl` in the old `taalmel-sync` DB) → the upload resumes from the saved session; nothing re-uploads. Test in Task 6.
2. **A site adds a collection after users already connected** (stored `conn.folders` lacks its folder) → the folder is found or created on the next sync, existing data untouched. Test in Task 5.
3. **Drive holds files of a kind the site no longer declares** → ignored on pull and first connect, never trashed or deleted. Test in Task 5.
4. **Bad config** (duplicate kind, reserved kind, kind containing `:`, two collections with the same folder id, missing Google IDs) → `createDriveSync` throws a clear error for the first four; missing IDs gives `configured: false` without throwing. Test in Task 4.
5. **Components rendered on a server or before Google scripts load** (`renderToStaticMarkup`, no `window.google`) → they render without touching `window`/`indexedDB`. Test in Task 9.

---

## File structure (package repo)

```
package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, .gitignore, README.md, LICENSE (MIT)
src/
  index.ts                 core exports
  config.ts                DriveSyncConfig, documents(), files(), resolveConfig()
  props.ts                 appProperties helpers for a namespace
  drive/api.ts             RestDriveApi, DriveApi, DriveError, listAllFiles, buildFileQuery, multipartBody
  drive/auth.ts            GisDriveAuth, DriveAuth, AuthRequiredError, profile cache
  drive/picker.ts          pickDriveFiles()
  store/syncStore.ts       SyncStore interface, SyncItem, QueueItem, keys
  store/idbSyncStore.ts    createIdbSyncStore(dbName)
  store/memorySyncStore.ts createMemorySyncStore()
  engine/engine.ts         SyncEngine: connection, queue, timers, status, pull dispatch
  engine/folders.ts        ensureFolders()
  engine/documents.ts      document collection push/pull/conflicts/deletes/adopt
  engine/files.ts          file collection sidecars, media upload/download/remove, import
  engine/settings.ts       settings push/pull/merge
  engine/migrate.ts        reading older stored meta shapes
  createDriveSync.ts       facade (§6.2), fake mode
  react/index.ts, react/DriveSyncProvider.tsx, react/components/*.tsx, react/syncUi.ts
  styles.css
  testing/index.ts, testing/fakeDrive.ts, testing/fakeAuth.ts
test/  (one file per src unit; test site fixture in test/site.ts)
```

---

### Task 1: Scaffold the package

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `README.md` (stub: one paragraph + "see specs/"), `LICENSE` (MIT, Arpit Patel), `src/index.ts`, `test/scaffold.test.ts`

**Interfaces:**
- Produces: `npm test`, `npm run build`, `npm run typecheck` scripts; `exports` map for `.`, `./react`, `./testing`, `./styles.css`.

- [ ] **Step 1: Write the failing test** `test/scaffold.test.ts`: `import * as core from "../src/index"; expect(core.VERSION).toBe(pkg.version)` (read `package.json`).
- [ ] **Step 2: Run** `npx vitest run test/scaffold.test.ts` — Expected: FAIL (module/export missing).
- [ ] **Step 3: Create the files.** `package.json`: `"type": "module"`, `"sideEffects": ["*.css"]`, `files: ["dist", "README.md", "LICENSE"]`, `peerDependencies` react/react-dom `>=18` marked optional in `peerDependenciesMeta`; devDependencies typescript, tsup, vitest, fake-indexeddb, react, react-dom, @types/react, @types/react-dom (versions matching Taalmel's). tsconfig `strict`, `jsx: react-jsx`, `lib: ["ES2022","DOM"]`, `moduleResolution: "bundler"`. tsup entries `src/index.ts`, `src/react/index.ts`, `src/testing/index.ts`, format esm, dts true; copy `src/styles.css` to `dist/styles.css`. vitest environment node with `fake-indexeddb/auto` in setupFiles. `src/index.ts` exports `VERSION`.
- [ ] **Step 4: Run** `npm install && npx vitest run && npx tsc --noEmit` — Expected: 1 passed, tsc clean.

### Task 2: Drive API, auth and picker

**Files:**
- Create: `src/drive/api.ts`, `src/drive/auth.ts`, `src/drive/picker.ts`, `test/api.test.ts`, `test/auth.test.ts`
- Source: copy from Taalmel `src/drive/api.ts`, `auth.ts`, `picker.ts` and their tests.

**Interfaces:**
- Produces: `DriveApi`, `RestDriveApi`, `DriveFile` (`appProperties: Record<string,string>`), `DriveError`, `listAllFiles(api, query)`, `buildFileQuery(q)`; `DriveAuth`, `GisDriveAuth`, `new GisDriveAuth({ clientId, namespace })`, `AuthRequiredError`, `DriveProfile`, `loadCachedProfile(namespace)`, `DRIVE_SCOPES`, `TOKEN_REFRESH_MARGIN_MS`; `pickDriveFiles({ token, apiKey, appId, mimeTypes: string[] }): Promise<string[]>`.

- [ ] **Step 1: Port the tests**, replacing Taalmel names: auth tests assert the profile is cached under `"site.driveProfile"` for `namespace: "site"`; add `buildFileQuery({ appProperties: { siteKind: "doc" } })` contains `appProperties has { key='siteKind' and value='doc' }`.
- [ ] **Step 2: Run** `npx vitest run test/api.test.ts test/auth.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Port the modules.** Remove every import of Taalmel code and `import.meta.env`: `GisDriveAuth` takes `clientId` and `namespace`; `pickDriveFiles` takes its keys and MIME list as arguments (joined with `,` for `setMimeTypes`). `api.ts` keeps the recent fixes (no `parents` on media updates; new upload session when the saved one is rejected).
- [ ] **Step 4: Run** the same command — Expected: all ported tests pass.

### Task 3: Sync stores

**Files:**
- Create: `src/store/syncStore.ts`, `src/store/idbSyncStore.ts`, `src/store/memorySyncStore.ts`, `test/syncStore.test.ts`
- Source: Taalmel `src/drive/syncDb.ts`, `src/drive/testing/memorySyncStore.ts`, `syncDb.test.ts`.

**Interfaces:**
- Produces: `SyncStore` (same methods as Taalmel's, `kind: string`), `SyncItem`, `QueueItem`, `QueueOp`, `itemKey(kind, id)`, `queueKey(op, kind, id)`; `createIdbSyncStore(dbName: string): SyncStore & { reset(): Promise<void> }`; `createMemorySyncStore(): SyncStore`.

- [ ] **Step 1: Port the syncDb tests** to run against both stores (`describe.each`), and add `"two databases don't share data"`: put an item in `createIdbSyncStore("a-sync")`, expect `createIdbSyncStore("b-sync").listItems()` to equal `[]`.
- [ ] **Step 2: Run** `npx vitest run test/syncStore.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** The IndexedDB layout is exactly Taalmel's (Global Constraints); the db promise is per store instance, not module-level.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 4: Config and collections

**Files:**
- Create: `src/config.ts`, `src/props.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  - `documents<T>(opts: DocumentCollectionOptions<T>): DocumentCollection<T>` with `kind`, `folder: { id: string; name: string }`, `extension`, `mimeType`, `store: { list(): Promise<T[]>; get(id): Promise<T|undefined>; save(id, item: T): Promise<void>; remove(id): Promise<void>; onChange(cb: (c: { type: "save"|"delete"; id: string }) => void): () => void }`, `idOf(item: T): string`, `toFile(item: T): string`, `fromFile(text: string, id: string, existing?: T): T`, `fileName(item: T): string`, `titleOf(item: T): string`, `updatedAt(item: T): number`, `conflicts: "ask"|"newest"`, `remoteDelete: "ask"|"follow"|"ignore"`, `onKeepBoth?(remote: T): T`, `adopt?: { extensions: string[] }`.
  - `files<T>(opts: FileCollectionOptions<T>): FileCollection<T>` with `kind`, `folder`, `metaFolder: { id; name }`, `store` (as above plus `getBlob(id): Promise<Blob|null>`, `setBlob(id, blob: Blob|null): Promise<void>`), `idOf`, `meta(item): Record<string, unknown>`, `fromMeta(meta, id, existing?: T): T`, `fileName(item)`, `mimeType(item)`, `titleOf(item)`, `uploadPolicy(item, setting: string): boolean`, `uploadSettings: { value: string; label: string }[]`, `defaultUploadSetting: string`, `remoteDelete`, `importMedia?: { mimeTypes: string[]; create(blob: Blob, name: string, id: string): Promise<T> }`.
  - `SettingsSync<S>`: `{ load(): Promise<S>; save(s: S): Promise<void>; onChange(cb: () => void): () => void; deviceLocal: (keyof S)[] }`.
  - `DriveSyncConfig`: `{ google: { clientId; apiKey; appId }; appName; namespace; collections; settings?; hiddenFolder?; onError?; devFake?: boolean }`.
  - `resolveConfig(c): ResolvedConfig` (defaults: `hiddenFolder = "." + namespace`) and `isConfigured(c): boolean`.
  - `props(namespace)`: `{ kindKey, idKey, tag(kind, id) => Record<string,string>, read(file) => { kind?: string; id?: string } }`.

- [ ] **Step 1: Write the failing tests:** `resolveConfig` throws `/duplicate kind "a"/`, `/kind "settings" is reserved/`, `/kind "a:b" must not contain ":"/`, `/folder id "x" is used twice/`; `isConfigured` is `false` when any Google ID is `""`; `props("taalmel").tag("song", "1")` equals `{ taalmelKind: "song", taalmelId: "1" }`; `resolveConfig({...namespace:"taalmel"}).hiddenFolder === ".taalmel"`.
- [ ] **Step 2: Run** `npx vitest run test/config.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `config.ts` and `props.ts`. `documents()`/`files()` return the options tagged with `type: "documents"|"files"`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 5: Generalised sync engine

**Files:**
- Create: `src/engine/engine.ts`, `src/engine/folders.ts`, `src/engine/documents.ts`, `src/engine/files.ts`, `src/engine/settings.ts`, `test/site.ts` (test site), `test/engine.*.test.ts` (split the ported `engine.test.ts` by area: connect, documents, files, settings, queue)
- Source: Taalmel `src/drive/engine.ts` (1,443 lines) and `engine.test.ts` (966 lines); `src/drive/testing/fakeDrive.ts` moves to `src/testing/fakeDrive.ts` here (its namespace becomes a constructor option).

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `class SyncEngine` with `new SyncEngine({ config: ResolvedConfig, api, auth, store, now?, randomId?, debounceMs?, chunkSize? })` and methods `getStatus()`, `onStatus(cb)`, `connect({ interactive })`, `disconnect()`, `start()`, `stop()`, `handleVisibilityAndTimers()`, `syncNow()`, `pull()`, `resolveConflict(kind, id, choice)`, `resolveRemoteDeletes(items: { kind; id }[], accept)`, `upload(kind, id)`, `download(kind, id, onProgress?)`, `removeLocal(kind, id)`, `itemStatus(kind, id): ItemStatus`, `getUploadSetting(kind)`, `setUploadSetting(kind, value)`, `importFiles(fileIds): Promise<Record<string, string[]>>`. Types `SyncStatus` (`state`, `email`, `name`, `picture`, `lastSyncAt`, `conflicts: Conflict[]`, `pendingRemoteDeletes: PendingRemoteDelete[]`, `uploads: Record<string, number>` keyed `kind:id`, `error`), `Conflict` (`kind`, `id`, `localTitle`, `remoteTitle`, `localText`, `remoteText`, `localUpdatedAt`, `remoteUpdatedAt`, `driveFileId`, `remoteVersion`), `PendingRemoteDelete` (`kind`, `id`, `title`), `ItemStatus = "local"|"uploading"|"inDrive"|"notDownloaded"|"otherDevice"`.
- `test/site.ts`: a site with namespace `"site"`, a documents collection `note` (folder `{ id: "notes", name: "Notes" }`, `.txt`, title from the first line), a files collection `photo` (folder `photos`, metaFolder `{ id: "photoMeta", name: "photos" }`, upload settings off/small/all), settings with deviceLocal `["device"]`, all backed by in-memory maps; plus `taalmelLikeSite()` reproducing Taalmel's names for Task 6.

- [ ] **Step 1: Port every engine test case** (the list in Taalmel spec §5 Testing) onto `test/site.ts`, renaming song→note and clip→photo, and add: `"a collection added later gets its folder on the next sync"` (Review Focus 2); `"files of an undeclared kind are left alone"` (Review Focus 3: FakeDrive holds a `siteKind: "old"` file; after first connect and pull it is untrashed and nothing local changed); `"conflicts: newest skips the dialog"`; `"remoteDelete: follow deletes without asking"`; `"remoteDelete: ignore keeps the local item"`; `"a site with no settings and no file collections syncs"`; `"two namespaces on one FakeDrive never see each other"`.
- [ ] **Step 2: Run** `npx vitest run test/engine` — Expected: FAIL.
- [ ] **Step 3: Implement**, moving code, not rewriting behaviour. `folders.ts` finds/creates `root` (named `appName`), each collection folder by its `folder.id`, `hidden`, and each file collection's `metaFolder` under `hidden`; `conn.folders` is a `Record<string, string>` and missing entries are created lazily. Pull dispatch reads `props.read(file)`: a declared documents kind → documents; `settings` → settings; `${kind}Meta` of a files collection → files meta; a files kind → media attach; anything else is ignored. Change events come from each collection's `store.onChange` and `settings.onChange`; engine writes go through the store functions (the site must not echo them: document this on `store`). The hash is SHA-256 of `toFile(item)` / the sidecar JSON / the synced settings JSON, as today. Upload setting is stored per collection under meta `uploadSetting:<kind>`.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all pass.

### Task 6: Reading Taalmel's stored state

**Files:**
- Create: `src/engine/migrate.ts`, `test/migrate.test.ts`

**Interfaces:**
- Consumes: Task 5 `SyncEngine`, `taalmelLikeSite()`.
- Produces: `readConflicts(stored, firstDocumentsKind): Conflict[]` (an entry with `songId` and no `kind` becomes `{ kind: firstDocumentsKind, id: songId, ... }`); `readUploadSetting(store, kind, fileCollections)` (falls back to the legacy meta key `uploadSetting` for the first files collection).

- [ ] **Step 1: Write the failing tests** with an IndexedDB `taalmel-sync` filled in the old format by the test (meta `conn` = `{ email, folders: { root, songs, recordings, hidden, clips } }`, `conflicts` = `[{ songId: "s1", localTitle, ... }]`, `uploadSetting` = `"all"`, `clipUpdatedAt:c1`, an `items` row `song:s1`, a queue row `clip:c1:media` with `resumableUrl`) and a FakeDrive holding the matching tagged files: `"existing connection is reused without creating folders"` (FakeDrive folder count unchanged); `"old conflicts load with kind song"`; `"legacy uploadSetting applies to clips"`; `"an in-flight resumable upload resumes from its saved URL"` (FakeDrive records a PUT to the saved URL and no new session, Review Focus 1); `"first sync after the switch uploads nothing that was already synced"` (FakeDrive write count 0 for unchanged items).
- [ ] **Step 2: Run** `npx vitest run test/migrate.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `migrate.ts` and call it from the engine's state load.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all pass.

### Task 7: createDriveSync facade and testing entry

**Files:**
- Create: `src/createDriveSync.ts`, `src/testing/index.ts`, `src/testing/fakeAuth.ts`, `test/createDriveSync.test.ts`; Modify: `src/index.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: `createDriveSync(config: DriveSyncConfig, deps?: { api?; auth?; store? }): DriveSync` with the spec §6.2 members (`configured`, `status`, `subscribe`, `connect`, `disconnect`, `syncNow`, `conflicts`, `resolveConflict`, `pendingDeletes`, `confirmDeletes`, `upload`, `download`, `removeLocal`, `itemStatus`, `uploadSetting`, `setUploadSetting`, `importFromDrive`, plus `start()` / `stop()`). `importFromDrive` opens the picker with the collections' `adopt.extensions` mapped to MIME types and `importMedia.mimeTypes`, then returns `Record<kind, number>`. With `devFake: true` and localStorage `${namespace}.fakeDrive` = `"1"` it uses `FakeDrive` + `FakeAuth`. `./testing` exports `FakeDrive`, `FakeAuth`, `createMemorySyncStore`.

- [ ] **Step 1: Write the failing tests:** unconfigured config → `configured === false`, `connect()` rejects with `/not configured/`, no IndexedDB opened; with FakeDrive deps, `connect()` then `status.state === "idle"` and `subscribe` is called on each change; `importFromDrive` with a stubbed picker returning a `.txt` file id → `{ note: 1, photo: 0 }`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` — Expected: all pass.

### Task 8: React provider and hook

**Files:**
- Create: `src/react/index.ts`, `src/react/DriveSyncProvider.tsx`, `src/react/syncUi.ts`, `test/react.provider.test.tsx`
- Source: Taalmel `src/drive/useDriveSync.tsx`, `syncUi.ts` (+ test).

**Interfaces:**
- Consumes: `DriveSync` (Task 7).
- Produces: `<DriveSyncProvider drive toast? children>`; `useDriveSync(): DriveSyncValue` (status, every facade action, `conflictsOpen`/`setConflictsOpen`, `ready`); `chipFor(status)`, `dotTone(status)`, `initialsFor(name, email)`, `relativeTime(then, now)`, `itemBadge(status: ItemStatus, progress?)`.

- [ ] **Step 1: Port the syncUi tests**; add `chipFor` texts exactly as in Global Constraints, including `"1 conflict"` / `"2 conflicts"`; a `renderToStaticMarkup` test of a consumer inside the provider with an unconfigured drive renders without throwing.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The provider calls `drive.start()` in an effect (never during render) and routes `status.error` to `toast(message, "error")`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 9: React components and styles

**Files:**
- Create: `src/react/components/DriveAccountChip.tsx`, `DriveStatusChip.tsx`, `DriveConflictDialog.tsx`, `DriveDeleteConfirm.tsx`, `DriveSettingsPanel.tsx`, `DriveItemBadge.tsx`, `src/styles.css`, `test/react.components.test.tsx`
- Source: Taalmel `src/drive/AccountChip.tsx`, `DriveUi.tsx`, their CSS modules, and Taalmel's `ConflictDialog` pattern.

**Interfaces:**
- Consumes: Task 8.
- Produces: the six components, each with `className?`; `DriveAccountChip` and dialogs take `renderMenu?(props: { open; onClose; title; children }) => ReactNode` / `renderDialog?(same)` so a site can use its own popover/sheet/dialog; `DriveConflictDialog` takes `renderVersion?(conflict, side: "local"|"remote") => ReactNode`. Class names prefixed `ds-`; colours only through the theme variables (defaults defined on `.ds-root` and `:where(.ds-*)` so a site overrides them with plain CSS).

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`, no `window.google`, Review Focus 5): each component renders with an unconfigured and a connected-idle status; `DriveStatusChip` shows "Drive: sign in to resume" for `authRequired`; `className` lands on the root element; `renderMenu` replaces the built-in menu; the conflict dialog shows both titles and the three buttons "Keep this device's", "Keep Drive's", "Keep both"; `styles.css` declares all nine theme variables.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Copy the Taalmel component behaviour (menu items, upload setting segmented control per files collection, import counts toast).
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — Expected: all pass, clean.

### Task 10: Build, package contents and README

**Files:**
- Modify: `README.md`; Create: `test/package.test.ts`, `examples/minimal.tsx`

- [ ] **Step 1: Write the failing test** `test/package.test.ts`: after `npm run build`, `dist/index.js`, `dist/index.d.ts`, `dist/react/index.js`, `dist/testing/index.js`, `dist/styles.css` exist; `dist/index.js` contains no `react` import; `npm pack --dry-run --json` lists no `src/`, `test/` or `specs/` files.
- [ ] **Step 2: Run** `npm run build && npx vitest run test/package.test.ts` — Expected: FAIL until the build config is right.
- [ ] **Step 3: Write the README**: install, Google Cloud setup per site (own project, `drive.file`, JavaScript origins), `createDriveSync` example with one documents and one files collection, React usage, theming variables, render overrides, testing entry. `examples/minimal.tsx` is the README example as code and is typechecked by `tsc`.
- [ ] **Step 4: Run** `npm run build && npx vitest run && npx tsc --noEmit` — Expected: all pass.

### Task 11: Switch Taalmel to the package

**Files (Taalmel repo):**
- Create: `src/driveConfig.ts`, `src/driveConfig.test.ts`
- Modify: `package.json` (dependency `"@arpitpatel/drive-sync": "file:../drive-sync"`), `src/storage/changes.ts` consumers as needed, `src/ui/App.tsx`, `src/ui/screens/Settings.tsx`, `src/ui/screens/RecorderScreen.tsx`, `src/ui/sharing/SharingContext.tsx`
- Replace: `src/drive/AccountChip.tsx` and `src/drive/DriveUi.tsx` become thin wrappers over the package components (Taalmel's look via `--drive-*` mapped to Taalmel tokens, `renderMenu` = Taalmel `Popover`, so phones get the BottomSheet)
- Delete: `src/drive/api.ts`, `auth.ts`, `picker.ts`, `syncDb.ts`, `engine.ts`, `syncUi.ts`, `useDriveSync.tsx`, `config.ts`, `testing/`, and their tests (now in the package)

**Interfaces:**
- Consumes: the package's public API only.
- Produces: `taalmelDrive: DriveSync` from `createDriveSync({ google: env, appName: "Taalmel", namespace: "taalmel", hiddenFolder: ".taalmel", devFake: import.meta.env.DEV, collections: [documents song (folder { id: "songs", name: "Songs" }, ".txt", "text/plain", conflicts "ask", remoteDelete "ask", onKeepBoth retitles "Title (Drive)", adopt [".txt"]), files clip (folder { id: "recordings", name: "Recordings" }, metaFolder { id: "clips", name: "clips" }, upload settings Off/Audio only/Everything = "off"/"audio"/"all", default "audio", importMedia with probeMedia)], settings { deviceLocal: ["calibration", "micEnabled", "persistBannerDismissed", "theme"] } })`.

- [ ] **Step 1: Write the failing test** `src/driveConfig.test.ts`: the resolved config's tags for a song equal `{ taalmelKind: "song", taalmelId }`, a clip sidecar kind is `"clipMeta"`, folder ids are `root/songs/recordings/hidden/clips`, deviceLocal equals the four fields; the song collection's `toFile` returns the exact song text.
- [ ] **Step 2: Run** `npx vitest run src/driveConfig.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `driveConfig.ts` (store adapters wrap `songs.ts`, `clipStore.ts`, `settings.ts` with `{ silent: true }` writes and `onStorageChange` filtered by kind), swap all imports to the package, delete the old modules.
- [ ] **Step 4: Run** `npx vitest run && npx tsc -b && npm run build` — Expected: all pass (count reported; it drops by the moved Drive tests), clean, build OK.
- [ ] **Step 5: Headless check** against the dev fake (`localStorage["taalmel.fakeDrive"] = "1"`, port 5199, muted Chrome, closed after): Settings Drive section, account chip menu at 1440 and 390 (BottomSheet), status chip states, conflict dialog, clip Drive badges, Upload / Remove from this device. Laptop 1440 pixel diff of Settings and Recorder vs screenshots taken before Step 3: 0 px.

### Task 12: Publish (gated)

- [ ] **Step 1:** Ask the owner: "Publish @arpitpatel/drive-sync 0.1.0 to npm (public)?" Stop until yes.
- [ ] **Step 2:** `npm publish --access public` from the package repo (the owner may need `npm login` first: suggest `! npm login`).
- [ ] **Step 3:** In Taalmel, set the dependency to `"^0.1.0"`, `npm install`, re-run Task 11 Step 4. Committing and pushing either repo is asked separately.
