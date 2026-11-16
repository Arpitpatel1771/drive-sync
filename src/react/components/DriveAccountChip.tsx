import { useRef, useState, type ReactNode } from "react";
import { useDriveSync } from "../DriveSyncProvider";
import { chipFor, dotTone, relativeTime } from "../syncUi";
import { Avatar, GoogleG, UploadSettings, cx, importMessage, renderContainer, useAction, useEscape, useOutsideClick, type RenderContainer } from "./shared";

export interface DriveAccountChipProps {
  className?: string;
  /** Text under "Sign in with Google" when disconnected. */
  subtitle?: ReactNode;
  /** Avatar only (no name), for a collapsed rail. */
  compact?: boolean;
  /** Replaces the built-in menu container (popover); `children` is the package's own items. */
  renderMenu?: RenderContainer;
  /** Adds a "Drive settings" item that calls this. */
  onOpenSettings?: () => void;
  /** Label for a files collection's upload-setting control. */
  uploadLabel?: (kind: string) => string;
  /** Icons shown before an item's label (`connect` replaces the Google "G" on the sign-in button). */
  icons?: DriveAccountChipIcons;
}

export type DriveAccountChipIconId = "connect" | "resume" | "conflicts" | "sync" | "upload" | "import" | "settings" | "disconnect";
export type DriveAccountChipIcons = Partial<Record<DriveAccountChipIconId, ReactNode>>;

/** Account avatar with a status dot; its menu holds connect / sync / conflicts / upload settings / import / disconnect. */
export function DriveAccountChip({ className, subtitle = "Back up & sync with Google Drive", compact, renderMenu, onOpenSettings, uploadLabel, icons }: DriveAccountChipProps) {
  const drive = useDriveSync();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const customMenu = Boolean(renderMenu);
  useEscape(open && !customMenu, close);
  useOutsideClick(open && !customMenu, rootRef, close);
  if (!drive.configured) return null;
  const { status } = drive;

  if (status.state === "disconnected") {
    return (
      <button
        type="button"
        className={cx("ds-root", "ds-signin", compact && "ds-compact", className)}
        disabled={busy}
        title={compact ? "Sign in with Google" : undefined}
        aria-label={compact ? "Sign in with Google" : undefined}
        onClick={() => void run(drive.connect)}
      >
        {icons?.connect ?? <GoogleG />}
        {!compact && (
          <span className="ds-text-col">
            <span className="ds-name">Sign in with Google</span>
            <span className="ds-sub">{subtitle}</span>
          </span>
        )}
      </button>
    );
  }

  const chip = chipFor(status);
  const tone = dotTone(status);
  const { name, email, picture } = status;
  const label = name ?? email ?? "Google account";
  const item = (id: DriveAccountChipIconId, text: ReactNode, onClick: () => void, opts?: { danger?: boolean; disabled?: boolean }) => (
    <button type="button" role="menuitem" className={cx("ds-item", opts?.danger && "ds-danger")} disabled={opts?.disabled} onClick={onClick}>
      {icons?.[id]}
      {text}
    </button>
  );
  const menuItems = (
    <>
      <div className="ds-header">
        <Avatar picture={picture} name={name} email={email} size={44} />
        <span className="ds-text-col">
          <span className="ds-name">{label}</span>
          {name && email && <span className="ds-sub">{email}</span>}
        </span>
      </div>
      <div className="ds-status-line">
        <span className={`ds-dot-inline ds-tone-${tone}`} />
        <span>
          {chip?.text}
          {status.lastSyncAt ? ` · Last synced ${relativeTime(status.lastSyncAt)}` : ""}
        </span>
      </div>
      {status.state === "authRequired" && item("resume", "Sign in to resume", () => void run(drive.connect, close))}
      {status.conflicts.length > 0 &&
        item("conflicts", `Resolve ${status.conflicts.length} ${status.conflicts.length === 1 ? "conflict" : "conflicts"}`, () => {
          drive.setConflictsOpen(true);
          close();
        })}
      {item("sync", "Sync now", () => void run(drive.syncNow, close), { disabled: busy })}
      <UploadSettings label={uploadLabel} icon={icons?.upload} busy={busy} onError={(e) => drive.toast(e instanceof Error ? e.message : String(e), "error")} />
      {item(
        "import",
        "Import from Drive",
        () =>
          void run(async () => {
            const counts = await drive.importFromDrive();
            if (Object.values(counts).some((n) => n > 0)) drive.toast(importMessage(counts, drive.collections), "info");
          }, close),
        { disabled: busy },
      )}
      {onOpenSettings && item("settings", "Drive settings", () => {
        close();
        onOpenSettings();
      })}
      {item("disconnect", "Sign out", () => void run(drive.disconnect, close), { danger: true, disabled: busy })}
    </>
  );
  const menuTitle = `Account: ${label}`;

  return (
    <div className={cx("ds-root", "ds-chip-wrap", className)} ref={rootRef}>
      <button
        type="button"
        className={cx("ds-chip", compact && "ds-compact")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={menuTitle}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar picture={picture} name={name} email={email} size={28} tone={tone} />
        {!compact && (
          <span className="ds-text-col">
            <span className="ds-name">{label}</span>
            {name && email && <span className="ds-sub">{email}</span>}
          </span>
        )}
      </button>
      {renderMenu
        ? renderContainer(renderMenu, { open, onClose: close, title: menuTitle, children: menuItems }, () => null)
        : open && (
            <div className="ds-menu" role="menu" aria-label={menuTitle}>
              {menuItems}
            </div>
          )}
    </div>
  );
}
