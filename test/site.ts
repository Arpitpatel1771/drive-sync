// Test sites: in-memory collections the engine tests run against.
//  - `testSite()`: namespace "site", documents `note`, files `photo`, settings with one device-local field.
//  - `taalmelLikeSite()`: the same shapes under Taalmel's names (kinds, folders, settings), for the migration tests.
// Stores follow the package contract: `save`/`remove`/`setBlob` are silent (the engine calls them), and the
// `user*` helpers play the user's own change, which fires `onChange`.

import {
  documents,
  files,
  resolveConfig,
  type ChangeEvent,
  type FileStore,
  type ResolvedConfig,
  type SettingsSync,
} from "../src/config";

// ------------------------------------------------------------------ stores

export interface MemStore<T extends { id: string }> extends FileStore<T> {
  items: Map<string, T>;
  blobs: Map<string, Blob>;
  /** The user saves (or edits) an item; a blob of `null` removes the media, `undefined` leaves it. Fires `onChange`. */
  userSave(item: T, blob?: Blob | null): Promise<void>;
  /** The user deletes an item. Fires `onChange`. */
  userRemove(id: string): Promise<void>;
}

export function memStore<T extends { id: string }>(): MemStore<T> {
  const items = new Map<string, T>();
  const blobs = new Map<string, Blob>();
  const listeners = new Set<(c: ChangeEvent) => void>();
  const emit = (c: ChangeEvent) => [...listeners].forEach((l) => l(c));
  const putBlob = (id: string, blob: Blob | null) => {
    if (blob) blobs.set(id, blob);
    else blobs.delete(id);
  };
  return {
    items,
    blobs,
    async list() {
      return [...items.values()].map((i) => ({ ...i }));
    },
    async get(id) {
      const i = items.get(id);
      return i ? { ...i } : undefined;
    },
    async save(id, item) {
      items.set(id, { ...item });
    },
    async remove(id) {
      items.delete(id);
      blobs.delete(id);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async getBlob(id) {
      return blobs.get(id) ?? null;
    },
    async setBlob(id, blob) {
      putBlob(id, blob);
    },
    async userSave(item, blob) {
      items.set(item.id, { ...item });
      if (blob !== undefined) putBlob(item.id, blob);
      emit({ type: "save", id: item.id });
    },
    async userRemove(id) {
      items.delete(id);
      blobs.delete(id);
      emit({ type: "delete", id });
    },
  };
}

export interface MemSettings<S extends object> extends SettingsSync<S> {
  value: S;
  /** The user changes settings. Fires `onChange`. */
  userSave(patch: Partial<S>): Promise<void>;
}

export function memSettings<S extends object>(initial: S, deviceLocal: (keyof S)[]): MemSettings<S> {
  const listeners = new Set<() => void>();
  const self: MemSettings<S> = {
    value: { ...initial },
    deviceLocal,
    async load() {
      return { ...self.value };
    },
    async save(s) {
      self.value = { ...s };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async userSave(patch) {
      self.value = { ...self.value, ...patch };
      listeners.forEach((l) => l());
    },
  };
  return self;
}

// ------------------------------------------------------------ the test site

export interface Note {
  id: string;
  text: string;
  updatedAt: number;
}
export interface Photo {
  id: string;
  name: string;
  createdAt: number;
  mimeType: string;
  /** "small" uploads skip big photos. */
  big: boolean;
  size: number;
  tags: string[];
  mediaRev?: number;
}
export interface SiteSettings {
  zoom: number;
  device: string;
}

export interface TestSite {
  config: ResolvedConfig;
  notes: MemStore<Note>;
  photos: MemStore<Photo>;
  settings: MemSettings<SiteSettings>;
}

export interface TestSiteOptions {
  namespace?: string;
  /** Default true. */
  withFiles?: boolean;
  /** Default true. */
  withSettings?: boolean;
  noteConflicts?: "ask" | "newest";
  noteRemoteDelete?: "ask" | "follow" | "ignore";
  photoRemoteDelete?: "ask" | "follow" | "ignore";
  /** Clock for `updatedAt`. Default Date.now. */
  now?: () => number;
  /** Reuse these stores (a site that is rebuilt with a different config over the same local data). */
  stores?: Partial<Pick<TestSite, "notes" | "photos" | "settings">>;
}

export const noteText = (title: string, body = "") => `${title}\n${body}`;
const firstLine = (text: string) => text.split("\n")[0] || "Untitled";

export function testSite(opts: TestSiteOptions = {}): TestSite {
  const now = opts.now ?? (() => Date.now());
  const notes = opts.stores?.notes ?? memStore<Note>();
  const photos = opts.stores?.photos ?? memStore<Photo>();
  const settings = opts.stores?.settings ?? memSettings<SiteSettings>({ zoom: 100, device: "init" }, ["device"]);

  const noteCollection = documents<Note>({
    kind: "note",
    folder: { id: "notes", name: "Notes" },
    extension: ".txt",
    mimeType: "text/plain",
    store: notes,
    idOf: (n) => n.id,
    toFile: (n) => n.text,
    fromFile: (text, id) => ({ id, text, updatedAt: now() }),
    fileName: (n) => firstLine(n.text),
    titleOf: (n) => firstLine(n.text),
    updatedAt: (n) => n.updatedAt,
    conflicts: opts.noteConflicts ?? "ask",
    remoteDelete: opts.noteRemoteDelete ?? "ask",
    onKeepBoth: (n) => ({ ...n, text: n.text.replace(/^[^\n]*/, `${firstLine(n.text)} (Drive)`) }),
    adopt: { extensions: [".txt"] },
  });

  const photoCollection = files<Photo>({
    kind: "photo",
    folder: { id: "photos", name: "Photos" },
    metaFolder: { id: "photoMeta", name: "photos" },
    store: photos,
    idOf: (p) => p.id,
    meta: (p) => ({ name: p.name, createdAt: p.createdAt, mimeType: p.mimeType, big: p.big, size: p.size, tags: p.tags, mediaRev: p.mediaRev }),
    fromMeta: (m, id) => ({
      id,
      name: String(m.name ?? "Photo"),
      createdAt: Number(m.createdAt ?? 0),
      mimeType: String(m.mimeType ?? ""),
      big: Boolean(m.big),
      size: Number(m.size ?? 0),
      tags: (m.tags as string[] | undefined) ?? [],
      mediaRev: typeof m.mediaRev === "number" ? m.mediaRev : undefined,
    }),
    fileName: (p) => `${p.name}.${p.mimeType.split("/")[1] ?? "bin"}`,
    mimeType: (p) => p.mimeType,
    titleOf: (p) => p.name,
    uploadPolicy: (p, setting) => setting === "all" || (setting === "small" && !p.big),
    uploadSettings: [
      { value: "off", label: "Off" },
      { value: "small", label: "Small photos" },
      { value: "all", label: "Everything" },
    ],
    defaultUploadSetting: "small",
    remoteDelete: opts.photoRemoteDelete ?? "ask",
    importMedia: {
      mimeTypes: ["image/*"],
      create: async (blob, name, id) => ({ id, name, createdAt: now(), mimeType: blob.type, big: false, size: blob.size, tags: [] }),
    },
  });

  const config = resolveConfig({
    google: { clientId: "c", apiKey: "k", appId: "a" },
    appName: "Site",
    namespace: opts.namespace ?? "site",
    collections: opts.withFiles === false ? [noteCollection] : [noteCollection, photoCollection],
    settings: opts.withSettings === false ? undefined : (settings as SettingsSync),
  });
  return { config, notes, photos, settings };
}

// ------------------------------------------------------------ Taalmel's names

export interface Song {
  id: string;
  text: string;
  updatedAt: number;
}
export interface Clip {
  id: string;
  name: string;
  createdAt: number;
  mimeType: string;
  hasVideo: boolean;
  durationSec: number;
  size: number;
  flags: unknown[];
  peaks: number[];
  gainDb?: number;
  boost?: boolean;
  mediaRev?: number;
  /** Taalmel's old store kept the Drive media file id on the clip itself. */
  driveFileId?: string;
}
export interface TaalmelSettings {
  zoom: number;
  calibration: unknown;
  micEnabled: boolean;
  persistBannerDismissed: boolean;
  theme: string;
}

export interface TaalmelLikeSite {
  config: ResolvedConfig;
  songs: MemStore<Song>;
  clips: MemStore<Clip>;
  settings: MemSettings<TaalmelSettings>;
}

const titleHeader = (text: string) => {
  const m = /^title:[ \t]*(.*)$/m.exec(text);
  return m && m[1].trim() ? m[1].trim() : "Untitled";
};
const MEDIA_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

/** Taalmel's collections as the package describes them: songs, clips (recordings) and settings, with Taalmel's folder ids and meta fields. */
export function taalmelLikeSite(opts: { now?: () => number } = {}): TaalmelLikeSite {
  const now = opts.now ?? (() => Date.now());
  const songs = memStore<Song>();
  const clips = memStore<Clip>();
  const settings = memSettings<TaalmelSettings>(
    { zoom: 100, calibration: null, micEnabled: true, persistBannerDismissed: false, theme: "dark" },
    ["calibration", "micEnabled", "persistBannerDismissed", "theme"]
  );

  const song = documents<Song>({
    kind: "song",
    folder: { id: "songs", name: "Songs" },
    extension: ".txt",
    mimeType: "text/plain",
    store: songs,
    idOf: (s) => s.id,
    toFile: (s) => s.text,
    fromFile: (text, id) => ({ id, text, updatedAt: now() }),
    fileName: (s) => titleHeader(s.text),
    titleOf: (s) => titleHeader(s.text),
    updatedAt: (s) => s.updatedAt,
    onKeepBoth: (s) => {
      const header = `title: ${titleHeader(s.text)} (Drive)`;
      return { ...s, text: /^title:.*$/m.test(s.text) ? s.text.replace(/^title:.*$/m, header) : `${header}\n${s.text}` };
    },
    adopt: { extensions: [".txt"] },
  });

  const clip = files<Clip>({
    kind: "clip",
    folder: { id: "recordings", name: "Recordings" },
    metaFolder: { id: "clips", name: "clips" },
    store: clips,
    idOf: (c) => c.id,
    meta: (c) => ({
      name: c.name,
      createdAt: c.createdAt,
      mimeType: c.mimeType,
      hasVideo: c.hasVideo,
      durationSec: c.durationSec,
      size: c.size,
      flags: c.flags ?? [],
      peaks: c.peaks ?? [],
      gainDb: c.gainDb,
      boost: c.boost,
      mediaRev: c.mediaRev,
    }),
    fromMeta: (j, id, existing) => ({
      id,
      // fields the sidecar doesn't carry stay as they are on this device
      driveFileId: existing?.driveFileId,
      name: String(j.name ?? "Recording"),
      createdAt: Number(j.createdAt ?? now()),
      mimeType: String(j.mimeType ?? ""),
      hasVideo: Boolean(j.hasVideo),
      durationSec: Number(j.durationSec ?? 0),
      size: Number(j.size ?? 0),
      flags: (j.flags as unknown[] | undefined) ?? [],
      peaks: (j.peaks as number[] | undefined) ?? [],
      gainDb: typeof j.gainDb === "number" ? j.gainDb : undefined,
      boost: typeof j.boost === "boolean" ? j.boost : undefined,
      mediaRev: typeof j.mediaRev === "number" ? j.mediaRev : undefined,
    }),
    legacyMediaFileId: (c) => c.driveFileId,
    fileName: (c) => {
      const base = c.mimeType.split(";")[0].trim().toLowerCase();
      return `${c.name}.${MEDIA_EXT[base] ?? (base.split("/")[1] || "bin")}`;
    },
    mimeType: (c) => c.mimeType,
    titleOf: (c) => c.name,
    uploadPolicy: (c, setting) => setting === "all" || (setting === "audio" && !c.hasVideo),
    uploadSettings: [
      { value: "off", label: "Off" },
      { value: "audio", label: "Audio only" },
      { value: "all", label: "Everything" },
    ],
    defaultUploadSetting: "audio",
    importMedia: {
      mimeTypes: ["audio/*", "video/*"],
      create: async (blob, name, id) => ({
        id,
        name,
        createdAt: now(),
        mimeType: blob.type,
        hasVideo: blob.type.startsWith("video/"),
        durationSec: 0,
        size: blob.size,
        flags: [],
        peaks: [],
      }),
    },
  });

  const config = resolveConfig({
    google: { clientId: "c", apiKey: "k", appId: "a" },
    appName: "Taalmel",
    namespace: "taalmel",
    hiddenFolder: ".taalmel",
    collections: [song, clip],
    settings: settings as SettingsSync,
  });
  return { config, songs, clips, settings };
}
