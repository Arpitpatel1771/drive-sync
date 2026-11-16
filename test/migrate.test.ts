// Taalmel's stored state read by this package: the old `taalmel-sync` IndexedDB (written here with raw IndexedDB calls in
// Taalmel's own format) and the Drive files Taalmel already uploaded. Nothing a current user has may break or re-upload.

import { afterEach, describe, expect, it } from "vitest";
import { readConflicts } from "../src/engine/migrate";
import { SyncEngine } from "../src/engine/engine";
import { createIdbSyncStore } from "../src/store/idbSyncStore";
import { FakeDrive } from "../src/testing/fakeDrive";
import { fakeAuth, device, deleteIdbDatabases, now, saveSettings } from "./kit";
import { taalmelLikeSite, type Clip } from "./site";

const opened: { reset(): Promise<void> }[] = [];
function openStore() {
  const s = createIdbSyncStore("taalmel-sync");
  opened.push(s);
  return s;
}

afterEach(async () => {
  await deleteIdbDatabases();
  for (const s of opened.splice(0)) await s.reset();
  await new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase("taalmel-sync");
    r.onsuccess = r.onerror = () => res();
  });
});

// ---- Taalmel's literal hash formulas, copied from taalmel-guitar-trainer/src/drive/engine.ts (stable, sha256, clipContent)
async function tSha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function tStable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(tStable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${tStable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
function tClipContent(c: Clip) {
  return {
    name: c.name,
    createdAt: c.createdAt,
    mimeType: c.mimeType,
    hasVideo: c.hasVideo,
    durationSec: c.durationSec,
    size: c.size,
    flags: c.flags ?? [],
    peaks: c.peaks ?? [],
    gainDb: c.gainDb,
    boost: c.boost,
    mediaRev: c.mediaRev,
  };
}
const TAALMEL_DEVICE_LOCAL = ["calibration", "micEnabled", "persistBannerDismissed", "theme"];
const tSyncedSettings = (s: Record<string, unknown>) => {
  const o = { ...s };
  for (const k of TAALMEL_DEVICE_LOCAL) delete o[k];
  return o;
};

// ---- raw IndexedDB in Taalmel's format (version 1; items/queue keyPath "key", queue index enqueuedAt, out-of-line meta)
async function writeOldDb(rows: { items?: object[]; queue?: object[]; meta?: Record<string, unknown> }): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("taalmel-sync", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("items", { keyPath: "key" });
      d.createObjectStore("queue", { keyPath: "key" }).createIndex("enqueuedAt", "enqueuedAt");
      d.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["items", "queue", "meta"], "readwrite");
    for (const r of rows.items ?? []) tx.objectStore("items").put(r);
    for (const r of rows.queue ?? []) tx.objectStore("queue").put(r);
    for (const [k, v] of Object.entries(rows.meta ?? {})) tx.objectStore("meta").put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const tag = (kind: string, id: string) => ({ taalmelKind: kind, taalmelId: id });
const SONG_TEXT = "title: Wonderwall\nem7 g";
const CLIP: Clip = {
  id: "c1",
  name: "Take 1",
  createdAt: 50,
  mimeType: "audio/mp4",
  hasVideo: false,
  durationSec: 3,
  size: 20,
  flags: [{ t: 1 }],
  peaks: [0.1, 0.5],
  gainDb: 3,
  mediaRev: 2,
};
const MEDIA = "0123456789abcdefghij";

/** A Drive and a local site as they are after Taalmel synced one song, one clip (with media), and the settings. */
async function taalmelWorld(opts: { clipMedia?: "syncItem" | "clipRecordOnly" | "both" | "none"; localBlob?: boolean } = {}) {
  const drive = new FakeDrive({ namespace: "taalmel" });
  const folder = async (id: string, name: string, parent: string | null) => (await drive.createFolder(name, parent, tag("folder", id))).id;
  const root = await folder("root", "Taalmel", null);
  const songs = await folder("songs", "Songs", root);
  const recordings = await folder("recordings", "Recordings", root);
  const hidden = await folder("hidden", ".taalmel", root);
  const clips = await folder("clips", "clips", hidden);
  const folderCountBefore = drive.folderCount();

  const site = taalmelLikeSite({ now });
  const songFile = await drive.createFile(
    { name: "Wonderwall.txt", mimeType: "text/plain", parents: [songs], appProperties: tag("song", "s1") },
    new Blob([SONG_TEXT])
  );
  await site.songs.save("s1", { id: "s1", text: SONG_TEXT, updatedAt: 5 });

  const settingsValue = { zoom: 150, calibration: { ms: 40 }, micEnabled: false, persistBannerDismissed: true, theme: "light" };
  await site.settings.save(settingsValue);
  const synced = tSyncedSettings(settingsValue);
  const settingsFile = await drive.createFile(
    { name: "settings.json", mimeType: "application/json", parents: [hidden], appProperties: tag("settings", "settings") },
    new Blob([JSON.stringify({ updatedAt: 77, settings: synced })])
  );

  const content = tClipContent(CLIP);
  const sidecar = await drive.createFile(
    { name: "c1.json", mimeType: "application/json", parents: [clips], appProperties: tag("clipMeta", "c1") },
    new Blob([JSON.stringify({ updatedAt: 60, ...content })])
  );
  const media = opts.clipMedia ?? "syncItem";
  // "none": the media upload was still in flight when the user updated, so Drive has no media file yet
  const mediaFile =
    media === "none"
      ? { id: "", version: "" }
      : await drive.createFile(
          { name: "Take 1.m4a", mimeType: "audio/mp4", parents: [recordings], appProperties: tag("clip", "c1") },
          new Blob([MEDIA], { type: "audio/mp4" })
        );
  const local: Clip = { ...CLIP, ...(media === "clipRecordOnly" || media === "both" ? { driveFileId: mediaFile.id } : {}) };
  await site.clips.save("c1", local);
  if (opts.localBlob !== false) await site.clips.setBlob("c1", new Blob([MEDIA], { type: "audio/mp4" }));

  const token = await drive.getStartPageToken();
  const item = (kind: string, id: string, file: { id: string; version: string }, hash: string, extra: object = {}) => ({
    key: `${kind}:${id}`,
    kind,
    id,
    driveFileId: file.id,
    lastSyncedHash: hash,
    lastRemoteVersion: file.version,
    ...extra,
  });
  await writeOldDb({
    items: [
      item("song", "s1", songFile, await tSha(SONG_TEXT)),
      item("settings", "settings", settingsFile, await tSha(tStable(synced))),
      item("clip", "c1", sidecar, await tSha(tStable(content)), media === "syncItem" || media === "both" ? { mediaFileId: mediaFile.id, mediaRev: 2 } : {}),
    ],
    meta: {
      conn: { email: "me@example.com", folders: { root, songs, recordings, hidden, clips } },
      changesPageToken: token,
      lastSyncAt: 1,
      settingsUpdatedAt: 77,
      "clipUpdatedAt:c1": 60,
      uploadSetting: "audio",
    },
  });
  drive.writeCount = 0;
  drive.sessionsStarted = 0;
  drive.puts.length = 0;
  return { drive, site, folderCountBefore, mediaFile, sidecar };
}

function engineFor(drive: FakeDrive, site: ReturnType<typeof taalmelLikeSite>) {
  const { auth } = fakeAuth();
  return new SyncEngine({
    config: site.config,
    api: drive,
    auth,
    store: openStore(),
    now,
    debounceMs: null,
    chunkSize: 8,
  });
}

describe("Taalmel's stored state", () => {
  it("existing connection is reused without creating folders", async () => {
    const { drive, site, folderCountBefore } = await taalmelWorld();
    const engine = engineFor(drive, site);
    await engine.connect({ interactive: false });
    expect(drive.folderCount()).toBe(folderCountBefore);
    expect(engine.getStatus()).toMatchObject({ state: "idle", email: "me@example.com" });
  });

  it("old conflicts load with kind song", async () => {
    const { drive, site } = await taalmelWorld();
    const old = { songId: "s1", localTitle: "A", remoteTitle: "B", localText: "a", remoteText: "b", localUpdatedAt: 1, remoteUpdatedAt: 2, driveFileId: "f", remoteVersion: "3" };
    const store = openStore();
    await store.setMeta("conflicts", [old]);
    await store.reset();
    const engine = engineFor(drive, site);
    await engine.connect({ interactive: false });
    const { songId: _s, ...rest } = old;
    expect(engine.getStatus().conflicts).toEqual([{ ...rest, kind: "song", id: "s1" }]);
    // the converted list is written back
    const again = openStore();
    expect(await again.getMeta("conflicts")).toEqual([{ ...rest, kind: "song", id: "s1" }]);
    await again.reset();
  });

  it("conflicts that cannot be placed stay in meta untouched", async () => {
    const drive = new FakeDrive({ namespace: "taalmel" });
    const site = taalmelLikeSite({ now });
    const stored = [{ songId: "s1", localTitle: "A" }];
    const store = openStore();
    await store.setMeta("conflicts", stored);
    const noDocs = { ...site.config, documents: [] };
    const { auth } = fakeAuth();
    const engine = new SyncEngine({ config: noDocs, api: drive, auth, store, now, debounceMs: null });
    await engine.setUploadSetting("clip", "audio");
    expect(engine.getStatus().conflicts).toEqual([]);
    expect(await store.getMeta("conflicts")).toEqual(stored);
  });

  it("readConflicts keeps entries that already have a kind and drops what it cannot place", () => {
    const withKind = { kind: "note", id: "n", localTitle: "" };
    expect(readConflicts([withKind, { songId: "s" }], "song")).toEqual([withKind, { kind: "song", id: "s" }]);
    expect(readConflicts([{ songId: "s" }], undefined)).toEqual([]);
    expect(readConflicts(undefined, "song")).toEqual([]);
  });

  it("legacy uploadSetting applies to clips and is remembered under the new key", async () => {
    const { drive, site } = await taalmelWorld();
    const store = openStore();
    await store.setMeta("uploadSetting", "all");
    await store.reset();
    const engine = engineFor(drive, site);
    await engine.connect({ interactive: false });
    expect(engine.getUploadSetting("clip")).toBe("all");
    const after = openStore();
    expect(await after.getMeta("uploadSetting:clip")).toBe("all");
    expect(await after.getMeta("uploadSetting")).toBe("all");
    await after.reset();
  });

  it("an in-flight resumable upload resumes from its saved URL", async () => {
    const { drive, site } = await taalmelWorld({ clipMedia: "none" });
    // Taalmel had started the media upload and sent the first 8 bytes before the user updated
    const recordings = drive.allFiles().find((f) => f.name === "Recordings")!.id;
    const url = await drive.startResumableUpload(
      { name: "Take 1.m4a", mimeType: "audio/mp4", parents: [recordings], appProperties: tag("clip", "c1") },
      MEDIA.length
    );
    await drive.uploadChunk(url, new Blob([MEDIA.slice(0, 8)]), 0, MEDIA.length);
    drive.sessionsStarted = 0;
    drive.puts.length = 0;
    await writeOldDbQueue({ key: "clip:c1:media", op: "uploadMedia", kind: "clip", id: "c1", enqueuedAt: 1, attempts: 1, resumableUrl: url });

    const engine = engineFor(drive, site);
    await engine.connect({ interactive: false });
    await engine.settled();

    expect(drive.sessionsStarted).toBe(0);
    expect(drive.puts.length).toBeGreaterThan(0);
    expect(drive.puts.every((p) => p.url === url)).toBe(true);
    expect(drive.puts.some((p) => p.offset === 8)).toBe(true);
    expect(drive.puts.some((p) => p.offset === 0)).toBe(false);
    const media = drive.tagged("clip", "c1");
    expect(media).toHaveLength(1);
    expect(drive.readText(media[0].id)).toBe(MEDIA);
    expect(engine.itemStatus("clip", "c1")).toBe("inDrive");
  });

  describe("first sync after the switch uploads nothing that was already synced", () => {
    for (const media of ["syncItem", "clipRecordOnly", "both"] as const) {
      it(`song, clip sidecar, settings and clip media unchanged (media id kept ${{ syncItem: "in the sync record", clipRecordOnly: "on the clip record only", both: "in both places" }[media]})`, async () => {
        const { drive, site } = await taalmelWorld({ clipMedia: media });
        const engine = engineFor(drive, site);
        await engine.connect({ interactive: false });
        await engine.settled();
        await engine.syncNow();
        expect(drive.writeCount).toBe(0);
        expect(drive.sessionsStarted).toBe(0);
        expect(drive.puts).toHaveLength(0);
        expect(engine.getStatus().conflicts).toEqual([]);
        expect(engine.itemStatus("clip", "c1")).toBe("inDrive");
      });
    }
  });

  describe("legacy media id on the clip record", () => {
    it("is copied into the sync record once, so the clip can be downloaded", async () => {
      const { drive, site, mediaFile } = await taalmelWorld({ clipMedia: "clipRecordOnly", localBlob: false });
      const engine = engineFor(drive, site);
      await engine.connect({ interactive: false });
      expect(engine.itemStatus("clip", "c1")).toBe("notDownloaded");
      const blob = await engine.download("clip", "c1");
      expect(await blob.text()).toBe(MEDIA);
      expect((await site.clips.getBlob("c1"))?.size).toBe(MEDIA.length);

      const store = openStore();
      expect((await store.getItem("clip", "c1"))?.mediaFileId).toBe(mediaFile.id);
      expect(await store.getMeta("migrated:legacyMedia:clip")).toBe(true);
      await store.reset();
    });

    it("with the id in both places the clip downloads and nothing changes", async () => {
      const { drive, site, mediaFile } = await taalmelWorld({ clipMedia: "both", localBlob: false });
      const engine = engineFor(drive, site);
      await engine.connect({ interactive: false });
      expect(engine.itemStatus("clip", "c1")).toBe("notDownloaded");
      expect(await (await engine.download("clip", "c1")).text()).toBe(MEDIA);
      expect(drive.writeCount).toBe(0);
      const store = openStore();
      expect((await store.getItem("clip", "c1"))?.mediaFileId).toBe(mediaFile.id);
      await store.reset();
    });

    it("does not run a second time once flagged", async () => {
      const { drive, site, mediaFile } = await taalmelWorld({ clipMedia: "clipRecordOnly", localBlob: false });
      const store = openStore();
      await store.setMeta("migrated:legacyMedia:clip", true);
      await store.reset();
      const engine = engineFor(drive, site);
      await engine.connect({ interactive: false });
      const check = openStore();
      expect((await check.getItem("clip", "c1"))?.mediaFileId).toBeUndefined();
      expect(mediaFile.id).toBeTruthy();
      expect(engine.itemStatus("clip", "c1")).toBe("otherDevice");
      await check.reset();
    });

    it("creates a stub sync record when the clip has none", async () => {
      const drive = new FakeDrive({ namespace: "taalmel" });
      const site = taalmelLikeSite({ now });
      await site.clips.save("c9", { ...CLIP, id: "c9", driveFileId: "media-9" });
      const { auth } = fakeAuth();
      const store = openStore();
      const engine = new SyncEngine({ config: site.config, api: drive, auth, store, now, debounceMs: null });
      await engine.setUploadSetting("clip", "audio");
      // loading the state (awaited by any call) runs the one-time migration; the engine need not be connected
      expect(engine.getStatus().state).toBe("disconnected");
      const item = await store.getItem("clip", "c9");
      expect(item).toMatchObject({ driveFileId: "", lastSyncedHash: "", mediaFileId: "media-9", mediaRev: 2 });
      await store.reset();
    });
  });

  it("hashes match Taalmel's formulas for songs, clip sidecars and settings", async () => {
    const drive = new FakeDrive({ namespace: "taalmel" });
    const site = taalmelLikeSite({ now });
    const clip: Clip = { ...CLIP, gainDb: undefined, boost: true, mediaRev: undefined, flags: [], peaks: [] };
    const settings = { zoom: 90, calibration: { ms: 1 }, micEnabled: true, persistBannerDismissed: false, theme: "dark" };
    await site.songs.save("s1", { id: "s1", text: SONG_TEXT, updatedAt: 5 });
    await site.clips.save("c1", clip);
    await site.settings.save(settings);
    const { auth } = fakeAuth();
    const store = openStore();
    const engine = new SyncEngine({ config: site.config, api: drive, auth, store, now, debounceMs: null });
    await engine.connect({ interactive: true });

    expect((await store.getItem("song", "s1"))?.lastSyncedHash).toBe(await tSha(SONG_TEXT));
    expect((await store.getItem("clip", "c1"))?.lastSyncedHash).toBe(await tSha(tStable(tClipContent(clip))));
    expect((await store.getItem("settings", "settings"))?.lastSyncedHash).toBe(await tSha(tStable(tSyncedSettings(settings))));
    await store.reset();
  });
});

async function writeOldDbQueue(row: object): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("taalmel-sync", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe("settings pulled onto a site that normalises on save", () => {
  it("does not push the settings straight back", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    const b = device(drive);
    // device B rounds the zoom to a multiple of 10 whenever settings are saved
    const plainSave = b.site.settings.save.bind(b.site.settings);
    b.site.settings.save = async (s) => plainSave({ ...s, zoom: Math.round(s.zoom / 10) * 10 });
    await a.engine.connect({ interactive: true });
    await b.engine.connect({ interactive: true });
    await saveSettings(a, { zoom: 133 });
    await a.engine.syncNow();

    await b.engine.syncNow();
    expect((await b.site.settings.load()).zoom).toBe(130);
    const writes = drive.writeCount;
    await b.engine.connect({ interactive: false }); // resume: scans local changes, then syncs
    await b.engine.syncNow();
    expect(drive.writeCount).toBe(writes);
  });
});
