import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriveSync, type DriveSync } from "../src/createDriveSync";
import type { DriveSyncConfig } from "../src/config";
import { FakeAuth, FakeDrive, createMemorySyncStore } from "../src/testing";
import * as testing from "../src/testing";
import * as core from "../src/index";
import { testSite } from "./site";

const open: DriveSync[] = [];
const track = (d: DriveSync) => (open.push(d), d);
afterEach(() => {
  open.splice(0).forEach((d) => d.stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(google = { clientId: "c", apiKey: "k", appId: "a" }, extra: Partial<DriveSyncConfig> = {}) {
  const site = testSite();
  const drive = new FakeDrive({ namespace: "site" });
  const config: DriveSyncConfig = { ...site.config, google, ...extra };
  return { site, drive, config };
}

describe("createDriveSync", () => {
  it("unconfigured: no IndexedDB, actions reject, start/stop/subscribe are no-ops", async () => {
    const openSpy = vi.spyOn(indexedDB, "open");
    const { config } = setup({ clientId: "", apiKey: "", appId: "" });
    const d = track(createDriveSync(config));
    expect(d.configured).toBe(false);
    expect(d.status.state).toBe("disconnected");
    await expect(d.connect()).rejects.toThrow(/not configured/);
    await expect(d.syncNow()).rejects.toThrow(/not configured/);
    await expect(d.importFromDrive()).rejects.toThrow(/not configured/);
    expect(() => d.itemStatus("photo", "p")).toThrow(/not configured/);
    const cb = vi.fn();
    d.subscribe(cb)();
    await d.start();
    d.stop();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("collections expose the label, defaulting to the kind", () => {
    const { config } = setup();
    const d = track(createDriveSync(config));
    for (const c of d.collections) expect(c.label).toEqual({ one: c.kind, other: c.kind });
    const [first, ...rest] = config.collections;
    const labelled = track(createDriveSync({ ...config, collections: [{ ...first, label: { one: "tune", other: "tunes" } }, ...rest] }));
    expect(labelled.collections[0].label).toEqual({ one: "tune", other: "tunes" });
  });

  it("throws on a bad config even when unconfigured", () => {
    const { config } = setup({ clientId: "", apiKey: "", appId: "" });
    expect(() => createDriveSync({ ...config, collections: [config.collections[0], config.collections[0]] })).toThrow(/duplicate kind/);
  });

  it("connect with fake deps reaches idle and notifies subscribers", async () => {
    const { drive, config } = setup();
    const d = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store: createMemorySyncStore() }));
    expect(d.configured).toBe(true);
    const seen: string[] = [];
    d.subscribe((s) => seen.push(s.state));
    await d.connect();
    expect(d.status.state).toBe("idle");
    expect(seen.length).toBeGreaterThan(0);
    const { status, conflicts, pendingDeletes } = d; // getters must not depend on `this`
    expect(status.state).toBe("idle");
    expect(conflicts).toEqual([]);
    expect(pendingDeletes).toEqual([]);
    const countBefore = seen.length;
    const late = vi.fn();
    const off = d.subscribe(late);
    off();
    off();
    await d.syncNow();
    expect(late).not.toHaveBeenCalled();
    expect(seen.length).toBeGreaterThanOrEqual(countBefore);
    expect(d.conflicts).toEqual([]);
    expect(d.uploadSetting("photo")).toBe("small");
    await d.setUploadSetting("photo", "all");
    expect(d.uploadSetting("photo")).toBe("all");
    await d.disconnect();
    expect(d.status.state).toBe("disconnected");
  });

  it("start resumes a stored connection", async () => {
    const { drive, config } = setup();
    const store = createMemorySyncStore();
    const a = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store }));
    await a.connect();
    a.stop();
    const b = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store }));
    expect(b.status.state).toBe("disconnected");
    await b.start();
    expect(b.status.state).toBe("idle");
  });

  it("importFromDrive passes the MIME list and returns a count for every kind", async () => {
    const { drive, config } = setup();
    const file = drive.simulateExternalCreate({ name: "hello.txt", text: "hi" });
    const picker = vi.fn(async () => [file.id]);
    const d = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store: createMemorySyncStore(), pick: picker }));
    await d.connect();
    expect(await d.importFromDrive()).toEqual({ note: 1, photo: 0 });
    expect(picker).toHaveBeenCalledWith({ token: "fake-token", apiKey: "k", appId: "a", mimeTypes: ["text/plain", "image/*"] });
    const none = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store: createMemorySyncStore(), pick: async () => [] }));
    await none.connect();
    expect(await none.importFromDrive()).toEqual({ note: 0, photo: 0 });
  });

  it("fake mode needs devFake and the localStorage flag, even without Google ids", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const { config } = setup({ clientId: "", apiKey: "", appId: "" });
    expect(createDriveSync({ ...config, devFake: true }).configured).toBe(false);
    store.set("site.fakeDrive", "1");
    expect(createDriveSync(config).configured).toBe(false);
    const d = track(createDriveSync({ ...config, devFake: true }));
    expect(d.configured).toBe(true);
    await d.connect();
    expect(d.status.state).toBe("idle");
    expect(d.status.email).toBe("dev@example.com");
  });

  it("status is the same object until something changes", async () => {
    const { drive, config } = setup();
    const d = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store: createMemorySyncStore() }));
    expect(d.status).toBe(d.status);
    await d.connect();
    const a = d.status;
    expect(d.status).toBe(a);
    expect(d.conflicts).toBe(a.conflicts);
    await d.syncNow(); // emits: a new snapshot
    expect(d.status).not.toBe(a);
  });

  it("setUploadSetting notifies subscribers with a new status", async () => {
    const { drive, config } = setup();
    const d = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store: createMemorySyncStore() }));
    await d.connect();
    const before = d.status;
    const seen: unknown[] = [];
    d.subscribe((s) => seen.push(s));
    await d.setUploadSetting("photo", "all");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toBe(before);
    expect(d.status).not.toBe(before);
  });

  it("unsubscribe stops delivery", async () => {
    const { drive, config } = setup();
    const d = track(createDriveSync(config, { api: drive, auth: new FakeAuth(), store: createMemorySyncStore() }));
    const cb = vi.fn();
    const off = d.subscribe(cb);
    await d.connect();
    expect(cb).toHaveBeenCalled();
    off();
    cb.mockClear();
    await d.syncNow();
    await d.disconnect();
    expect(cb).not.toHaveBeenCalled();
  });

  it("the disconnected status is frozen and works destructured", () => {
    const { config } = setup({ clientId: "", apiKey: "", appId: "" });
    const { status, conflicts, pendingDeletes } = createDriveSync(config);
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(conflicts)).toBe(true);
    expect(Object.isFrozen(pendingDeletes)).toBe(true);
    expect(Object.isFrozen(status.uploads)).toBe(true);
  });

  it("SSR: constructs and reads with no window, localStorage or indexedDB", async () => {
    const saved = { window: (globalThis as any).window, localStorage: (globalThis as any).localStorage, indexedDB: (globalThis as any).indexedDB };
    for (const k of Object.keys(saved)) (globalThis as any)[k] = undefined;
    try {
      const { config } = setup();
      const d = createDriveSync({ ...config, devFake: true });
      expect(typeof d.configured).toBe("boolean");
      expect(d.status.state).toBe("disconnected");
      expect(d.conflicts).toEqual([]);
      expect(d.itemStatus("photo", "p")).toBe("local");
      expect(d.uploadSetting("photo")).toBe("small");
      d.subscribe(() => undefined)();
      d.stop();
    } finally {
      Object.assign(globalThis, saved);
    }
  });

  it("a throwing localStorage means no fake mode", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    const { config } = setup({ clientId: "", apiKey: "", appId: "" });
    expect(createDriveSync({ ...config, devFake: true }).configured).toBe(false);
  });
});

describe("entry points", () => {
  it("./testing exports the fakes", () => {
    expect(Object.keys(testing).sort()).toEqual(["FakeAuth", "FakeDrive", "createMemorySyncStore"]);
  });
  it("index exports only the public API", () => {
    expect(Object.keys(core).sort()).toEqual(["AuthRequiredError", "DriveError", "VERSION", "createDriveSync", "documents", "files"]);
  });
});

describe("facade config errors", () => {
  it("createDriveSync throws on a bad config", () => {
    const { config } = setup();
    const dup = [config.collections[0], config.collections[0]];
    expect(() => createDriveSync({ ...config, collections: dup })).toThrow(/duplicate kind/);
    expect(() => createDriveSync({ ...config, namespace: "bad ns" })).toThrow(/namespace/);
    expect(() => createDriveSync({ ...config, collections: [{ ...config.collections[0], kind: "settings" }] })).toThrow(/reserved/);
  });
});
