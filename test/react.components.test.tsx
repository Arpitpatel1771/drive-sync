import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { DriveSync } from "../src/createDriveSync";
import type { Conflict, SyncStatus } from "../src/engine/types";
import {
  DriveAccountChip,
  DriveConflictDialog,
  DriveDeleteConfirm,
  DriveItemBadge,
  DriveSettingsPanel,
  DriveStatusChip,
  DriveSyncProvider,
} from "../src/react";
import { importMessage } from "../src/react/components/shared";

const conflict: Conflict = {
  kind: "note",
  id: "n1",
  localTitle: "Local title",
  remoteTitle: "Drive title",
  localText: "local body",
  remoteText: "remote body",
  localUpdatedAt: 1000,
  remoteUpdatedAt: 2000,
  driveFileId: "f1",
  remoteVersion: "2",
};
const idle: SyncStatus = { state: "idle", email: "a@b.c", name: "Ann Lee", picture: null, lastSyncAt: null, conflicts: [], pendingRemoteDeletes: [], uploads: {}, error: null };
const disconnected: SyncStatus = { ...idle, state: "disconnected", email: null, name: null };

function fake(status: SyncStatus, configured = true): DriveSync {
  return {
    configured,
    status,
    conflicts: status.conflicts,
    pendingDeletes: status.pendingRemoteDeletes,
    collections: [
      { kind: "note", label: { one: "note", other: "notes" }, type: "documents", uploadSettings: [], defaultUploadSetting: "" },
      { kind: "photo", label: { one: "picture", other: "pictures" }, type: "files", uploadSettings: [{ value: "off", label: "Off" }, { value: "all", label: "Everything" }], defaultUploadSetting: "off" },
    ],
    start: async () => {},
    stop: () => {},
    subscribe: () => () => {},
    itemStatus: () => "inDrive",
    uploadSetting: () => "all",
  } as unknown as DriveSync;
}

const wrap = (drive: DriveSync, node: ReactNode) => renderToStaticMarkup(<DriveSyncProvider drive={drive}>{node}</DriveSyncProvider>);

describe("components render on a server (no window.google)", () => {
  it("has no window", () => {
    expect(typeof window).toBe("undefined");
  });

  const all = (c?: string) => (
    <>
      <DriveAccountChip className={c} />
      <DriveStatusChip className={c} />
      <DriveConflictDialog className={c} />
      <DriveDeleteConfirm className={c} />
      <DriveSettingsPanel className={c} />
      <DriveItemBadge kind="photo" id="p1" className={c} />
    </>
  );

  it("renders unconfigured, with and without a provider", () => {
    expect(() => renderToStaticMarkup(all())).not.toThrow();
    expect(() => wrap(fake(disconnected, false), all())).not.toThrow();
    const un = fake(disconnected, false);
    for (const n of [<DriveAccountChip />, <DriveStatusChip />, <DriveConflictDialog open />, <DriveDeleteConfirm />, <DriveItemBadge kind="photo" id="p" />]) {
      expect(wrap(un, n)).toBe("");
    }
    expect(wrap(fake(disconnected, false), <DriveSettingsPanel />)).toContain("not configured");
  });

  it("renders connected idle", () => {
    const html = wrap(fake(idle), all("mine"));
    expect(html).toContain("Synced");
    expect(html).toContain("In Drive");
    expect(html).toContain("Ann Lee");
  });
});

describe("DriveStatusChip", () => {
  it("shows the exact texts", () => {
    expect(wrap(fake({ ...idle, state: "authRequired" }), <DriveStatusChip />)).toContain("Drive: sign in to resume");
    expect(wrap(fake({ ...idle, state: "syncing" }), <DriveStatusChip />)).toContain("Syncing…");
    expect(wrap(fake({ ...idle, state: "offline" }), <DriveStatusChip />)).toContain("Offline — saved locally");
    expect(wrap(fake({ ...idle, state: "driveFull" }), <DriveStatusChip />)).toContain("Drive full — uploads paused");
    expect(wrap(fake({ ...idle, conflicts: [conflict] }), <DriveStatusChip />)).toContain("1 conflict");
  });
  it("renders nothing when disconnected", () => {
    expect(wrap(fake(disconnected), <DriveStatusChip />)).toBe("");
  });
  it("puts className on the root element", () => {
    expect(wrap(fake(idle), <DriveStatusChip className="mine" />)).toMatch(/^<span class="[^"]*\bmine\b/);
  });
});

describe("className lands on each root", () => {
  const cases: [string, ReactNode][] = [
    ["account chip", <DriveAccountChip className="mine" />],
    ["settings panel", <DriveSettingsPanel className="mine" />],
    ["item badge", <DriveItemBadge kind="photo" id="p" className="mine" />],
  ];
  for (const [name, node] of cases) {
    it(name, () => expect(wrap(fake(idle), node)).toMatch(/^<[a-z]+ class="[^"]*\bmine\b/));
  }
  it("conflict dialog and delete confirm", () => {
    expect(wrap(fake({ ...idle, conflicts: [conflict] }), <DriveConflictDialog open className="mine" />)).toMatch(/^<div class="[^"]*\bmine\b/);
    const del = { ...idle, pendingRemoteDeletes: [{ kind: "note", id: "n1", title: "Gone" }] };
    expect(wrap(fake(del), <DriveDeleteConfirm className="mine" />)).toMatch(/^<div class="[^"]*\bmine\b/);
  });
});

describe("sign-in button", () => {
  it("takes className and subtitle", () => {
    const html = wrap(fake(disconnected), <DriveAccountChip className="mine" subtitle="Back up & sync your library" />);
    expect(html).toMatch(/^<button[^>]*class="[^"]*\bmine\b/);
    expect(html).toContain("Back up &amp; sync your library");
  });
});

describe("conflict dialog yields to the delete question", () => {
  it("renders nothing while remote deletes are pending", () => {
    const st = { ...idle, conflicts: [conflict], pendingRemoteDeletes: [{ kind: "note", id: "n1", title: "Gone" }] };
    expect(wrap(fake(st), <DriveConflictDialog open />)).toBe("");
    expect(wrap(fake(st), <DriveDeleteConfirm />)).toContain("deleted in Drive");
  });
});

describe("DriveItemBadge", () => {
  it("shows the status text", () => {
    expect(wrap(fake(idle), <DriveItemBadge kind="photo" id="p" />)).toContain("In Drive");
  });
});

describe("DriveSettingsPanel", () => {
  it("has the upload setting control for files collections only", () => {
    const html = wrap(fake(idle), <DriveSettingsPanel />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Upload pictures to Drive");
    expect(html).not.toContain("Upload notes");
    expect(html).toContain("Everything");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Import from Drive");
  });
  it("offers sign in when disconnected", () => {
    expect(wrap(fake(disconnected), <DriveSettingsPanel />)).toContain("Sign in with Google");
  });
});

describe("DriveAccountChip", () => {
  it("shows sign in when disconnected, avatar when connected", () => {
    expect(wrap(fake(disconnected), <DriveAccountChip />)).toContain("Sign in with Google");
    const html = wrap(fake(idle), <DriveAccountChip />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("AL");
    expect(html).not.toContain('role="menu"'); // closed on first render
  });
  it("renderMenu replaces the built-in menu and receives the package items", () => {
    let seen: { open: boolean; title: string } | null = null;
    const html = wrap(
      fake({ ...idle, conflicts: [conflict] }),
      <DriveAccountChip
        renderMenu={({ open, title, children }) => {
          seen = { open, title };
          return <aside id="custom">{children}</aside>;
        }}
      />,
    );
    expect(seen).toEqual({ open: false, title: "Account: Ann Lee" });
    expect(html).toContain('<aside id="custom">');
    expect(html).toContain("Sync now");
    expect(html).toContain("Resolve 1 conflict");
    expect(html).toContain("Import from Drive");
    expect(html).toContain("Sign out");
    expect(html).not.toContain('role="menu"');
  });
});

describe("DriveConflictDialog", () => {
  const status = { ...idle, conflicts: [conflict] };
  it("shows both titles and the three buttons", () => {
    const html = wrap(fake(status), <DriveConflictDialog open />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("This device: Local title");
    expect(html).toContain("Drive: Drive title");
    expect(html).toContain("Keep this device&#x27;s");
    expect(html).toContain("Keep Drive&#x27;s");
    expect(html).toContain("Keep both");
  });
  it("is closed by default and when there are no conflicts", () => {
    expect(wrap(fake(status), <DriveConflictDialog />)).toBe("");
    expect(wrap(fake(idle), <DriveConflictDialog open />)).toBe("");
  });
  it("renderVersion and renderDialog take over", () => {
    const html = wrap(
      fake(status),
      <DriveConflictDialog
        open
        renderVersion={(c, side) => <em>{side}:{c.id}</em>}
        renderDialog={({ title, children }) => <section data-title={title}>{children}</section>}
      />,
    );
    expect(html).toContain("<em>local:n1</em>");
    expect(html).toContain("<em>remote:n1</em>");
    expect(html).toContain("<section data-title=");
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Keep both");
  });
});

describe("DriveDeleteConfirm", () => {
  it("asks the batched question", () => {
    const del = { ...idle, pendingRemoteDeletes: [{ kind: "note", id: "n1", title: "Gone" }, { kind: "photo", id: "p1", title: "Pic" }] };
    const html = wrap(fake(del), <DriveDeleteConfirm />);
    expect(html).toContain("2 items were deleted in Drive");
    expect(html).toContain("Gone");
    expect(html).toContain("Keep (re-upload)");
    expect(html).toContain("Delete here");
    expect(wrap(fake(idle), <DriveDeleteConfirm />)).toBe("");
  });
});

describe("collection labels", () => {
  it("the delete list names kinds by their label", () => {
    const del = { ...idle, pendingRemoteDeletes: [{ kind: "photo", id: "p1", title: "Pic" }] };
    const html = wrap(fake(del), <DriveDeleteConfirm />);
    expect(html).toContain("(picture)");
    expect(html).not.toContain("(photo)");
  });
  it("the upload heading uses the plural label by default", () => {
    expect(wrap(fake(idle), <DriveSettingsPanel />)).toContain("Upload pictures to Drive");
  });
  it("importMessage uses labels, falling back to the kind", () => {
    const labels = [{ kind: "song", label: { one: "tune" } }];
    expect(importMessage({ song: 2, clip: 3 }, labels)).toBe("Imported 2 tune(s) and 3 clip(s).");
  });
});

describe("DriveAccountChip icons", () => {
  const icons = {
    resume: <i id="i-resume" />,
    conflicts: <i id="i-conflicts" />,
    sync: <i id="i-sync" />,
    upload: <i id="i-upload" />,
    import: <i id="i-import" />,
    settings: <i id="i-settings" />,
    disconnect: <i id="i-disconnect" />,
  };
  const menu = ({ children }: { children: ReactNode }) => <aside>{children}</aside>;
  it("renders each icon before its item label", () => {
    const html = wrap(fake({ ...idle, state: "authRequired", conflicts: [conflict] }), <DriveAccountChip icons={icons} onOpenSettings={() => {}} renderMenu={menu} />);
    for (const id of Object.keys(icons)) expect(html).toContain(`<i id="i-${id}"></i>`);
    expect(html).toContain('<i id="i-sync"></i>Sync now');
    expect(html).toContain('<i id="i-disconnect"></i>Sign out');
    expect(html).toContain('<i id="i-upload"></i>Upload pictures to Drive');
  });
  it("connect replaces the Google G on the sign-in button", () => {
    const html = wrap(fake(disconnected), <DriveAccountChip icons={{ connect: <i id="i-connect" /> }} />);
    expect(html).toContain('<i id="i-connect"></i>');
    expect(html).not.toContain("ds-g");
  });
  it("no icons by default", () => {
    expect(wrap(fake(idle), <DriveAccountChip renderMenu={menu} />)).not.toContain("<i ");
  });
});

describe("importMessage", () => {
  it("lists per-kind counts", () => {
    expect(importMessage({ song: 2, clip: 3 })).toBe("Imported 2 song(s) and 3 clip(s).");
    expect(importMessage({})).toBe("Nothing to import.");
  });
});

describe("styles.css", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  it("references all nine theme variables and declares none", () => {
    for (const v of ["accent", "surface", "surface-2", "text", "text-muted", "border", "danger", "radius", "font"]) {
      expect(css).toContain(`var(--drive-${v}, `);
    }
    expect(css).not.toMatch(/--drive-[a-z0-9-]+\s*:/);
    expect(css).not.toMatch(/rgba?\(/);
  });
  it("prefixes every class with ds-", () => {
    const classes = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]);
    expect(classes.filter((c) => !c.startsWith("ds-"))).toEqual([]);
  });
});
