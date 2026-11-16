import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, DRIVE_SCOPES, GisDriveAuth, loadCachedProfile, parseProfile } from "../src/drive/auth";

describe("parseProfile", () => {
  it("reads email, name and picture", () => {
    expect(parseProfile({ email: "a@b.c", name: "Ann Lee", given_name: "Ann", picture: "https://x/p.png" })).toEqual({ email: "a@b.c", name: "Ann Lee", picture: "https://x/p.png" });
  });
  it("falls back to given_name and null picture", () => {
    expect(parseProfile({ email: "a@b.c", given_name: "Ann" })).toEqual({ email: "a@b.c", name: "Ann", picture: null });
  });
  it("rejects data without an email", () => {
    expect(parseProfile({ name: "x" })).toBeNull();
    expect(parseProfile(null)).toBeNull();
  });
});

describe("GisDriveAuth profile", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { google?: unknown }).google;
  });

  function fakeGoogle(respond: (cfg: { callback: (r: object) => void; error_callback?: (e: object) => void }) => void) {
    (globalThis as { google?: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { callback: (r: object) => void; error_callback?: (e: object) => void }) => ({ requestAccessToken: () => respond(cfg) }),
          revoke: vi.fn(),
        },
      },
    };
  }

  it("requests the profile scope", () => {
    expect(DRIVE_SCOPES).toContain("profile");
  });

  it("fetches, caches and clears the profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ email: "a@b.c", name: "Ann", picture: "https://x/p.png" }) })));
    fakeGoogle((cfg) => cfg.callback({ access_token: "t", expires_in: 3600 }));
    const auth = new GisDriveAuth({ clientId: "cid", namespace: "site" });
    await auth.getToken({ interactive: true });
    await vi.waitFor(() => expect(auth.profile()).toEqual({ email: "a@b.c", name: "Ann", picture: "https://x/p.png" }));
    expect(auth.email()).toBe("a@b.c");
    expect(loadCachedProfile("site")?.name).toBe("Ann");
    auth.signOut();
    expect(auth.profile()).toBeNull();
    expect(store["site.driveProfile"]).toBeUndefined();
  });

  it("starts from the cached profile", () => {
    store["site.driveProfile"] = JSON.stringify({ email: "a@b.c", name: "Ann", picture: null });
    expect(new GisDriveAuth({ clientId: "cid", namespace: "site" }).profile()?.name).toBe("Ann");
  });

  it("ignores a corrupt cache", () => {
    store["site.driveProfile"] = "{nope";
    expect(new GisDriveAuth({ clientId: "cid", namespace: "site" }).profile()).toBeNull();
  });

  it("maps a silent scope failure to AuthRequiredError", async () => {
    fakeGoogle((cfg) => cfg.callback({ error: "interaction_required" }));
    await expect(new GisDriveAuth({ clientId: "cid", namespace: "site" }).getToken({ interactive: false })).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
