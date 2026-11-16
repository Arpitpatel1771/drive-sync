// Handler for the optional settings file: `<hiddenFolder>/settings.json` holding `{ updatedAt, settings }`.

import type { DriveFile } from "../drive/api";
import type { SettingsSync } from "../config";
import type { SyncItem } from "../store/syncStore";
import type { Handler, HandlerContext, LocalDoc, RemoteDoc } from "./types";
import { sha256, stable } from "./util";

export const SETTINGS_KIND = "settings";
export const SETTINGS_ID = "settings";
export const SETTINGS_UPDATED_AT = "settingsUpdatedAt";

/** The settings without the fields that never leave this device. */
export function syncedSettings<S extends object>(s: Partial<S>, deviceLocal: readonly (keyof S)[]): Partial<S> {
  const o: Partial<S> = { ...s };
  for (const k of deviceLocal) delete o[k];
  return o;
}

export class SettingsHandler implements Handler {
  readonly kind = SETTINGS_KIND;
  readonly driveKind = SETTINGS_KIND;
  readonly bodyMime = "application/json";
  readonly conflicts = "newest" as const;
  readonly remoteDelete = "ignore" as const;

  constructor(
    private readonly settings: SettingsSync,
    private readonly ctx: HandlerContext
  ) {}

  private synced(s: object) {
    return syncedSettings(s as Record<string, unknown>, this.settings.deviceLocal as string[]);
  }

  async listIds(): Promise<string[]> {
    return [SETTINGS_ID];
  }

  async readLocal(): Promise<LocalDoc | null> {
    const current = await this.settings.load();
    const synced = this.synced(current);
    const updatedAt = (await this.ctx.store.getMeta<number>(SETTINGS_UPDATED_AT)) ?? 0;
    return { body: JSON.stringify({ updatedAt, settings: synced }), hash: await sha256(stable(synced)), updatedAt, title: "settings", item: current };
  }

  async readRemote(_id: string, file: DriveFile): Promise<RemoteDoc | null> {
    const text = await (await this.ctx.api.downloadMedia(file.id)).text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const updatedAt = typeof json.updatedAt === "number" ? json.updatedAt : 0;
    const settings = this.synced((json.settings ?? {}) as object);
    return { text, json, hash: await sha256(stable(settings)), updatedAt };
  }

  /** Merges the remote settings over this device's, keeping this device's own device-local fields. */
  async applyRemote(_id: string, remote: RemoteDoc): Promise<{ hash: string }> {
    const current = (await this.settings.load()) as Record<string, unknown>;
    const incoming = this.synced((remote.json?.settings ?? {}) as object);
    const merged: Record<string, unknown> = { ...current, ...incoming };
    for (const k of this.settings.deviceLocal as string[]) merged[k] = current[k];
    await this.settings.save(merged);
    await this.ctx.store.setMeta(SETTINGS_UPDATED_AT, remote.updatedAt);
    // Hash what the site now holds: a save that normalises the settings must not look like a local change.
    return { hash: await sha256(stable(this.synced(await this.settings.load()))) };
  }

  async createSpec() {
    return { name: "settings.json", parent: this.ctx.folder("hidden"), mimeType: this.bodyMime };
  }

  async afterUpdate(_id: string, _item: SyncItem, _local: LocalDoc, file: DriveFile): Promise<DriveFile> {
    return file;
  }

  async localTitle(): Promise<string> {
    return "settings";
  }

  remoteTitle(): string {
    return "settings";
  }

  async deleteLocal(): Promise<void> {
    // Settings are never deleted locally.
  }
}
