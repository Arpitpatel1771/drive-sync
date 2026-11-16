import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../src/engine/engine";
import { createMemorySyncStore } from "../src/store/memorySyncStore";
import { FakeDrive } from "../src/testing/fakeDrive";
import { device, fakeAuth, now, photoBlob, photoOf, saveNote, savePhoto } from "./kit";
import { noteText as note, testSite } from "./site";

afterEach(() => vi.useRealTimers());

describe("a state-load failure", () => {
  it("leaves the engine inert: nothing is pushed and the status carries the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const drive = new FakeDrive();
    const site = testSite({ now });
    await site.notes.userSave({ id: "n1", text: note("One"), updatedAt: 1 });
    const store = createMemorySyncStore();
    await store.setMeta("conn", { email: "me@example.com", folders: {} });
    const listItems = vi.spyOn(store, "listItems");
    vi.spyOn(store, "getMeta").mockRejectedValue(new Error("disk unreadable"));
    const { auth } = fakeAuth();
    const engine = new SyncEngine({ config: site.config, api: drive, auth, store, now, debounceMs: null });
    await engine.connect({ interactive: false }).catch(() => undefined);
    await engine.syncNow();
    await engine.pull();
    engine.start();
    expect(drive.writeCount).toBe(0);
    expect(engine.getStatus().state).toBe("disconnected");
    expect(engine.getStatus().error).toMatch(/disk unreadable/);
    await expect(engine.connect({ interactive: true })).rejects.toThrow(/disk unreadable/);
    expect(drive.writeCount).toBe(0);
    expect(listItems).not.toHaveBeenCalled();
  });
});

describe("stopped engine", () => {
  it("does not re-arm the flush timer after stop() or after a failed sync", async () => {
    vi.useFakeTimers();
    const drive = new FakeDrive();
    const a = device(drive, { debounceMs: 50 });
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    a.engine.stop();
    vi.clearAllTimers();
    await saveNote(a, "s1", note("One", "v2"));
    drive.failNext(500, "backendError");
    await a.engine.syncNow(); // fails, handleError would arm a retry
    expect(vi.getTimerCount()).toBe(0);
    await a.engine.connect({ interactive: true }); // clears the flag
    drive.failNext(500, "backendError");
    await saveNote(a, "s1", note("One", "v3"));
    await a.engine.syncNow();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    a.engine.stop();
  });
});

describe("item status refresh", () => {
  it("an idle sync does not re-read every item", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    for (const id of ["p1", "p2", "p3"]) await savePhoto(a, photoOf(id), photoBlob());
    await a.engine.connect({ interactive: true });
    await a.engine.syncNow(); // absorbs the changes feed entries for our own uploads
    const get = vi.spyOn(a.site.photos, "get");
    await a.engine.syncNow();
    expect(get).not.toHaveBeenCalled();
    // a push still refreshes
    await savePhoto(a, photoOf("p4"), photoBlob());
    await a.engine.syncNow();
    expect(a.engine.itemStatus("photo", "p4")).toBe("inDrive");
  });
});
