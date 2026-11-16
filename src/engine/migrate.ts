// Reading state that an older version of a site (Taalmel) stored, so users keep their data across the switch to this package.

import type { FileCollection } from "../config";
import type { SyncStore } from "../store/syncStore";
import type { Conflict } from "./types";

const LEGACY_UPLOAD_SETTING = "uploadSetting";
export const uploadSettingKey = (kind: string) => `uploadSetting:${kind}`;
export const legacyMediaFlag = (kind: string) => `migrated:legacyMedia:${kind}`;

/** Conflicts as stored: an entry from before collections had kinds has `songId` and no `kind`; it belongs to the first documents collection. */
export function readConflicts(stored: unknown, firstDocumentsKind: string | undefined): Conflict[] {
  if (!Array.isArray(stored)) return [];
  const out: Conflict[] = [];
  for (const raw of stored as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.kind === "string" && typeof raw.id === "string") {
      out.push(raw as unknown as Conflict);
    } else if (typeof raw.songId === "string" && firstDocumentsKind !== undefined) {
      const { songId, ...rest } = raw;
      out.push({ ...rest, kind: firstDocumentsKind, id: songId } as unknown as Conflict);
    }
  }
  return out;
}

/** Loads the stored conflicts and writes them back when they had to be converted. Entries that can't be placed stay in meta untouched (just not shown). */
export async function loadConflicts(store: SyncStore, firstDocumentsKind: string | undefined): Promise<Conflict[]> {
  const stored = await store.getMeta<unknown>("conflicts");
  const list = readConflicts(stored, firstDocumentsKind);
  if (!Array.isArray(stored)) return list;
  const unplaced = (stored as Record<string, unknown>[]).filter((raw) => raw && typeof raw === "object" && !(typeof raw.kind === "string" && typeof raw.id === "string") && firstDocumentsKind === undefined);
  const next = [...list, ...unplaced];
  if (JSON.stringify(stored) !== JSON.stringify(next)) await store.setMeta("conflicts", next);
  return list;
}

/**
 * The stored upload setting of a files collection. The first files collection falls back to the legacy
 * single `uploadSetting` key and copies it to its own key, so the user's choice is remembered. The legacy key stays.
 */
export async function readUploadSetting(
  store: SyncStore,
  kind: string,
  fileCollections: readonly { kind: string }[]
): Promise<string | undefined> {
  const own = await store.getMeta<string>(uploadSettingKey(kind));
  if (own !== undefined) return own;
  if (fileCollections[0]?.kind !== kind) return undefined;
  const legacy = await store.getMeta<string>(LEGACY_UPLOAD_SETTING);
  if (typeof legacy !== "string") return undefined;
  await store.setMeta(uploadSettingKey(kind), legacy);
  return legacy;
}

/**
 * One time per collection with a `legacyMediaFileId` hook: copies the media file id the site kept on the item into the
 * sync record (a stub record when the item has none yet), unless the record already knows its media.
 */
export async function migrateLegacyMedia(store: SyncStore, fileCollections: readonly FileCollection[]): Promise<void> {
  for (const col of fileCollections) {
    if (!col.legacyMediaFileId || (await store.getMeta(legacyMediaFlag(col.kind)))) continue;
    for (const item of await col.store.list()) {
      const mediaFileId = col.legacyMediaFileId(item);
      if (!mediaFileId) continue;
      const id = col.idOf(item);
      const sync = await store.getItem(col.kind, id);
      if (sync?.mediaFileId) continue;
      const rev = Number(col.meta(item).mediaRev);
      const mediaRev = col.meta(item).mediaRev !== undefined && Number.isFinite(rev) ? rev : undefined;
      await store.putItem({
        ...(sync ?? { kind: col.kind, id, driveFileId: "", lastSyncedHash: "", lastRemoteVersion: "" }),
        mediaFileId,
        ...(mediaRev !== undefined ? { mediaRev } : {}),
      });
    }
    await store.setMeta(legacyMediaFlag(col.kind), true);
  }
}
