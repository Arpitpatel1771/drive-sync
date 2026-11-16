import { useDriveSync } from "../DriveSyncProvider";
import { chipFor } from "../syncUi";
import { cx } from "./shared";

/** The sync status as text ("Synced", "Syncing…", ...). Renders nothing when disconnected or not configured. */
export function DriveStatusChip({ className }: { className?: string }) {
  const { status, configured, setConflictsOpen } = useDriveSync();
  const chip = configured ? chipFor(status) : null;
  if (!chip) return null;
  const common = { className: cx("ds-root", "ds-status-chip", `ds-tone-${chip.tone}`, chip.pulse && "ds-pulse", className), "data-tone": chip.tone };
  if (chip.action === "conflicts") {
    return (
      <button type="button" {...common} onClick={() => setConflictsOpen(true)}>
        {chip.text}
      </button>
    );
  }
  return (
    <span {...common} role="status">
      {chip.text}
    </span>
  );
}
