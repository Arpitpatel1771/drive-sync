import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine, backoffMs } from "../src/engine/engine";
import { FakeDrive } from "../src/testing/fakeDrive";
import { device, deleteIdbDatabases, idbStore, noteFile, now, saveNote, text } from "./kit";
import { noteText as note } from "./site";

afterEach(deleteIdbDatabases);

describe("queue, restart and errors", () => {
  it("the queue persists across an engine restart", async () => {
    const drive = new FakeDrive();
    const store = idbStore();
    const a = device(drive, { store });
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    await saveNote(a, "s1", note("One", "pending"));
    expect((await store.listQueue()).map((q) => q.key)).toEqual(["note:s1"]);
    a.engine.stop();

    const fresh = new SyncEngine({ config: a.site.config, api: drive, auth: a.auth, store, now, debounceMs: null });
    await fresh.connect({ interactive: false }); // resumes from stored meta
    expect(fresh.getStatus().state).toBe("idle");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "pending"));
    expect(await store.listQueue()).toHaveLength(0);
    fresh.stop();
  });

  it("offline keeps the queue, then recovers", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    await saveNote(a, "s1", note("One", "later"));
    drive.failNext(0, "networkError");
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("offline");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One"));
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("idle");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "later"));
  });

  it("401 refreshes silently once, then goes to authRequired and keeps the queue", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });

    await saveNote(a, "s1", note("One", "v2"));
    drive.failNext(401, "authError");
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("idle"); // silent refresh worked
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "v2"));

    await saveNote(a, "s1", note("One", "v3"));
    a.authState.needInteraction = true;
    drive.failNext(401, "authError");
    await a.engine.syncNow();
    expect(a.engine.getStatus().state).toBe("authRequired");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "v2"));

    a.authState.needInteraction = false;
    await a.engine.connect({ interactive: true }); // the "sign in to resume" click
    expect(a.engine.getStatus().state).toBe("idle");
    expect(drive.readText(noteFile(drive, "s1").id)).toBe(note("One", "v3"));
  });

  it("a silent resume that needs interaction reports authRequired", async () => {
    const drive = new FakeDrive();
    const store = idbStore();
    const a = device(drive, { store });
    await a.engine.connect({ interactive: true });
    a.engine.stop();
    const fresh = device(drive, { store, site: a.site });
    fresh.authState.needInteraction = true;
    await fresh.engine.connect({ interactive: false });
    expect(fresh.engine.getStatus().state).toBe("authRequired");
    fresh.engine.stop();
  });

  it("5xx, 429 and rate limits go to retrying with backoff", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    for (const [status, reason] of [
      [503, "backendError"],
      [429, "tooManyRequests"],
      [403, "rateLimitExceeded"],
    ] as const) {
      await saveNote(a, "s1", note("One", String(status)));
      drive.failNext(status, reason);
      await a.engine.syncNow();
      expect(a.engine.getStatus().state).toBe("retrying");
      await a.engine.syncNow();
      expect(a.engine.getStatus().state).toBe("idle");
    }
    expect([1, 2, 3, 4, 8, 9, 20].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 256000, 300000, 300000]);
  });

  it("timers: a change is flushed after the debounce", async () => {
    const drive = new FakeDrive();
    const a = device(drive, { debounceMs: 5 });
    await a.engine.connect({ interactive: true });
    await saveNote(a, "s1", note("One"));
    await vi.waitFor(() => expect(drive.tagged("note")).toHaveLength(1));
    a.engine.stop();
  });

  it("disconnect forgets the connection and leaves data alone", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await saveNote(a, "s1", note("One"));
    await a.engine.connect({ interactive: true });
    await a.engine.disconnect();
    expect(a.engine.getStatus().state).toBe("disconnected");
    expect(text(a, "s1")).toBe(note("One"));
    expect(drive.tagged("note")).toHaveLength(1);
    expect(a.auth.signOut).toHaveBeenCalled();
    expect(await a.store.getMeta("conn")).toBeUndefined();
    expect(await a.store.listItems()).toEqual([]);
  });

  it("stops listening to local changes after stop()", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    a.engine.stop();
    await saveNote(a, "s1", note("One"));
    expect(await a.store.listQueue()).toEqual([]);
  });
});
