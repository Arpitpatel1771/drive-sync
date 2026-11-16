// Handler for a documents collection: one text file per item, the site's toFile/fromFile do the conversion.

import { listAllFiles, type DriveFile } from "../drive/api";
import type { DocumentCollection } from "../config";
import type { SyncItem } from "../store/syncStore";
import { adoptFile } from "./folders";
import type { Handler, HandlerContext, LocalDoc, RemoteDoc } from "./types";
import { sanitizeName, sha256 } from "./util";

export class DocumentsHandler implements Handler {
  readonly kind: string;
  readonly driveKind: string;
  readonly bodyMime: string;
  readonly conflicts: "ask" | "newest";
  readonly remoteDelete: "ask" | "follow" | "ignore";

  constructor(
    readonly col: DocumentCollection,
    private readonly ctx: HandlerContext
  ) {
    this.kind = this.driveKind = col.kind;
    this.bodyMime = col.mimeType;
    this.conflicts = col.conflicts;
    this.remoteDelete = col.remoteDelete;
  }

  async listIds(): Promise<string[]> {
    return (await this.col.store.list()).map((i) => this.col.idOf(i));
  }

  async readLocal(id: string): Promise<LocalDoc | null> {
    const item = await this.col.store.get(id);
    if (!item) return null;
    const body = this.col.toFile(item);
    return { body, hash: await sha256(body), updatedAt: this.col.updatedAt(item), title: this.col.titleOf(item), item };
  }

  async readRemote(_id: string, file: DriveFile): Promise<RemoteDoc | null> {
    const text = await (await this.ctx.api.downloadMedia(file.id)).text();
    return { text, hash: await sha256(text), updatedAt: Date.parse(file.modifiedTime) || 0 };
  }

  async applyRemote(id: string, remote: RemoteDoc): Promise<{ hash: string }> {
    const existing = await this.col.store.get(id);
    const item = this.col.fromFile(remote.text, id, existing);
    await this.col.store.save(id, item);
    return { hash: await sha256(this.col.toFile(item)) };
  }

  async createSpec(_id: string, local: LocalDoc) {
    return {
      name: await this.uniqueName(local.item, null),
      parent: this.ctx.folder(this.col.folder.id),
      mimeType: this.col.mimeType,
    };
  }

  async afterUpdate(_id: string, item: SyncItem, local: LocalDoc, file: DriveFile, remoteMeta: DriveFile): Promise<DriveFile> {
    const name = await this.uniqueName(local.item, item.driveFileId);
    return name !== remoteMeta.name ? this.ctx.api.updateMetadata(item.driveFileId, { name }) : file;
  }

  async localTitle(id: string): Promise<string | undefined> {
    const item = await this.col.store.get(id);
    return item === undefined ? undefined : this.col.titleOf(item);
  }

  remoteTitle(id: string, remote: RemoteDoc): string {
    return this.col.titleOf(this.col.fromFile(remote.text, id));
  }

  deleteLocal(id: string): Promise<void> {
    return this.col.store.remove(id);
  }

  /** `<fileName(item)><extension>`, with " (2)", " (3)" ... added while another file in the folder has the name. */
  private async uniqueName(item: unknown, selfFileId: string | null): Promise<string> {
    const files = await listAllFiles(this.ctx.api, { parentId: this.ctx.folder(this.col.folder.id) });
    const taken = new Set(files.filter((f) => f.id !== selfFileId).map((f) => f.name.toLowerCase()));
    const base = sanitizeName(this.col.fileName(item));
    const ext = this.col.extension;
    let name = `${base}${ext}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
    return name;
  }

  /** True for an untagged file the collection can adopt. */
  accepts(file: DriveFile): boolean {
    const adopt = this.col.adopt;
    if (!adopt) return false;
    const name = file.name.toLowerCase();
    return file.mimeType === this.col.mimeType || adopt.extensions.some((e) => name.endsWith(e.toLowerCase()));
  }

  /** Adopts a picked file. Returns false when it is already here (nothing imported). */
  async importFile(file: DriveFile, id: string, existingId: string | undefined): Promise<boolean> {
    if (existingId && (await this.col.store.get(id))) return false;
    const text = await (await this.ctx.api.downloadMedia(file.id)).text();
    const tagged = await adoptFile(this.ctx.api, this.ctx.props, file, this.ctx.folder(this.col.folder.id), this.col.kind, id);
    const item = this.col.fromFile(text, id);
    await this.col.store.save(id, item);
    await this.ctx.store.putItem({
      kind: this.col.kind,
      id,
      driveFileId: tagged.id,
      lastSyncedHash: await sha256(this.col.toFile(item)),
      lastRemoteVersion: tagged.version,
    });
    return true;
  }
}
