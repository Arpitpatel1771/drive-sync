import { describe, expect, it } from "vitest";
import { documents, files, isConfigured, resolveConfig, type DriveSyncConfig } from "../src/config";
import { props } from "../src/props";

const docStore = {
  list: async () => [],
  get: async () => undefined,
  save: async () => {},
  remove: async () => {},
  onChange: () => () => {},
};
const fileStore = { ...docStore, getBlob: async () => null, setBlob: async () => {} };

type Doc = { id: string; text: string };
const doc = (kind: string, folderId = kind) =>
  documents<Doc>({
    kind,
    folder: { id: folderId, name: folderId },
    extension: ".txt",
    mimeType: "text/plain",
    store: docStore,
    idOf: (d) => d.id,
    toFile: (d) => d.text,
    fromFile: (text, id) => ({ id, text }),
    fileName: (d) => d.id,
    titleOf: (d) => d.id,
    updatedAt: () => 0,
  });
const fileCol = (kind: string, folderId = kind, metaId = `${kind}-meta`) =>
  files<Doc>({
    kind,
    folder: { id: folderId, name: folderId },
    metaFolder: { id: metaId, name: metaId },
    store: fileStore,
    idOf: (d) => d.id,
    meta: () => ({}),
    fromMeta: (_m, id) => ({ id, text: "" }),
    fileName: (d) => d.id,
    mimeType: () => "audio/webm",
    titleOf: (d) => d.id,
    uploadPolicy: () => true,
    uploadSettings: [{ value: "off", label: "Off" }],
    defaultUploadSetting: "off",
  });

const cfg = (collections: DriveSyncConfig["collections"], google = { clientId: "c", apiKey: "k", appId: "a" }): DriveSyncConfig => ({
  google,
  appName: "App",
  namespace: "taalmel",
  collections,
});

describe("resolveConfig", () => {
  it("rejects duplicate kinds", () => {
    expect(() => resolveConfig(cfg([doc("a"), doc("a", "other")]))).toThrow(/duplicate kind "a"/);
  });
  it("rejects reserved kinds", () => {
    expect(() => resolveConfig(cfg([doc("settings")]))).toThrow(/kind "settings" is reserved/);
    expect(() => resolveConfig(cfg([doc("folder")]))).toThrow(/kind "folder" is reserved/);
  });
  it("rejects a kind equal to a files collection's sidecar kind", () => {
    expect(() => resolveConfig(cfg([fileCol("clip"), doc("clipMeta")]))).toThrow(/kind "clipMeta" is reserved/);
  });
  it("rejects kinds containing a colon", () => {
    expect(() => resolveConfig(cfg([doc("a:b")]))).toThrow(/kind "a:b" must not contain ":"/);
  });
  it("rejects a folder id used twice, including meta, root and hidden", () => {
    expect(() => resolveConfig(cfg([doc("a", "x"), doc("b", "x")]))).toThrow(/folder id "x" is used twice/);
    expect(() => resolveConfig(cfg([fileCol("c", "c", "c")]))).toThrow(/folder id "c" is used twice/);
    expect(() => resolveConfig(cfg([doc("a", "root")]))).toThrow(/folder id "root" is used twice/);
    expect(() => resolveConfig(cfg([doc("a", "hidden")]))).toThrow(/folder id "hidden" is used twice/);
  });
  it("checks in order: duplicate kind before reserved", () => {
    expect(() => resolveConfig(cfg([doc("settings"), doc("settings")]))).toThrow(/duplicate kind/);
  });
  it("defaults hiddenFolder and builds lookups in declaration order", () => {
    const a = doc("a");
    const b = fileCol("b");
    const r = resolveConfig(cfg([a, b]));
    expect(r.hiddenFolder).toBe(".taalmel");
    expect(r.documents).toEqual([a]);
    expect(r.files).toEqual([b]);
    expect(r.byKind.get("b")).toBe(b);
    expect(resolveConfig({ ...cfg([]), hiddenFolder: ".x" }).hiddenFolder).toBe(".x");
  });
  it("does not throw on missing Google IDs", () => {
    expect(() => resolveConfig(cfg([], { clientId: "", apiKey: "", appId: "" }))).not.toThrow();
  });
});

describe("isConfigured", () => {
  it("is true only when all three ids are non-empty", () => {
    expect(isConfigured(cfg([]))).toBe(true);
    expect(isConfigured(cfg([], { clientId: "", apiKey: "k", appId: "a" }))).toBe(false);
    expect(isConfigured(cfg([], { clientId: "c", apiKey: "", appId: "a" }))).toBe(false);
    expect(isConfigured(cfg([], { clientId: "c", apiKey: "k", appId: "" }))).toBe(false);
  });
});

describe("collections", () => {
  it("tag type and fill defaults", () => {
    const d = doc("a");
    expect(d.type).toBe("documents");
    expect(d.conflicts).toBe("ask");
    expect(d.remoteDelete).toBe("ask");
    const f = fileCol("b");
    expect(f.type).toBe("files");
    expect(f.remoteDelete).toBe("ask");
  });
  it("keep explicit options", () => {
    const d = documents<Doc>({ ...doc("a"), conflicts: "newest", remoteDelete: "follow" });
    expect(d.conflicts).toBe("newest");
    expect(d.remoteDelete).toBe("follow");
  });
});

describe("props", () => {
  const p = props("taalmel");
  it("builds keys and tags", () => {
    expect(p.kindKey).toBe("taalmelKind");
    expect(p.idKey).toBe("taalmelId");
    expect(p.tag("song", "1")).toEqual({ taalmelKind: "song", taalmelId: "1" });
  });
  it("reads from a file", () => {
    expect(p.read({ appProperties: { taalmelKind: "song", taalmelId: "1" } })).toEqual({ kind: "song", id: "1" });
    expect(p.read({})).toEqual({});
    expect(p.read({ appProperties: { otherKind: "x" } })).toEqual({});
  });
});

describe("resolveConfig names", () => {
  it("rejects an empty, blank or odd namespace", () => {
    for (const ns of ["", "  ", "a b", "a.b", "a/b", "ünï"]) {
      expect(() => resolveConfig({ ...cfg([doc("a")]), namespace: ns })).toThrow(/namespace/);
    }
    expect(() => resolveConfig({ ...cfg([doc("a")]), namespace: "my-site_2" })).not.toThrow();
  });
  it("rejects an empty kind", () => {
    expect(() => resolveConfig(cfg([doc("")]))).toThrow(/empty kind/);
    expect(() => resolveConfig(cfg([doc("  ")]))).toThrow(/empty kind/);
  });
});
