import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
