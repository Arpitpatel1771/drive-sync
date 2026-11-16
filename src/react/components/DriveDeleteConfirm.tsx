import { useDriveSync } from "../DriveSyncProvider";
import { BuiltInDialog, renderContainer, singularLabel, useAction, type RenderContainer } from "./shared";

export interface DriveDeleteConfirmProps {
  /** Applied to the built-in dialog only; `renderDialog` ignores it. */
  className?: string;
  renderDialog?: RenderContainer;
}

/** The batched question when items were deleted in Drive: delete them here too, or keep (re-upload). */
export function DriveDeleteConfirm({ className, renderDialog }: DriveDeleteConfirmProps) {
  const { status, confirmDeletes, configured, collections } = useDriveSync();
  const { run } = useAction();
  const deletes = status.pendingRemoteDeletes;
  if (!configured || deletes.length === 0) return null;
  const n = deletes.length;
  const title = `${n === 1 ? "1 item was" : `${n} items were`} deleted in Drive. Delete ${n === 1 ? "it" : "them"} here too?`;
  const items = deletes.map((d) => ({ kind: d.kind, id: d.id }));
  const answer = (accept: boolean) => void run(() => confirmDeletes(items, accept));
  // An answer is required, so Escape / outside close does nothing.
  const onClose = () => {};
  const content = (
    <>
      <h3 className="ds-title">{title}</h3>
      <ul className="ds-list">
        {deletes.map((d) => (
          <li key={`${d.kind}:${d.id}`}>
            {d.title} <span className="ds-when">({singularLabel(collections, d.kind)})</span>
          </li>
        ))}
      </ul>
      <div className="ds-actions">
        <button type="button" className="ds-btn" onClick={() => answer(false)}>
          Keep (re-upload)
        </button>
        <button type="button" className="ds-btn ds-btn-danger" onClick={() => answer(true)}>
          Delete here
        </button>
      </div>
    </>
  );
  return renderContainer(renderDialog, { open: true, onClose, title, children: content }, () => (
    <BuiltInDialog open onClose={onClose} title={title} className={className}>
      {content}
    </BuiltInDialog>
  ));
}
