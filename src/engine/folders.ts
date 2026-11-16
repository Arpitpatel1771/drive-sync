// Drive folder tree: `<appName>/` (root), one folder per collection, the hidden folder, and each file
// collection's sidecar folder inside it. Stored as `conn.folders`, keyed by folder id.

import type { DriveApi, DriveFile } from "../drive/api";
import type { ResolvedConfig } from "../config";
import type { Props } from "../props";

interface FolderPlan {
  id: string;
  name: string;
  /** Folder id of the parent, or null for the root. */
  parent: "root" | "hidden" | null;
}

/** Every folder the config needs, parents before children. */
export function plannedFolders(config: ResolvedConfig): FolderPlan[] {
  const plan: FolderPlan[] = [{ id: "root", name: config.appName, parent: null }];
  for (const c of config.documents) plan.push({ id: c.folder.id, name: c.folder.name, parent: "root" });
  for (const c of config.files) plan.push({ id: c.folder.id, name: c.folder.name, parent: "root" });
  plan.push({ id: "hidden", name: config.hiddenFolder, parent: "root" });
  for (const c of config.files) plan.push({ id: c.metaFolder.id, name: c.metaFolder.name, parent: "hidden" });
  return plan;
}

/** True when `folders` lacks an entry the config needs. */
export function missingFolders(config: ResolvedConfig, folders: Record<string, string>): boolean {
  return plannedFolders(config).some((f) => !folders[f.id]);
}

/**
 * Finds or creates every folder that `existing` doesn't know yet and returns the full map. Entries already
 * in `existing` are kept as they are, so a site that adds a collection later only gets the new folders.
 */
export async function ensureFolders(
  api: DriveApi,
  config: ResolvedConfig,
  props: Props,
  existing: Record<string, string> = {}
): Promise<Record<string, string>> {
  const folders = { ...existing };
  for (const f of plannedFolders(config)) {
    if (folders[f.id]) continue;
    const tag = props.tag("folder", f.id);
    const found = await api.findFolder(tag);
    folders[f.id] = (found ?? (await api.createFolder(f.name, f.parent ? folders[f.parent] : null, tag))).id;
  }
  return folders;
}

/** Tags a file the user picked in Drive with `kind`/`id` and moves it into `folderId`. */
export async function adoptFile(
  api: DriveApi,
  props: Props,
  file: DriveFile,
  folderId: string,
  kind: string,
  id: string
): Promise<DriveFile> {
  const addParents = file.parents.includes(folderId) ? undefined : [folderId];
  const removeParents = file.parents.filter((p) => p !== folderId);
  return api.updateMetadata(file.id, {
    appProperties: props.tag(kind, id),
    ...(addParents ? { addParents, removeParents } : {}),
  });
}
