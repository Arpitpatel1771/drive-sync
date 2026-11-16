import { useEffect, type ReactNode } from "react";
import type { Conflict } from "../../engine/types";
import { useDriveSync } from "../DriveSyncProvider";
import { BuiltInDialog, renderContainer, useAction, type RenderContainer } from "./shared";

export interface DriveConflictDialogProps {
  /** Applied to the built-in dialog only; `renderDialog` ignores it. */
  className?: string;
  /** Replaces the built-in dialog container; `children` is the package's own content. */
  renderDialog?: RenderContainer;
  /** Shows a site's own preview of one side of the conflict. */
  renderVersion?: (conflict: Conflict, side: "local" | "remote") => ReactNode;
  /** Overrides whether the dialog shows (default: the provider's `conflictsOpen`). */
  open?: boolean;
}

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : "unknown");

function DefaultVersion({ conflict, side }: { conflict: Conflict; side: "local" | "remote" }) {
  const local = side === "local";
  return (
    <>
      <span className="ds-col-title">
        {local ? "This device" : "Drive"}: {local ? conflict.localTitle : conflict.remoteTitle}
      </span>
      <span className="ds-when">Changed {when(local ? conflict.localUpdatedAt : conflict.remoteUpdatedAt)}</span>
      <pre className="ds-text">{local ? conflict.localText : conflict.remoteText}</pre>
    </>
  );
}

/** Shows the first conflict (when opened) with the three choices. */
export function DriveConflictDialog({ className, renderDialog, renderVersion, open }: DriveConflictDialogProps) {
  const { status, conflictsOpen, setConflictsOpen, resolveConflict, configured } = useDriveSync();
  const { run } = useAction();
  const conflicts = status.conflicts;
  const none = conflicts.length === 0;
  useEffect(() => {
    if (conflictsOpen && none) setConflictsOpen(false);
  }, [conflictsOpen, none, setConflictsOpen]);

  // The remote-delete question comes first (see DriveDeleteConfirm).
  const isOpen = (open ?? conflictsOpen) && !none && configured && status.pendingRemoteDeletes.length === 0;
  if (!isOpen) return null;
  const conflict = conflicts[0];
  const total = conflicts.length;
  const title = `“${conflict.localTitle}” changed on this device and in Drive${total > 1 ? ` (1 of ${total})` : ""}`;
  const choose = (choice: "local" | "remote" | "both") => void run(() => resolveConflict(conflict.kind, conflict.id, choice));
  const onClose = () => setConflictsOpen(false);

  const content = (
    <>
      <h3 className="ds-title">{title}</h3>
      <div className="ds-cols">
        {(["local", "remote"] as const).map((side) => (
          <div className="ds-col" key={side}>
            {renderVersion ? renderVersion(conflict, side) : <DefaultVersion conflict={conflict} side={side} />}
          </div>
        ))}
      </div>
      <div className="ds-actions">
        <button type="button" className="ds-btn" onClick={() => choose("local")}>
          Keep this device's
        </button>
        <button type="button" className="ds-btn" onClick={() => choose("remote")}>
          Keep Drive's
        </button>
        <button type="button" className="ds-btn ds-btn-primary" onClick={() => choose("both")}>
          Keep both
        </button>
      </div>
    </>
  );
  return renderContainer(renderDialog, { open: true, onClose, title, children: content }, () => (
    <BuiltInDialog open onClose={onClose} title={title} className={className} wide>
      {content}
    </BuiltInDialog>
  ));
}
