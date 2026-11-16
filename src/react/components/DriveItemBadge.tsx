import { useDriveSync } from "../DriveSyncProvider";
import { itemBadge } from "../syncUi";
import { cx } from "./shared";

/** Per-item sync status for a file collection ("In Drive", "Uploading 43%", ...). */
export function DriveItemBadge({ kind, id, className }: { kind: string; id: string; className?: string }) {
  const { configured, itemStatus, uploadProgress } = useDriveSync();
  if (!configured) return null;
  const status = itemStatus(kind, id);
  const badge = itemBadge(status, uploadProgress(kind, id));
  return (
    <span className={cx("ds-root", "ds-badge", `ds-badge-${badge.kind}`, className)} data-status={badge.kind}>
      {badge.text}
    </span>
  );
}
