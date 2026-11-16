import { afterEach, describe, expect, it } from "vitest";
import { listAllFiles } from "../src/drive/api";
import { FakeDrive } from "../src/testing/fakeDrive";
import { device, deleteIdbDatabases, idbStore, names, noteFile, photoBlob, photoOf, text } from "./kit";
import { noteText as note, testSite } from "./site";

afterEach(deleteIdbDatabases);

describe("first connect", () => {
  it("with an empty Drive creates the folder tree and uploads local data", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.site.notes.save("s1", { id: "s1", text: note("Wonderwall"), updatedAt: 1 });
    await a.site.notes.save("s2", { id: "s2", text: note("Wonderwall", "x"), updatedAt: 1 });
    await a.site.settings.save({ zoom: 300, device: "mine" });
    await a.site.photos.save("p1", photoOf("p1"));
    await a.site.photos.setBlob("p1", photoBlob());
    await a.engine.connect({ interactive: true });

    expect(names(drive)).toEqual(
      expect.arrayContaining(["Notes", "Photos", "Site", ".site", "Wonderwall (2).txt", "Wonderwall.txt", "p1.json", "settings.json", "photos"])
    );
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("Wonderwall"));
    const files = drive.tagged("note");
    expect(files).toHaveLength(2);
    const notesFolder = drive.allFiles().find((f) => f.name === "Notes")!;
    expect(files.every((f) => f.parents.includes(notesFolder.id))).toBe(true);
    // the sidecar sits in the meta folder inside the hidden folder, the media in the collection folder
    const hidden = drive.allFiles().find((f) => f.name === ".site")!;
    const metaFolder = drive.allFiles().find((f) => f.name === "photos")!;
    expect(metaFolder.parents).toEqual([hidden.id]);
    expect(drive.tagged("photoMeta")[0].parents).toEqual([metaFolder.id]);
    expect(drive.tagged("photo")[0].parents).toEqual([drive.allFiles().find((f) => f.name === "Photos")!.id]);
    expect(a.engine.getStatus()).toMatchObject({ state: "idle", email: "me@example.com" });
    expect(a.engine.getStatus().lastSyncAt).not.toBeNull();
    // the small photo is uploaded by the default setting
    expect(drive.tagged("photo")).toHaveLength(1);
    expect(drive.tagged("photoMeta")).toHaveLength(1);
    // the stored connection is keyed by folder id
    const conn = await a.store.getMeta<{ email: string; folders: Record<string, string> }>("conn");
    expect(Object.keys(conn!.folders).sort()).toEqual(["hidden", "notes", "photoMeta", "photos", "root"]);
    expect(conn!.email).toBe("me@example.com");
  });

  it("with existing data on both sides links, downloads, uploads and flags conflicts", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.site.notes.save("same", { id: "same", text: note("Same"), updatedAt: 1 });
    await a.site.notes.save("diff", { id: "diff", text: note("Diff", "a"), updatedAt: 1 });
    await a.site.notes.save("onlyA", { id: "onlyA", text: note("OnlyA"), updatedAt: 1 });
    await a.engine.connect({ interactive: true });

    const b = device(drive);
    await b.site.notes.save("same", { id: "same", text: note("Same"), updatedAt: 1 });
    await b.site.notes.save("diff", { id: "diff", text: note("Diff", "b"), updatedAt: 1 });
    await b.site.notes.save("onlyB", { id: "onlyB", text: note("OnlyB"), updatedAt: 1 });
    await b.engine.connect({ interactive: true });

    expect(text(b, "onlyA")).toBe(note("OnlyA"));
    expect(drive.tagged("note").map((f) => f.appProperties.siteId).sort()).toEqual(["diff", "onlyA", "onlyB", "same"]);
    expect(b.engine.getStatus().conflicts.map((c) => [c.kind, c.id])).toEqual([["note", "diff"]]);
    expect(b.engine.getStatus().conflicts[0]).toMatchObject({ localText: note("Diff", "b"), remoteText: note("Diff", "a") });
    // the conflicting file was not overwritten
    expect(drive.readText(noteFile(drive, "diff").id)).toBe(note("Diff", "a"));
  });

  it("settings: newest wins, and local settings without updatedAt count as older", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.site.settings.save({ zoom: 111, device: "a" });
    await a.site.settings.save({ zoom: 222, device: "a" });
    await a.engine.handleLocalChange("settings", { type: "save", id: "settings" }); // an edit the engine tracked
    await a.engine.connect({ interactive: true });

    const b = device(drive);
    await b.site.settings.save({ zoom: 999, device: "b" }); // never edited while tracked: older
    await b.engine.connect({ interactive: true });
    expect(b.site.settings.value.zoom).toBe(222);
  });
});

describe("a site that changes after users connected", () => {
  it("a collection added later gets its folder on the next sync", async () => {
    const drive = new FakeDrive();
    const store = idbStore();
    const before = device(drive, { withFiles: false, store });
    await before.site.notes.save("n1", { id: "n1", text: note("Kept"), updatedAt: 1 });
    await before.engine.connect({ interactive: true });
    before.engine.stop();
    expect(names(drive)).not.toContain("Photos");
    const folders = drive.allFiles().filter((f) => f.mimeType.endsWith("folder"));
    const filesBefore = drive.tagged("note").map((f) => [f.id, f.version]);
    const writesBefore = drive.writeCount;
    expect((await store.getMeta<{ folders: Record<string, string> }>("conn"))!.folders.photos).toBeUndefined();

    // the next release of the site declares a photo collection, over the same local data and the same stored connection
    const after = device(drive, { store, stores: { notes: before.site.notes, settings: before.site.settings } });
    await after.site.photos.save("p1", photoOf("p1"));
    await after.site.photos.setBlob("p1", photoBlob());
    await after.engine.connect({ interactive: false });

    expect(names(drive)).toEqual(expect.arrayContaining(["Photos", "photos"]));
    // the existing folders are reused and the existing note is untouched
    expect(drive.allFiles().filter((f) => f.mimeType.endsWith("folder") && folders.some((o) => o.id === f.id))).toHaveLength(folders.length);
    expect(drive.folderCount()).toBe(folders.length + 2);
    expect(drive.tagged("note").map((f) => [f.id, f.version])).toEqual(filesBefore);
    expect(drive.writeCount).toBeGreaterThan(writesBefore);
    const conn = await store.getMeta<{ folders: Record<string, string> }>("conn");
    expect(conn!.folders.photos).toBeDefined();
    expect(conn!.folders.photoMeta).toBeDefined();
    // and the new collection syncs
    expect(drive.tagged("photoMeta")).toHaveLength(1);
    expect(drive.tagged("photo")).toHaveLength(1);
    expect(text(after, "n1")).toBe(note("Kept"));
  });

  it("files of an undeclared kind are left alone", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    const old = await drive.createFile(
      { name: "old.txt", mimeType: "text/plain", appProperties: { siteKind: "old", siteId: "o1" } },
      new Blob(["from an older version of the site"])
    );
    const oldMeta = await drive.createFile(
      { name: "o2.json", mimeType: "application/json", appProperties: { siteKind: "oldMeta", siteId: "o2" } },
      new Blob(["{}"])
    );

    // pulled
    await a.engine.pull();
    // and met on a first connect from another device
    const b = device(drive);
    await b.site.notes.save("n1", { id: "n1", text: note("Local"), updatedAt: 1 });
    await b.engine.connect({ interactive: true });
    await b.engine.syncNow();

    for (const d of [a, b]) {
      expect(d.site.notes.items.has("o1")).toBe(false);
      expect(d.site.photos.items.size).toBe(0);
      expect(d.engine.getStatus()).toMatchObject({ state: "idle", conflicts: [], pendingRemoteDeletes: [] });
      expect(await d.store.listItems("old")).toEqual([]);
    }
    for (const f of [old, oldMeta]) {
      const now = drive.allFiles().find((x) => x.id === f.id)!;
      expect(now.trashed).toBe(false);
      expect(now.version).toBe(f.version);
    }
    // removing the old file later is not mistaken for a delete of anything of ours either
    drive.simulateExternalTrash(old.id);
    await a.engine.pull();
    expect(a.engine.getStatus().pendingRemoteDeletes).toEqual([]);
    expect(a.site.notes.items.has("o1")).toBe(false);
    expect([...a.site.notes.items.keys()]).toEqual(["n1"]);
  });

  it("a site with no settings and no file collections syncs", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { withFiles: false, withSettings: false });
    await a.site.notes.save("n1", { id: "n1", text: note("Alone"), updatedAt: 1 });
    await a.engine.connect({ interactive: true });
    expect(names(drive).sort()).toEqual([".site", "Alone.txt", "Notes", "Site"].sort());
    expect(a.engine.getStatus().state).toBe("idle");

    const b = device(drive, { withFiles: false, withSettings: false });
    await b.engine.connect({ interactive: true });
    expect(text(b, "n1")).toBe(note("Alone"));
    await a.site.notes.userSave({ id: "n1", text: note("Alone", "edited"), updatedAt: 99 });
    await a.engine.syncNow();
    await b.engine.pull();
    expect(text(b, "n1")).toBe(note("Alone", "edited"));
    expect(drive.tagged("settings")).toEqual([]);
    expect(await listAllFiles(drive, { appProperties: { siteKind: "photoMeta" } })).toEqual([]);
  });

  it("two namespaces on one FakeDrive never see each other", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { namespace: "alpha" });
    const b = device(drive, { namespace: "beta" });
    expect(testSite({ namespace: "alpha" }).config.namespace).toBe("alpha");
    await a.site.notes.save("n1", { id: "n1", text: note("Alpha note"), updatedAt: 1 });
    await b.site.notes.save("n2", { id: "n2", text: note("Beta note"), updatedAt: 1 });
    await a.engine.connect({ interactive: true });
    await b.engine.connect({ interactive: true });
    await a.engine.syncNow();
    await b.engine.syncNow();

    expect([...a.site.notes.items.keys()]).toEqual(["n1"]);
    expect([...b.site.notes.items.keys()]).toEqual(["n2"]);
    expect(drive.tagged("note", undefined, "alpha").map((f) => f.appProperties.alphaId)).toEqual(["n1"]);
    expect(drive.tagged("note", undefined, "beta").map((f) => f.appProperties.betaId)).toEqual(["n2"]);
    // separate folder trees
    expect(drive.allFiles().filter((f) => f.name === "Site")).toHaveLength(2);
    const [rootA, rootB] = [drive.tagged("folder", "root", "alpha")[0], drive.tagged("folder", "root", "beta")[0]];
    expect(rootA.id).not.toBe(rootB.id);
    // an edit on one side never reaches the other
    await a.site.notes.userSave({ id: "n1", text: note("Alpha note", "x"), updatedAt: 99 });
    await a.engine.settled();
    await a.engine.syncNow();
    await b.engine.pull();
    expect(b.site.notes.items.get("n2")!.text).toBe(note("Beta note"));
    expect(b.engine.getStatus().conflicts).toEqual([]);
  });
});
