import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Dialogs on screen, oldest first. */
const open: symbol[] = [];

export function Dialog({
  title,
  onClose,
  children,
  tabs,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  tabs?: ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Escape closes only the top dialog when one opens over another.
    const token = Symbol("dialog");
    open.push(token);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && open.at(-1) === token && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      open.splice(open.indexOf(token), 1);
    };
  }, []);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {tabs}
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
