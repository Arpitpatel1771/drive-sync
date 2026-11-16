// Pieces shared by the Drive components: the built-in menu / dialog containers, avatar, upload-setting control.
// Nothing here touches `window` or `document` during render; listeners are attached in effects only.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDriveSync } from "../DriveSyncProvider";
import { initialsFor } from "../syncUi";

export interface ContainerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}
export type RenderContainer = (props: ContainerProps) => ReactNode;

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** Calls `onClose` on Escape while `active`. */
export function useEscape(active: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);
}

/** Calls `onClose` on a pointer press outside `ref` while `active`. */
export function useOutsideClick(active: boolean, ref: { current: HTMLElement | null }, onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) cb.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [active, ref]);
}

/** The default dialog: an overlay with a centred modal. A site's `renderDialog` replaces it. */
export function BuiltInDialog({ open, onClose, title, children, className, wide }: ContainerProps & { className?: string; wide?: boolean }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className={cx("ds-overlay", "ds-root", className)}>
      <div className={cx("ds-dialog", wide && "ds-dialog-wide")} role="dialog" aria-modal="true" aria-label={title}>
        {children}
      </div>
    </div>
  );
}

/** Wraps package content handed to a site's own container so it still gets the theme defaults. */
export function Body({ children }: { children: ReactNode }) {
  return <div className="ds-root ds-body">{children}</div>;
}

export function renderContainer(custom: RenderContainer | undefined, props: ContainerProps, fallback: () => ReactNode): ReactNode {
  return custom ? custom({ ...props, children: <Body>{props.children}</Body> }) : fallback();
}

export function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" className="ds-g">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export function Avatar({ picture, name, email, size, tone }: { picture: string | null; name: string | null; email: string | null; size: number; tone?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = picture && failed !== picture;
  return (
    <span className="ds-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {showImg ? (
        <img src={picture} referrerPolicy="no-referrer" alt="" onError={() => setFailed(picture)} />
      ) : (
        <span className="ds-initials" aria-hidden="true">
          {initialsFor(name, email)}
        </span>
      )}
      {tone && <span className={`ds-dot ds-tone-${tone}`} data-tone={tone} />}
    </span>
  );
}

/** Runs an async action with a busy flag; failures go to the site's toast. */
export function useAction() {
  const { toast } = useDriveSync();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    after?.();
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/** "Imported 2 song(s) and 3 recording(s)." from per-kind counts. */
export function importMessage(counts: Record<string, number>, labels?: readonly { kind: string; label?: { one: string } }[]): string {
  const parts = Object.entries(counts).map(([kind, n]) => `${n} ${labels?.find((l) => l.kind === kind)?.label?.one ?? kind}(s)`);
  return parts.length === 0 ? "Nothing to import." : `Imported ${parts.join(" and ")}.`;
}

/** The plural label of a kind (the kind itself when the collection has none). */
export function pluralLabel(collections: readonly { kind: string; label?: { other: string } }[], kind: string): string {
  return collections.find((c) => c.kind === kind)?.label?.other ?? kind;
}

/** The singular label of a kind (the kind itself when the collection has none). */
export function singularLabel(collections: readonly { kind: string; label?: { one: string } }[], kind: string): string {
  return collections.find((c) => c.kind === kind)?.label?.one ?? kind;
}

/** One segmented control (radio group) per files collection that declares upload settings. */
export function UploadSettings({ label, icon, busy, onError }: { label?: (kind: string) => string; icon?: ReactNode; busy?: boolean; onError?: (e: unknown) => void }) {
  const drive = useDriveSync();
  const cols = drive.collections.filter((c) => c.type === "files" && c.uploadSettings.length > 0);
  if (cols.length === 0) return null;
  return (
    <>
      {cols.map((c) => {
        const current = drive.configured ? drive.uploadSetting(c.kind) : c.defaultUploadSetting;
        const text = label ? label(c.kind) : `Upload ${pluralLabel(drive.collections, c.kind)} to Drive`;
        return (
          <div className="ds-upload-row" key={c.kind}>
            <span className="ds-sub">{icon}{text}</span>
            <div className="ds-segmented" role="radiogroup" aria-label={text}>
              {c.uploadSettings.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === current}
                  className={cx("ds-seg", o.value === current && "ds-seg-on")}
                  disabled={busy}
                  onClick={() => drive.setUploadSetting(c.kind, o.value).catch((e: unknown) => onError?.(e))}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
