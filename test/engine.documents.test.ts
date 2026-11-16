import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/engine/engine";
import { FakeDrive } from "../src/testing/fakeDrive";
import { device, deleteIdbDatabases, idbStore, lastGeneratedId, noteFile, now, removeNote, renamePhoto, saveNote, text, photoOf, type Dev } from "./kit";
import { noteText as note } from "./site";

afterEach(deleteIdbDatabases);

describe("note edits", () => {
  async function pair() {
    const drive = new FakeDrive();
    const a = device(drive);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    expect(text(b, "s1")).toBe(note("One"));
    return { drive, a, b };
  }

  it("local-only edit pushes to Drive", async () => {
    const { drive, a } = await pair();
    await saveNote(a, "s1", note("One", "edited"));
    await a.engine.syncNow();
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "edited"));
  });

  it("remote-only edit applies locally on pull", async () => {
    const { drive, b } = await pair();
    drive.simulateExternalEdit(noteFile(drive, "s1").id, note("One", "from drive"));
    await b.engine.pull();
    expect(text(b, "s1")).toBe(note("One", "from drive"));
    expect(b.engine.getStatus().conflicts).toHaveLength(0);
  });

  it("renaming the title renames the Drive file", async () => {
    const { drive, a } = await pair();
    await saveNote(a, "s1", note("Renamed"));
    await a.engine.syncNow();
    expect(noteFile(drive, "s1").name).toBe("Renamed.txt");
  });

  async function conflicted() {
    const { drive, a, b } = await pair();
    await saveNote(a, "s1", note("One", "A-edit"));
    await saveNote(b, "s1", note("One", "B-edit"));
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.engine.getStatus().conflicts).toHaveLength(1);
    expect(b.engine.getStatus().state).toBe("idle");
    return { drive, a, b };
  }

  it("both edited: conflict, nothing overwritten", async () => {
    const { drive, b } = await conflicted();
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "A-edit"));
    expect(text(b, "s1")).toBe(note("One", "B-edit"));
  });

  it("conflicts survive a restart", async () => {
    const drive = new FakeDrive();
    const store = idbStore();
    const a = device(drive, { store });
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    const b = device(drive);
    await b.engine.connect({ interactive: true });
    await saveNote(a, "s1", note("One", "A"));
    await a.engine.syncNow();
    await saveNote(b, "s1", note("One", "B"));
    await b.engine.syncNow();
    await b.engine.syncNow();
    drive.simulateExternalEdit(noteFile(drive, "s1").id, note("One", "ext"));
    await saveNote(a, "s1", note("One", "A2"));
    await a.engine.syncNow();
    expect(a.engine.getStatus().conflicts).toHaveLength(1);
    a.engine.stop();
    const restarted = new SyncEngine({ config: a.site.config, api: drive, auth: a.auth, store, now, debounceMs: null });
    await restarted.connect({ interactive: false }).catch(() => undefined);
    expect(restarted.getStatus().conflicts.map((c) => [c.kind, c.id])).toEqual([["note", "s1"]]);
    expect(restarted.getStatus().conflicts[0].remoteText).toBe(note("One", "ext"));
    restarted.stop();
  });

  it("keep this device's overwrites Drive", async () => {
    const { drive, b } = await conflicted();
    await b.engine.resolveConflict("note", "s1", "local");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "B-edit"));
    expect(b.engine.getStatus().conflicts).toHaveLength(0);
  });

  it("keep Drive's overwrites local", async () => {
    const { drive, b } = await conflicted();
    await b.engine.resolveConflict("note", "s1", "remote");
    expect(text(b, "s1")).toBe(note("One", "A-edit"));
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "A-edit"));
    // stays quiet afterwards
    await b.engine.syncNow();
    expect(b.engine.getStatus().conflicts).toHaveLength(0);
  });

  it("keep both saves the remote as '<title> (Drive)' with a new id and local overwrites Drive", async () => {
    const { drive, a, b } = await conflicted();
    await b.engine.resolveConflict("note", "s1", "both");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "B-edit"));
    const copy = b.site.notes.items.get(lastGeneratedId())!;
    expect(copy.text).toBe(note("One (Drive)", "A-edit"));
    expect(drive.tagged("note")).toHaveLength(2);
    await a.engine.syncNow();
    expect([...a.site.notes.items.values()].map((s) => s.text.split("\n")[0]).sort()).toEqual(["One", "One (Drive)"]);
  });

  it('conflicts: "newest" skips the dialog and the newer edit wins', async () => {
    const drive = new FakeDrive();
    const a = device(drive, { noteConflicts: "newest" });
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    const b = device(drive, { noteConflicts: "newest" });
    await b.engine.connect({ interactive: true });

    // a edits first, b edits later: b's edit is newer than Drive's copy of a's, so it wins on b
    await saveNote(a, "s1", note("One", "A-edit"));
    await a.engine.syncNow();
    await b.site.notes.save("s1", { id: "s1", text: note("One", "B-edit"), updatedAt: Date.parse("2100-01-01") });
    await b.engine.handleLocalChange("note", { type: "save", id: "s1" });
    await b.engine.syncNow();
    expect(b.engine.getStatus().conflicts).toEqual([]);
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "B-edit"));
    await a.engine.syncNow();
    expect(text(a, "s1")).toBe(note("One", "B-edit"));

    // the other way round: Drive's copy is newer than b's edit, so Drive wins
    await saveNote(a, "s1", note("One", "A-again"));
    await a.engine.syncNow();
    await b.site.notes.save("s1", { id: "s1", text: note("One", "B-old"), updatedAt: 5 });
    await b.engine.handleLocalChange("note", { type: "save", id: "s1" });
    await b.engine.syncNow();
    expect(b.engine.getStatus().conflicts).toEqual([]);
    expect(text(b, "s1")).toBe(note("One", "A-again"));
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "A-again"));
  });
});

describe("deletes", () => {
  async function pair(opts: Parameters<typeof device>[1] = {}) {
    const drive = new FakeDrive();
    const a = device(drive, opts);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    const b = device(drive, opts);
    await b.engine.connect({ interactive: true });
    return { drive, a, b };
  }

  it("local delete trashes the Drive file", async () => {
    const { drive, a, b } = await pair();
    await removeNote(a, "s1");
    await a.engine.syncNow();
    expect(noteFile(drive, "s1").trashed).toBe(true);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes).toEqual([{ kind: "note", id: "s1", title: "One" }]);
    expect(text(b, "s1")).toBeDefined(); // never applied silently
  });

  it("remote delete: accepting deletes locally", async () => {
    const { drive, b } = await pair();
    drive.simulateExternalTrash(noteFile(drive, "s1").id);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes).toHaveLength(1);
    await b.engine.resolveRemoteDeletes([{ kind: "note", id: "s1" }], true);
    expect(text(b, "s1")).toBeUndefined();
    expect(b.engine.getStatus().pendingRemoteDeletes).toHaveLength(0);
    await b.engine.syncNow();
    expect(text(b, "s1")).toBeUndefined();
  });

  it("remote delete: declining re-uploads the local copy", async () => {
    const { drive, b } = await pair();
    drive.simulateExternalDelete(noteFile(drive, "s1").id);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes).toHaveLength(1);
    await b.engine.resolveRemoteDeletes([{ kind: "note", id: "s1" }], false);
    expect(text(b, "s1")).toBe(note("One"));
    const live = drive.tagged("note").filter((f) => !f.trashed);
    expect(live).toHaveLength(1);
    expect(drive.readText(live[0].id)).toBe(note("One"));
  });

  it("a 404 on a known file is treated as a remote delete", async () => {
    const { drive, a } = await pair();
    drive.simulateExternalDelete(noteFile(drive, "s1").id);
    await saveNote(a, "s1", note("One", "edit"));
    await a.engine.syncNow();
    expect(a.engine.getStatus().pendingRemoteDeletes.map((d) => d.id)).toEqual(["s1"]);
  });

  it("remoteDelete: follow deletes without asking", async () => {
    const { drive, b } = await pair({ noteRemoteDelete: "follow" });
    drive.simulateExternalTrash(noteFile(drive, "s1").id);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes).toEqual([]);
    expect(text(b, "s1")).toBeUndefined();
    expect(await b.store.getItem("note", "s1")).toBeUndefined();
    await b.engine.syncNow();
    expect(text(b, "s1")).toBeUndefined();
    expect(b.engine.getStatus().state).toBe("idle");
  });

  it("remoteDelete: ignore keeps the local item", async () => {
    const { drive, b } = await pair({ noteRemoteDelete: "ignore" });
    drive.simulateExternalTrash(noteFile(drive, "s1").id);
    await b.engine.pull();
    expect(b.engine.getStatus().pendingRemoteDeletes).toEqual([]);
    expect(text(b, "s1")).toBe(note("One"));
    await b.engine.syncNow();
    expect(text(b, "s1")).toBe(note("One"));
    expect(b.engine.getStatus()).toMatchObject({ state: "idle", pendingRemoteDeletes: [] });
  });
});

describe("renames and adoption", () => {
  it("a rename in Drive keeps the link", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    drive.simulateExternalRename(noteFile(drive, "s1").id, "My own name.txt");
    await a.engine.pull();
    expect(text(a, "s1")).toBe(note("One"));
    await saveNote(a, "s1", note("One", "more"));
    await a.engine.syncNow();
    expect(drive.tagged("note")).toHaveLength(1);
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "more"));
    expect(a.engine.getStatus().conflicts).toHaveLength(0);
  });

  it("adopts an untagged .txt picked via import: tagged and moved into the notes folder", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    const stray = drive.simulateExternalCreate({ name: "random.txt", text: note("Imported") });
    const res = await a.engine.importFiles([stray.id]);
    expect(res.note).toHaveLength(1);
    const id = res.note[0];
    expect(text(a, id)).toBe(note("Imported"));
    const folder = drive.allFiles().find((f) => f.name === "Notes")!;
    const file = drive.allFiles().find((f) => f.id === stray.id)!;
    expect(file.appProperties).toEqual({ siteKind: "note", siteId: id });
    expect(file.parents).toEqual([folder.id]);
    // linked: a later edit updates the same file
    await saveNote(a, id, note("Imported", "x"));
    await a.engine.syncNow();
    expect(drive.readText(stray.id)).toBe(note("Imported", "x"));
  });

  it("imports picked media as a photo with a meta file", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    const m = await drive.createFile({ name: "riff.png", mimeType: "image/png" }, new Blob(["abcdef"]));
    const res = await a.engine.importFiles([m.id]);
    expect(res.photo).toHaveLength(1);
    const photo = a.site.photos.items.get(res.photo[0])!;
    expect(photo).toMatchObject({ name: "riff", big: false });
    expect(a.engine.itemStatus("photo", photo.id)).toBe("inDrive");
    expect(drive.tagged("photoMeta")).toHaveLength(1);
    expect(drive.tagged("photo")).toHaveLength(1); // not uploaded twice
    expect(drive.tagged("photo")[0].id).toBe(m.id);
  });
});

describe("a remote note the site can store as it is", () => {
  it("is still stored when it does not look like a normal note", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    const folder = drive.allFiles().find((f) => f.name === "Notes")!;
    await drive.createFile(
      { name: "Broken.txt", mimeType: "text/plain", parents: [folder.id], appProperties: { siteKind: "note", siteId: "broken-1" } },
      new Blob(["Broken\nthis is not a note at all ###"])
    );
    await a.engine.pull();
    expect(a.site.notes.items.get("broken-1")?.text).toBe("Broken\nthis is not a note at all ###");
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("idle");
  });
});

describe("two devices", () => {
  it("converge on the same library", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    const b = device(drive);
    await saveNote(a, "a1", note("Alpha"));
    await saveNote(a, "a2", note("Beta"));
    await a.site.photos.save("c1", photoOf("c1"));
    await a.site.photos.setBlob("c1", new Blob(["0123456789"], { type: "image/png" }));
    await a.site.settings.save({ zoom: 280, device: "a" });
    await a.engine.handleLocalChange("settings", { type: "save", id: "settings" });
    await a.engine.connect({ interactive: true });
    await saveNote(b, "b1", note("Gamma"));
    await b.engine.connect({ interactive: true });
    await a.engine.syncNow();

    await saveNote(a, "a1", note("Alpha", "a-edit"));
    await saveNote(b, "b1", note("Gamma", "b-edit"));
    await removeNote(b, "a2");
    await renamePhoto(b, "c1", "Renamed on B");
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    await b.engine.syncNow();
    // a's pending-delete for a2 is confirmed
    await a.engine.resolveRemoteDeletes([{ kind: "note", id: "a2" }], true);
    await b.engine.syncNow();

    const lib = (d: Dev) => ({
      notes: Object.fromEntries([...d.site.notes.items.values()].map((s) => [s.id, s.text])),
      photos: Object.fromEntries([...d.site.photos.items.values()].map((c) => [c.id, c.name])),
      zoom: d.site.settings.value.zoom,
    });
    expect(lib(a)).toEqual(lib(b));
    expect(lib(a).notes).toEqual({ a1: note("Alpha", "a-edit"), b1: note("Gamma", "b-edit") });
    expect(lib(a).photos).toEqual({ c1: "Renamed on B" });
    expect(lib(a).zoom).toBe(280);
    expect(a.engine.getStatus().conflicts).toHaveLength(0);
    expect(b.engine.getStatus().conflicts).toHaveLength(0);
  });
});
