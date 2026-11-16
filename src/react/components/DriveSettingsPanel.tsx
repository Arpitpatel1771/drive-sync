import { useDriveSync } from "../DriveSyncProvider";
import { chipFor, dotTone, relativeTime } from "../syncUi";
import { Avatar, GoogleG, UploadSettings, cx, importMessage, useAction } from "./shared";

export interface DriveSettingsPanelProps {
  className?: string;
  /** Label for a files collection's upload-setting control. */
  uploadLabel?: (kind: string) => string;
}

/** Connect / disconnect, the account, upload settings and import, as an inline panel. */
export function DriveSettingsPanel({ className, uploadLabel }: DriveSettingsPanelProps) {
  const drive = useDriveSync();
  const { busy, run } = useAction();
  const { status, configured } = drive;
  if (!configured) {
    return (
      <section className={cx("ds-root", "ds-panel", className)}>
        <p className="ds-sub">Google Drive sync is not configured.</p>
      </section>
    );
  }
  if (status.state === "disconnected") {
    return (
      <section className={cx("ds-root", "ds-panel", className)}>
        <button type="button" className="ds-btn ds-signin" disabled={busy} onClick={() => void run(drive.connect)}>
          <GoogleG /> Sign in with Google
        </button>
        <p className="ds-sub">Back up &amp; sync with Google Drive.</p>
      </section>
    );
  }
  const chip = chipFor(status);
  const label = status.name ?? status.email ?? "Google account";
  return (
    <section className={cx("ds-root", "ds-panel", className)}>
      <div className="ds-header">
        <Avatar picture={status.picture} name={status.name} email={status.email} size={44} />
        <span className="ds-text-col">
          <span className="ds-name">{label}</span>
          {status.name && status.email && <span className="ds-sub">{status.email}</span>}
        </span>
      </div>
      <div className="ds-status-line">
        <span className={`ds-dot-inline ds-tone-${dotTone(status)}`} />
        <span>
          {chip?.text}
          {status.lastSyncAt ? ` · Last synced ${relativeTime(status.lastSyncAt)}` : ""}
        </span>
      </div>
      <div className="ds-panel-actions">
        {status.state === "authRequired" && (
          <button type="button" className="ds-btn ds-btn-primary" disabled={busy} onClick={() => void run(drive.connect)}>
            Sign in to resume
          </button>
        )}
        {status.conflicts.length > 0 && (
          <button type="button" className="ds-btn" onClick={() => drive.setConflictsOpen(true)}>
            Resolve {status.conflicts.length} {status.conflicts.length === 1 ? "conflict" : "conflicts"}
          </button>
        )}
        <button type="button" className="ds-btn" disabled={busy} onClick={() => void run(drive.syncNow)}>
          Sync now
        </button>
        <button
          type="button"
          className="ds-btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const counts = await drive.importFromDrive();
              if (Object.values(counts).some((n) => n > 0)) drive.toast(importMessage(counts, drive.collections), "info");
            })
          }
        >
          Import from Drive
        </button>
        <button type="button" className="ds-btn ds-btn-danger" disabled={busy} onClick={() => void run(drive.disconnect)}>
          Disconnect
        </button>
      </div>
      <UploadSettings label={uploadLabel} busy={busy} onError={(e) => drive.toast(e instanceof Error ? e.message : String(e), "error")} />
    </section>
  );
}
