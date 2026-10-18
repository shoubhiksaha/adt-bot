import { MoreHorizontal } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean } | "separator";

/**
 * A small action menu fixed to the viewport, so a scrolling column can't clip it. It's also the
 * keyboard and touch alternative to drag and drop (Move to…, Move up/down).
 */
export function Menu({ label, items, icon }: { label: string; items: MenuItem[]; icon?: ReactNode }) {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = style !== null;

  const close = (refocus = true) => {
    setStyle(null);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setStyle(null);
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.parentElement?.contains(target)) setStyle(null);
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);

  const toggle = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (open || !box) return setStyle(null);
    const width = 220;
    const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - box.bottom;
    setStyle(below > 260 || below > box.top ? { left, top: box.bottom + 4, width } : { left, bottom: window.innerHeight - box.top + 4, width });
  };

  return (
    <span
      className="pj-menu-wrap"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-btn pj-small-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        {icon ?? <MoreHorizontal size={15} />}
      </button>
      {style && (
        <div className="pj-menu" role="menu" aria-label={label} style={style}>
          {items.map((item, i) =>
            item === "separator" ? (
              <hr key={`sep-${i}`} />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : undefined}
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  close(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </span>
  );
}
