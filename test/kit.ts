// Shared helpers for the engine tests: a fake auth, a device (one engine with its own site), IndexedDB cleanup.

import { vi } from "vitest";
import type { DriveAuth } from "../src/drive/auth";
import { AuthRequiredError } from "../src/drive/auth";
import { SyncEngine } from "../src/engine/engine";
import { createIdbSyncStore } from "../src/store/idbSyncStore";
import { createMemorySyncStore } from "../src/store/memorySyncStore";
import type { SyncStore } from "../src/store/syncStore";
import type { FakeDrive } from "../src/testing/fakeDrive";
import { testSite, type Photo, type SiteSettings, type TestSite, type TestSiteOptions } from "./site";

let clock = 1_000_000;
/** Strictly increasing fake time shared by every device of a test file. */
export const now = () => (clock += 10);

export function fakeAuth() {
  const state = { needInteraction: false };
  const auth: DriveAuth = {
    getToken: vi.fn(async (opts: { interactive: boolean }) => {
      if (state.needInteraction && !opts.interactive) throw new AuthRequiredError();
      return "tok";
    }),
    onChange: () => () => undefined,
    email: () => "me@example.com",
    profile: () => ({ email: "me@example.com", name: "Me", picture: null }),
    signOut: vi.fn(),
  };
  return { auth, state };
}

let nextId = 1;
/** The id the most recent `randomId()` call returned. */
export const lastGeneratedId = () => `gen-${nextId - 1}`;

const idbOpened: { name: string; store: { reset(): Promise<void> } }[] = [];
let idbCount = 0;
/** A fresh IndexedDB-backed store; `deleteIdbDatabases()` closes and removes them after the test. */
export function idbStore(): SyncStore {
  const name = `kit-sync-${++idbCount}`;
  const store = createIdbSyncStore(name);
  idbOpened.push({ name, store });
  return store;
}
export async function deleteIdbDatabases(): Promise<void> {
  for (const { name, store } of idbOpened.splice(0)) {
    await store.reset();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export interface DeviceOptions extends TestSiteOptions {
  site?: TestSite;
  store?: SyncStore;
  chunkSize?: number;
  debounceMs?: number | null;
}

/** One device: its own local data (a test site) and sync store, an engine, and a fake auth, all on `drive`. */
export function device(drive: FakeDrive, opts: DeviceOptions = {}) {
  const site = opts.site ?? testSite({ namespace: drive.namespace, now, ...opts });
  const { auth, state } = fakeAuth();
  const store = opts.store ?? createMemorySyncStore();
  const engine = new SyncEngine({
    config: site.config,
    api: drive,
    auth,
    store,
    now,
    randomId: () => `gen-${nextId++}`,
    debounceMs: opts.debounceMs === undefined ? null : opts.debounceMs,
    chunkSize: opts.chunkSize,
  });
  return { engine, site, store, auth, authState: state, drive };
}
export type Dev = ReturnType<typeof device>;

// ---- the user's own changes (they fire the site's onChange; `settled` waits for the engine to enqueue them)

const mime = "image/png";
export const photoOf = (id: string, over: Partial<Photo> = {}): Photo => ({
  id,
  name: `Photo ${id}`,
  createdAt: 5,
  mimeType: mime,
  big: false,
  size: 10,
  tags: ["a", "b"],
  ...over,
});
export const photoBlob = (text = "0123456789", type = mime) => new Blob([text], { type });

export async function saveNote(d: Dev, id: string, text: string): Promise<void> {
  await d.site.notes.userSave({ id, text, updatedAt: now() });
  await d.engine.settled();
}
export async function removeNote(d: Dev, id: string): Promise<void> {
  await d.site.notes.userRemove(id);
  await d.engine.settled();
}
export async function saveSettings(d: Dev, patch: Partial<SiteSettings>): Promise<void> {
  await d.site.settings.userSave(patch);
  await d.engine.settled();
}
/** Saves a photo; `blob` defaults to ten bytes, `null` makes it a metadata-only item. */
export async function savePhoto(d: Dev, photo: Photo, blob: Blob | null | undefined = photoBlob()): Promise<void> {
  await d.site.photos.userSave({ ...photo, size: blob ? blob.size : photo.size }, blob);
  await d.engine.settled();
}
export async function renamePhoto(d: Dev, id: string, name: string): Promise<void> {
  const p = (await d.site.photos.get(id))!;
  await d.site.photos.userSave({ ...p, name });
  await d.engine.settled();
}
export async function removePhoto(d: Dev, id: string): Promise<void> {
  await d.site.photos.userRemove(id);
  await d.engine.settled();
}

export const text = (d: Dev, id: string) => d.site.notes.items.get(id)?.text;
export const names = (drive: FakeDrive) =>
  drive.allFiles().filter((f) => !f.trashed).map((f) => f.name).sort();
export const noteFile = (drive: FakeDrive, id: string) => drive.tagged("note", id)[0]!;
