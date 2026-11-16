import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDriveSync } from "../src/createDriveSync";
import { FakeAuth, FakeDrive, createMemorySyncStore } from "../src/testing";
import { DriveSyncProvider, useDriveSync, chipFor, dotTone, initialsFor, itemBadge, relativeTime } from "../src/react";
import type { SyncStatus } from "../src/engine/types";
import { testSite } from "./site";

const base: SyncStatus = { state: "idle", email: null, name: null, picture: null, lastSyncAt: null, conflicts: [], pendingRemoteDeletes: [], uploads: {}, error: null };

describe("chipFor", () => {
  it("maps states to exact texts", () => {
    expect(chipFor({ ...base, state: "disconnected" })).toBeNull();
    expect(chipFor(base)).toMatchObject({ text: "Synced", tone: "ok" });
    expect(chipFor({ ...base, state: "syncing" })?.text).toBe("Syncing…");
    expect(chipFor({ ...base, state: "offline" })?.text).toBe("Offline — saved locally");
    expect(chipFor({ ...base, state: "authRequired" })).toMatchObject({ text: "Drive: sign in to resume", action: "connect" });
    expect(chipFor({ ...base, state: "retrying" })?.text).toBe("Retrying");
    expect(chipFor({ ...base, state: "driveFull" })?.text).toBe("Drive full — uploads paused");
  });
  it("shows conflicts when idle", () => {
    const c = { id: "a" } as SyncStatus["conflicts"][number];
    expect(chipFor({ ...base, conflicts: [c, c] })).toMatchObject({ text: "2 conflicts", action: "conflicts" });
    expect(chipFor({ ...base, conflicts: [c] })?.text).toBe("1 conflict");
  });
});

describe("itemBadge", () => {
  it("follows the badge rules", () => {
    expect(itemBadge("notDownloaded").text).toBe("In Drive · not downloaded");
    expect(itemBadge("otherDevice").text).toBe("Not uploaded (on another device)");
    expect(itemBadge("inDrive").text).toBe("In Drive");
    expect(itemBadge("uploading", 0.426).text).toBe("Uploading 43%");
    expect(itemBadge("uploading").text).toBe("Uploading 0%");
    expect(itemBadge("local")).toEqual({ text: "This device only", kind: "local" });
  });
});

describe("relativeTime / dotTone / initialsFor", () => {
  it("formats relative time", () => {
    expect(relativeTime(1000, 5000)).toBe("just now");
    expect(relativeTime(0, 5 * 60000)).toBe("5 min ago");
    expect(relativeTime(0, 3 * 3600000)).toBe("3 h ago");
    expect(relativeTime(0, 2 * 86400000)).toBe("2 d ago");
  });
  it("maps dot tones", () => {
    expect(dotTone(base)).toBe("ok");
    expect(dotTone({ ...base, state: "syncing" })).toBe("accent");
    expect(dotTone({ ...base, state: "retrying" })).toBe("warning");
    expect(dotTone({ ...base, state: "driveFull" })).toBe("error");
    expect(dotTone({ ...base, state: "offline" })).toBe("neutral");
    expect(dotTone({ ...base, state: "disconnected" })).toBe("neutral");
  });
  it("initials", () => {
    expect(initialsFor("Ann Marie Lee", null)).toBe("AL");
    expect(initialsFor("ann", "x@y.z")).toBe("AN");
    expect(initialsFor(null, "zed@y.z")).toBe("Z");
    expect(initialsFor(null, null)).toBe("?");
  });
});

function Probe() {
  const d = useDriveSync();
  return <span>{`${d.configured}|${d.ready}|${d.status.state}|${d.conflictsOpen}|${d.uploadProgress("photo", "p")}`}</span>;
}

describe("DriveSyncProvider", () => {
  it("renders on a server with an unconfigured drive, no window access, no start during render", () => {
    const site = testSite();
    const drive = createDriveSync({ ...site.config, google: { clientId: "", apiKey: "", appId: "" } });
    const start = vi.spyOn(drive, "start");
    const html = renderToStaticMarkup(
      <DriveSyncProvider drive={drive}>
        <Probe />
      </DriveSyncProvider>,
    );
    expect(html).toContain("false|false|disconnected|false|0");
    expect(start).not.toHaveBeenCalled();
  });

  it("renders without a provider (default value)", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("false|false|disconnected");
  });

  it("renders a configured, injected drive without starting it", () => {
    const site = testSite();
    const drive = createDriveSync(site.config, { api: new FakeDrive({ namespace: "site" }), auth: new FakeAuth(), store: createMemorySyncStore() });
    const html = renderToStaticMarkup(
      <DriveSyncProvider drive={drive}>
        <Probe />
      </DriveSyncProvider>,
    );
    expect(html).toContain("true|false|disconnected");
  });
});

describe("createStatusStore", () => {
  it("returns a stable snapshot until the drive reports a change", async () => {
    const { createStatusStore } = await import("../src/react/DriveSyncProvider");
    let cb: ((s: SyncStatus) => void) | null = null;
    const drive = {
      get status() {
        return { ...base };
      },
      subscribe: (f: (s: SyncStatus) => void) => ((cb = f), () => (cb = null)),
    } as never;
    const store = createStatusStore(drive);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const onChange = vi.fn();
    const off = store.subscribe(onChange);
    const next = { ...base, state: "syncing" as const };
    cb!(next);
    expect(store.getSnapshot()).toBe(next);
    off();
    expect(cb).toBeNull();
  });
});

describe("nextToast", () => {
  it("toasts only new, non-empty errors", async () => {
    const { nextToast } = await import("../src/react/DriveSyncProvider");
    expect(nextToast(null, null)).toBeNull();
    expect(nextToast(null, "boom")).toBe("boom");
    expect(nextToast("boom", "boom")).toBeNull();
    expect(nextToast("boom", null)).toBeNull();
    expect(nextToast("boom", "other")).toBe("other");
  });
});
