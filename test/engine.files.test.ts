import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveError } from "../src/drive/api";
import { FakeDrive } from "../src/testing/fakeDrive";
import { device, deleteIdbDatabases, photoBlob, photoOf, removePhoto, renamePhoto, saveNote, savePhoto } from "./kit";
import { noteText as note } from "./site";

afterEach(deleteIdbDatabases);

const big = (id: string, over = {}) => photoOf(id, { big: true, mimeType: "image/tiff", ...over });
const tiff = () => photoBlob("0123456789", "image/tiff");

describe("photo delete", () => {
  it("delete trashes media and meta; other device asks before removing", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.site.photos.save("c1", photoOf("c1"));
    await a.site.photos.setBlob("c1", photoBlob());
    await a.engine.connect({ interactive: true });
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    expect(b.site.photos.items.has("c1")).toBe(true);
    expect(b.site.photos.blobs.has("c1")).toBe(false);
    await removePhoto(a, "c1");
    await a.engine.syncNow();
    expect(drive.tagged("photo")[0].trashed).toBe(true);
    expect(drive.tagged("photoMeta")[0].trashed).toBe(true);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes[0]).toMatchObject({ kind: "photo", id: "c1" });
    await b.engine.resolveRemoteDeletes([{ kind: "photo", id: "c1" }], true);
    expect(b.site.photos.items.has("c1")).toBe(false);
    expect(await b.store.getMeta("photoUpdatedAt:c1")).toBeUndefined();
  });

  it("remoteDelete: follow also deletes photos without asking", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { photoRemoteDelete: "follow" });
    await savePhoto(a, photoOf("c1"));
    await a.engine.connect({ interactive: true });
    const b = device(drive, { photoRemoteDelete: "follow" });
    await b.engine.connect({ interactive: true });
    drive.simulateExternalTrash(drive.tagged("photoMeta", "c1")[0].id);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes).toEqual([]);
    expect(b.site.photos.items.has("c1")).toBe(false);
  });
});

describe("photo meta", () => {
  it("newest wins; tags and renames sync", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.site.photos.save("c1", big("c1"));
    await a.engine.connect({ interactive: true });
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    expect(b.site.photos.items.get("c1")).toMatchObject({ name: "Photo c1", tags: ["a", "b"] });
    expect(b.site.photos.blobs.has("c1")).toBe(false);

    await renamePhoto(a, "c1", "A name");
    await renamePhoto(b, "c1", "B name"); // newer
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(a.site.photos.items.get("c1")!.name).toBe("B name");
    expect(b.site.photos.items.get("c1")!.name).toBe("B name");

    const c = a.site.photos.items.get("c1")!;
    await a.site.photos.userSave({ ...c, tags: ["x"] });
    await a.engine.settled();
    await a.engine.syncNow();
    await b.engine.pull();
    expect(b.site.photos.items.get("c1")!.tags).toEqual(["x"]);
  });
});

describe("photo media", () => {
  async function setup(setting?: string) {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    if (setting) await a.engine.setUploadSetting("photo", setting);
    return { drive, a };
  }
  const mediaFiles = (drive: FakeDrive) => drive.tagged("photo");

  it("defaults to small photos only and uploads meta for every photo", async () => {
    const { drive, a } = await setup();
    expect(a.engine.getUploadSetting("photo")).toBe("small");
    await savePhoto(a, photoOf("sm"));
    await savePhoto(a, big("lg"), tiff());
    await a.engine.syncNow();
    expect(mediaFiles(drive).map((f) => f.appProperties.siteId)).toEqual(["sm"]);
    expect(drive.tagged("photoMeta")).toHaveLength(2);
    expect(drive.allFiles().some((f) => f.name === "Photo sm.png")).toBe(true);
    expect(a.engine.itemStatus("photo", "sm")).toBe("inDrive");
    expect(a.engine.itemStatus("photo", "lg")).toBe("local");
  });

  it("the upload setting is remembered per collection under uploadSetting:<kind>", async () => {
    const { a } = await setup("all");
    expect(await a.store.getMeta("uploadSetting:photo")).toBe("all");
    const again = device(a.drive, { site: a.site, store: a.store });
    await again.engine.connect({ interactive: false });
    expect(again.engine.getUploadSetting("photo")).toBe("all");
  });

  it("off uploads nothing automatically; manual upload works", async () => {
    const { drive, a } = await setup("off");
    await savePhoto(a, photoOf("sm"));
    await a.engine.syncNow();
    expect(mediaFiles(drive)).toHaveLength(0);
    await a.engine.upload("photo", "sm");
    expect(mediaFiles(drive)).toHaveLength(1);
  });

  it("everything uploads big photos too, and changing the setting backfills", async () => {
    const { drive, a } = await setup("small");
    await savePhoto(a, big("lg"), tiff());
    await a.engine.syncNow();
    expect(mediaFiles(drive)).toHaveLength(0);
    await a.engine.setUploadSetting("photo", "all");
    await a.engine.syncNow();
    expect(mediaFiles(drive)).toHaveLength(1);
    expect(drive.allFiles().some((f) => f.name === "Photo lg.tiff")).toBe(true);
  });

  it("uploads in chunks, reports progress, and a failure mid-upload resumes", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { chunkSize: 4 });
    await a.engine.connect({ interactive: true });
    const chunks: number[] = [];
    const orig = drive.uploadChunk.bind(drive);
    let failOnce = true;
    drive.uploadChunk = async (url, chunk, offset, total) => {
      if (offset === 4 && failOnce) {
        failOnce = false;
        throw new DriveError(503, "backendError");
      }
      chunks.push(offset);
      return orig(url, chunk, offset, total);
    };
    const progress: number[] = [];
    a.engine.onStatus((s) => {
      if (s.uploads["photo:c1"] !== undefined) progress.push(s.uploads["photo:c1"]);
    });
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("retrying");
    const q = (await a.store.listQueue()).find((x) => x.op === "uploadMedia")!;
    expect(q.key).toBe("photo:c1:media");
    expect(q.resumableUrl).toBeDefined();
    expect(chunks).toEqual([0]);

    await a.engine.syncNow(); // resumes via queryUploadStatus from byte 4
    expect(chunks).toEqual([0, 4, 8]);
    expect(drive.sessionsStarted).toBe(1);
    expect(a.engine.getStatus().state).toBe("idle");
    expect(Math.max(...progress)).toBeGreaterThan(0);
    const file = mediaFiles(drive)[0];
    expect(drive.readText(file.id)).toBe("0123456789");
    expect(a.engine.getStatus().uploads).toEqual({});
  });

  it("replacing the blob bumps mediaRev and updates the same Drive file", async () => {
    const { drive, a } = await setup();
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    const [file] = mediaFiles(drive);
    expect(drive.readText(file.id)).toBe("0123456789");
    const create = vi.spyOn(drive, "createFile");

    const c = a.site.photos.items.get("c1")!;
    await savePhoto(a, { ...c, mediaRev: 1 }, photoBlob("LOUDER-BYTES!"));
    await a.engine.syncNow();

    expect(mediaFiles(drive).map((f) => f.id)).toEqual([file.id]);
    expect(drive.readText(file.id)).toBe("LOUDER-BYTES!");
    expect(create).not.toHaveBeenCalled();
    expect((await a.store.getItem("photo", "c1"))!.mediaRev).toBe(1);

    // Same revision again: nothing is uploaded a second time.
    const update = vi.spyOn(drive, "startResumableUpload");
    await savePhoto(a, a.site.photos.items.get("c1")!, undefined);
    await a.engine.syncNow();
    expect(update).not.toHaveBeenCalled();
  });

  it("photo metadata carries tags and mediaRev to another device", async () => {
    const { drive, a } = await setup();
    await savePhoto(a, photoOf("c1", { tags: ["t"], mediaRev: 2 }));
    await a.engine.syncNow();
    const meta = JSON.parse(drive.readText(drive.tagged("photoMeta")[0].id));
    expect(meta).toMatchObject({ tags: ["t"], mediaRev: 2 });

    const b = device(drive);
    await b.engine.connect({ interactive: true });
    expect(b.site.photos.items.get("c1")).toMatchObject({ tags: ["t"], mediaRev: 2 });
    expect(b.site.photos.blobs.has("c1")).toBe(false);
  });

  it("a tags change syncs as metadata only, with no media re-upload", async () => {
    const { drive, a } = await setup();
    await savePhoto(a, photoOf("c1", { tags: ["t"] }));
    await a.engine.syncNow();
    const update = vi.spyOn(drive, "startResumableUpload");
    await savePhoto(a, { ...a.site.photos.items.get("c1")!, tags: ["u"] }, undefined);
    await a.engine.syncNow();
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(drive.readText(drive.tagged("photoMeta")[0].id)).tags).toEqual(["u"]);
  });

  it("a device with a stale copy drops it when another device replaced the media", async () => {
    const { drive, a } = await setup();
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    await b.engine.download("photo", "c1");
    expect(b.site.photos.blobs.has("c1")).toBe(true);

    await savePhoto(a, { ...a.site.photos.items.get("c1")!, mediaRev: 1 }, photoBlob("NEW-MEDIA"));
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.site.photos.blobs.has("c1")).toBe(false);
    const blob = await b.engine.download("photo", "c1");
    expect(await blob.text()).toBe("NEW-MEDIA");
    await b.engine.syncNow(); // the download is current: no upload back
    expect(drive.readText(mediaFiles(drive)[0].id)).toBe("NEW-MEDIA");
  });

  it("an expired upload session (404) restarts the upload", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { chunkSize: 4 });
    await a.engine.connect({ interactive: true });
    const origUpload = drive.uploadChunk.bind(drive);
    let broke = false;
    drive.uploadChunk = async (url, chunk, offset, total) => {
      if (offset === 4 && !broke) {
        broke = true;
        throw new DriveError(503, "backendError");
      }
      return origUpload(url, chunk, offset, total);
    };
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    const saved = (await a.store.listQueue()).find((x) => x.op === "uploadMedia")!.resumableUrl;
    expect(saved).toBeDefined();
    drive.queryUploadStatus = async () => {
      throw new DriveError(404, "notFound");
    };
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("idle");
    expect(drive.readText(mediaFiles(drive)[0].id)).toBe("0123456789");
    expect(mediaFiles(drive)).toHaveLength(1);
    // a new session was started: the dead URL was dropped from the queue item and not used again
    expect(drive.sessionsStarted).toBe(2);
    expect(drive.puts.filter((p) => p.url === saved && p.offset !== null)).toHaveLength(1);
  });

  it("a rejected upload session (403 fieldNotWritable) is dropped and the upload starts over", async () => {
    // Regression: a session started with `parents` in an update was rejected by Drive at the end
    // ("The parents field is not directly writable"); the saved session URL was resumed forever.
    const drive = new FakeDrive();
    const a = device(drive, { chunkSize: 4 });
    await a.engine.connect({ interactive: true });
    const origUpload = drive.uploadChunk.bind(drive);
    const badSessions = new Set<string>();
    const origStart = drive.startResumableUpload.bind(drive);
    let first = true;
    drive.startResumableUpload = async (meta, total, existing) => {
      const url = await origStart(meta, total, existing);
      if (first) badSessions.add(url);
      first = false;
      return url;
    };
    let failNetwork = true;
    drive.uploadChunk = async (url, chunk, offset, total) => {
      if (offset === 4 && failNetwork) {
        failNetwork = false;
        throw new DriveError(503, "backendError"); // leave the bad session saved in the queue
      }
      if (badSessions.has(url)) throw new DriveError(403, "fieldNotWritable", "The parents field is not directly writable in update requests.");
      return origUpload(url, chunk, offset, total);
    };
    drive.queryUploadStatus = async (url) => {
      if (badSessions.has(url)) throw new DriveError(403, "fieldNotWritable");
      return { done: false, received: 0 };
    };
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("idle");
    expect(drive.readText(mediaFiles(drive)[0].id)).toBe("0123456789");
  });

  it("quota errors pause media uploads (driveFull) while metadata keeps syncing", async () => {
    const { drive, a } = await setup();
    drive.startResumableUpload = async () => {
      throw new DriveError(403, "storageQuotaExceeded");
    };
    await savePhoto(a, photoOf("c1"));
    await saveNote(a, "s1", note("One"));
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("driveFull");
    expect(drive.tagged("photoMeta")).toHaveLength(1);
    expect(drive.tagged("note")).toHaveLength(1);
    expect(mediaFiles(drive)).toHaveLength(0);
    expect((await a.store.listQueue()).some((q) => q.op === "uploadMedia")).toBe(true);
  });

  it("photos from another device arrive without media; download and remove-local work", async () => {
    const { drive, a } = await setup();
    await savePhoto(a, photoOf("c1"));
    await savePhoto(a, big("c2"), tiff()); // meta only: not uploaded by the setting
    await a.engine.syncNow();
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    expect(b.site.photos.items.has("c1") && b.site.photos.items.has("c2")).toBe(true);
    expect(b.site.photos.blobs.size).toBe(0);
    expect(b.engine.itemStatus("photo", "c1")).toBe("notDownloaded");
    expect(b.engine.itemStatus("photo", "c2")).toBe("otherDevice");
    await expect(b.engine.download("photo", "c2")).rejects.toThrow();

    const seen: number[] = [];
    const blob = await b.engine.download("photo", "c1", (f) => seen.push(f));
    expect(await blob.text()).toBe("0123456789");
    expect(seen.some((f) => f > 0 && f < 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
    expect(b.site.photos.blobs.has("c1")).toBe(true);
    expect(b.engine.itemStatus("photo", "c1")).toBe("inDrive");
    await b.engine.removeLocal("photo", "c1");
    expect(b.site.photos.blobs.has("c1")).toBe(false);
    expect(b.engine.itemStatus("photo", "c1")).toBe("notDownloaded");
    await expect(b.engine.removeLocal("photo", "c2")).rejects.toThrow();
  });

  it("a photo that arrives before its media gets linked when the media shows up", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    await a.engine.setUploadSetting("photo", "off");
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    expect(b.engine.itemStatus("photo", "c1")).toBe("otherDevice");
    await a.engine.upload("photo", "c1");
    await b.engine.pull();
    expect(b.engine.itemStatus("photo", "c1")).toBe("notDownloaded");
    expect((await b.store.getItem("photo", "c1"))!.mediaFileId).toBeDefined();
  });

  it("reports uploading while the media goes up", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { chunkSize: 4 });
    await a.engine.connect({ interactive: true });
    const seen: string[] = [];
    const orig = drive.uploadChunk.bind(drive);
    drive.uploadChunk = async (...args) => {
      seen.push(a.engine.itemStatus("photo", "c1"));
      return orig(...args);
    };
    await savePhoto(a, photoOf("c1"));
    await a.engine.syncNow();
    expect(seen).toEqual(["uploading", "uploading", "uploading"]);
    expect(a.engine.itemStatus("photo", "c1")).toBe("inDrive");
  });
});
