// Handler for a files collection: a sidecar JSON per item (always synced) plus the media file (uploaded per
// the upload setting, or on request). Includes the resumable media upload.

import { DriveError, listAllFiles, type DriveFile } from "../drive/api";
import type { FileCollection } from "../config";
import type { QueueItem, SyncItem } from "../store/syncStore";
import { adoptFile } from "./folders";
import type { Handler, HandlerContext, ItemStatus, LocalDoc, RemoteDoc } from "./types";
import { classify, sanitizeName, sha256, stable } from "./util";

/** What a files handler needs from the engine besides the shared context. */
export interface FilesEnv {
  chunkSize: number;
  /** The upload setting currently chosen for the collection. */
  setting(kind: string): string;
  /** Reports upload progress (0..1) for `kind:id`; `null` clears it. */
  progress(key: string, fraction: number | null): void;
  /** Pushes the item's sidecar now (creating it when it isn't in Drive yet). */
  pushUpsert(kind: string, id: string): Promise<void>;
  enqueue(op: "upsert" | "uploadMedia", kind: string, id: string): Promise<void>;
}

export const updatedAtKey = (kind: string, id: string) => `${kind}UpdatedAt:${id}`;

function mimeMatches(pattern: string, mime: string): boolean {
  return pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern;
}

export class FilesHandler implements Handler {
  readonly kind: string;
  readonly driveKind: string;
  readonly bodyMime = "application/json";
  readonly conflicts = "newest" as const;
  readonly remoteDelete: "ask" | "follow" | "ignore";

  constructor(
    readonly col: FileCollection,
    private readonly ctx: HandlerContext,
    private readonly env: FilesEnv
  ) {
    this.kind = col.kind;
    this.driveKind = `${col.kind}Meta`;
    this.remoteDelete = col.remoteDelete;
  }

  // ---------------------------------------------------------------- sidecar

  /** The sidecar content: the site's `meta(item)` without the reserved `updatedAt` key. */
  private content(item: unknown): Record<string, unknown> {
    const { updatedAt: _reserved, ...rest } = this.col.meta(item);
    return rest;
  }

  /** `mediaRev` of the item (absent = 0): how the engine notices that the media was replaced. */
  private mediaRev(item: unknown): number {
    const n = Number(this.col.meta(item).mediaRev ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  async listIds(): Promise<string[]> {
    return (await this.col.store.list()).map((i) => this.col.idOf(i));
  }

  async readLocal(id: string): Promise<LocalDoc | null> {
    const item = await this.col.store.get(id);
    if (!item) return null;
    const content = this.content(item);
    const updatedAt = (await this.ctx.store.getMeta<number>(updatedAtKey(this.kind, id))) ?? 0;
    const fallback = typeof content.createdAt === "number" ? content.createdAt : 0;
    return {
      body: JSON.stringify({ updatedAt: updatedAt || fallback, ...content }),
      hash: await sha256(stable(content)),
      updatedAt,
      title: this.col.titleOf(item),
      item,
    };
  }

  async readRemote(id: string, file: DriveFile): Promise<RemoteDoc | null> {
    const text = await (await this.ctx.api.downloadMedia(file.id)).text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const updatedAt = typeof json.updatedAt === "number" ? json.updatedAt : 0;
    let hash: string;
    try {
      // Hash what the site would store, so a sidecar from an older version compares equal to the local copy.
      hash = await sha256(stable(this.content(this.col.fromMeta(this.metaOf(json), id))));
    } catch {
      return null;
    }
    return { text, json, hash, updatedAt };
  }

  private metaOf(json: Record<string, unknown>): Record<string, unknown> {
    const { updatedAt: _u, ...meta } = json;
    return meta;
  }

  async applyRemote(id: string, remote: RemoteDoc): Promise<{ hash: string; mediaFileId?: string }> {
    const existing = await this.col.store.get(id);
    const meta = this.metaOf(remote.json!);
    // Another device replaced the media: our copy is stale, so drop it (it can be downloaded again).
    if (existing) {
      const sync = await this.ctx.store.getItem(this.kind, id);
      if (sync?.mediaFileId && Number(meta.mediaRev ?? 0) > this.mediaRev(existing) && (await this.col.store.getBlob(id))) {
        await this.col.store.setBlob(id, null);
      }
    }
    const item = this.col.fromMeta(meta, id, existing && ((await this.col.store.get(id)) ?? existing));
    await this.col.store.save(id, item);
    await this.ctx.store.setMeta(updatedAtKey(this.kind, id), remote.updatedAt);
    const mediaFileId = existing ? undefined : (await this.findMedia(id))?.id;
    return { hash: await sha256(stable(this.content(item))), mediaFileId };
  }

  async findMedia(id: string): Promise<DriveFile | undefined> {
    return (await listAllFiles(this.ctx.api, { appProperties: this.ctx.props.tag(this.kind, id) }))[0];
  }

  async createSpec(id: string) {
    return { name: `${id}.json`, parent: this.ctx.folder(this.col.metaFolder.id), mimeType: this.bodyMime };
  }

  /** The media file follows the item's name (and extension). */
  async afterUpdate(id: string, item: SyncItem, _local: LocalDoc, file: DriveFile): Promise<DriveFile> {
    if (item.mediaFileId) {
      const current = await this.col.store.get(id);
      if (current) await this.ctx.api.updateMetadata(item.mediaFileId, { name: this.mediaName(current) });
    }
    return file;
  }

  async localTitle(id: string): Promise<string | undefined> {
    const item = await this.col.store.get(id);
    return item === undefined ? undefined : this.col.titleOf(item);
  }

  remoteTitle(id: string, remote: RemoteDoc): string {
    try {
      return this.col.titleOf(this.col.fromMeta(this.metaOf(remote.json ?? {}), id));
    } catch {
      return id;
    }
  }

  async deleteLocal(id: string): Promise<void> {
    await this.col.store.remove(id);
    await this.ctx.store.deleteMeta(updatedAtKey(this.kind, id));
  }

  private mediaName(item: unknown): string {
    return sanitizeName(this.col.fileName(item));
  }

  // ------------------------------------------------------------------ media

  private eligible(item: unknown, hasBlob: boolean): boolean {
    return hasBlob && this.col.uploadPolicy(item, this.env.setting(this.kind));
  }

  /** True when the item's media should be (re)uploaded: eligible, and not in Drive yet or replaced since. */
  async wantsMediaUpload(id: string): Promise<boolean> {
    const item = await this.col.store.get(id);
    if (!item || !this.eligible(item, !!(await this.col.store.getBlob(id)))) return false;
    const sync = await this.ctx.store.getItem(this.kind, id);
    if (!sync?.mediaFileId) return true;
    return this.mediaRev(item) > (sync.mediaRev ?? 0);
  }

  /** Links a media file found in Drive to its item. When the item has no sync record yet, keeps the link for when it does. */
  async attachMedia(id: string, file: DriveFile): Promise<void> {
    const sync = await this.ctx.store.getItem(this.kind, id);
    if (sync) {
      if (sync.mediaFileId !== file.id) await this.ctx.store.putItem({ ...sync, mediaFileId: file.id });
    } else if (await this.col.store.get(id)) {
      await this.ctx.store.putItem({ kind: this.kind, id, driveFileId: "", lastSyncedHash: "", lastRemoteVersion: "", mediaFileId: file.id });
    }
  }

  /** What the badge shows for the item; undefined when there is no such item. `uploading` is added by the engine. */
  async status(id: string): Promise<ItemStatus | undefined> {
    const item = await this.col.store.get(id);
    if (!item) return undefined;
    const hasBlob = !!(await this.col.store.getBlob(id));
    const inDrive = !!(await this.ctx.store.getItem(this.kind, id))?.mediaFileId;
    if (inDrive) return hasBlob ? "inDrive" : "notDownloaded";
    return hasBlob ? "local" : "otherDevice";
  }

  /** Downloads the media from Drive, stores it locally (silently) and returns it. */
  async download(id: string, onProgress?: (fraction: number) => void): Promise<Blob> {
    const item = await this.col.store.get(id);
    if (!item) throw new Error(`Item ${id} was not found.`);
    const have = await this.col.store.getBlob(id);
    if (have) return have;
    const sync = await this.ctx.store.getItem(this.kind, id);
    if (!sync?.mediaFileId) throw new Error("This item is not in Drive.");
    const size = Number(this.col.meta(item).size);
    const blob = await this.ctx.api.downloadMedia(sync.mediaFileId, onProgress, Number.isFinite(size) ? size : undefined);
    await this.col.store.setBlob(id, blob);
    // What we just downloaded is the current revision: it must not be uploaded again.
    await this.ctx.store.putItem({ ...sync, mediaRev: this.mediaRev(item) });
    return blob;
  }

  /** Frees the local copy of an item that is in Drive. */
  async removeLocal(id: string): Promise<void> {
    if (!(await this.col.store.get(id))) return;
    const sync = await this.ctx.store.getItem(this.kind, id);
    if (!sync?.mediaFileId) throw new Error("This item is not in Drive; removing it would lose it.");
    await this.col.store.setBlob(id, null);
  }

  async uploadMedia(q: QueueItem): Promise<void> {
    const { col, ctx, env } = this;
    const item = await col.store.get(q.id);
    const blob = await col.store.getBlob(q.id);
    if (!item || !blob) return;
    let sync = await ctx.store.getItem(this.kind, q.id);
    if (!sync?.driveFileId) {
      await env.pushUpsert(this.kind, q.id);
      sync = await ctx.store.getItem(this.kind, q.id);
      if (!sync?.driveFileId) return;
    }
    const rev = this.mediaRev(item);
    // The media was replaced locally (e.g. made louder): overwrite the existing Drive file, keeping its id.
    const replaceId = sync.mediaFileId && rev > (sync.mediaRev ?? 0) ? sync.mediaFileId : undefined;
    if (sync.mediaFileId && !replaceId) return;
    const total = blob.size;
    const meta = {
      name: this.mediaName(item),
      mimeType: col.mimeType(item) || blob.type || "application/octet-stream",
      parents: [ctx.folder(col.folder.id)],
      appProperties: ctx.props.tag(this.kind, q.id),
    };
    const key = `${this.kind}:${q.id}`;
    env.progress(key, 0);
    try {
      let file: DriveFile | undefined;
      if (total === 0) file = replaceId ? await ctx.api.updateMedia(replaceId, blob) : await ctx.api.createFile(meta, blob);
      else {
        let url = q.resumableUrl;
        for (let attempt = 0; attempt < 2 && !file; attempt++) {
          try {
            let offset = 0;
            if (url) {
              const st = await ctx.api.queryUploadStatus(url, total);
              if (st.done) {
                file = st.file;
                break;
              }
              offset = st.received;
            } else {
              url = await ctx.api.startResumableUpload(meta, total, replaceId);
              await ctx.store.updateQueueItem(q.key, { resumableUrl: url });
            }
            while (offset < total) {
              const end = Math.min(offset + env.chunkSize, total);
              const p = await ctx.api.uploadChunk(url, blob.slice(offset, end), offset, total);
              if (p.done) {
                file = p.file;
                break;
              }
              offset = p.received;
              env.progress(key, offset / total);
            }
          } catch (e) {
            // The session expired (404), or Drive rejected the session itself (e.g. one an older version
            // started with metadata Drive won't accept on an update, 400/403 fieldNotWritable): resuming it
            // fails forever, so start over with a new session. Auth, rate and quota errors are handled above.
            const c = classify(e);
            if (e instanceof DriveError && (c === "notFound" || c === "other") && url) {
              url = undefined;
              await ctx.store.updateQueueItem(q.key, { resumableUrl: undefined });
              continue;
            }
            throw e;
          }
        }
      }
      if (!file) throw new Error("Upload did not complete.");
      const cur = await ctx.store.getItem(this.kind, q.id);
      if (cur) await ctx.store.putItem({ ...cur, mediaFileId: file.id, mediaRev: rev });
      // The name follows the extension, which may change with the new media.
      if (replaceId) await ctx.api.updateMetadata(file.id, { name: meta.name });
    } finally {
      env.progress(key, null);
    }
  }

  // ----------------------------------------------------------------- import

  accepts(file: DriveFile): boolean {
    const im = this.col.importMedia;
    return !!im && im.mimeTypes.some((p) => mimeMatches(p, file.mimeType));
  }

  /** Adopts a picked media file: the item is created from the file, which stays where it is as the item's media. */
  async importFile(file: DriveFile, id: string, existingId: string | undefined): Promise<boolean> {
    const im = this.col.importMedia;
    if (!im) return false;
    if (existingId && (await this.col.store.get(id))) return false;
    const blob = await this.ctx.api.downloadMedia(file.id);
    const tagged = await adoptFile(this.ctx.api, this.ctx.props, file, this.ctx.folder(this.col.folder.id), this.kind, id);
    const typed = blob.type ? blob : blob.slice(0, blob.size, file.mimeType);
    const item = await im.create(typed, file.name.replace(/\.[^.]+$/, ""), id);
    await this.col.store.save(id, item);
    await this.col.store.setBlob(id, typed);
    await this.ctx.store.setMeta(updatedAtKey(this.kind, id), this.ctx.now());
    await this.ctx.store.putItem({
      kind: this.kind,
      id,
      driveFileId: "",
      lastSyncedHash: "",
      lastRemoteVersion: "",
      mediaFileId: tagged.id,
      mediaRev: this.mediaRev(item),
    });
    await this.env.enqueue("upsert", this.kind, id);
    return true;
  }
}
