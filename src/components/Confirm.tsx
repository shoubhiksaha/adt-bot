import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "./Dialog";

type ConfirmOptions = {
  /** The dialog's title ("Are you sure?" for danger, "Confirm" otherwise). */
  title?: string;
  /** The question, e.g. "Delete the skill /weekly-report?". */
  message: string;
  /** More about what happens, under the question. */
  detail?: string;
  /** The button that goes ahead ("Delete", "Disconnect"…). */
  confirm?: string;
  /** Going ahead deletes or removes something: the button is red. */
  danger?: boolean;
};

function ConfirmDialog({ title, message, detail, confirm = "OK", danger, onDone }: ConfirmOptions & { onDone: (ok: boolean) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);
  return (
    <Dialog title={title ?? (danger ? "Are you sure?" : "Confirm")} onClose={() => onDone(false)}>
      <p style={{ margin: 0, whiteSpace: "pre-line" }}>{message}</p>
      {detail && (
        <p className="small muted" style={{ whiteSpace: "pre-line" }}>
          {detail}
        </p>
      )}
      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
        <button type="button" className="btn" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button ref={button} type="button" className={`btn ${danger ? "danger" : "primary"}`} onClick={() => onDone(true)}>
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Asks in the app's own dialog (not the browser's confirm(), which looks foreign and blocks the
 * whole window). Resolves true when the user goes ahead; Cancel, Esc or a click outside is false.
 */
export function askConfirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === "string" ? { message: options } : options;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (ok: boolean) => {
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<ConfirmDialog {...opts} onDone={done} />);
  });
}

/** askConfirm, then `action` when the user goes ahead. */
export function confirmThen(options: ConfirmOptions | string, action: () => unknown): void {
  void askConfirm(options).then((ok) => {
    if (ok) void action();
  });
}
