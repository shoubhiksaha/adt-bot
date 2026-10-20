import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";
import { stopEverything } from "../../lib/chat";
import { useStore } from "../../lib/store";
import { platformComputerNoun, useMacControl } from "./store";

const LINGER_MS = 2500;

/** "ADT Bot is controlling your Mac/PC — Stop", shown while a tool runs (and briefly between steps). */
export function MacControlBanner() {
  const active = useMacControl((s) => s.active);
  const lastDoneAt = useMacControl((s) => s.lastDoneAt);
  const streaming = useStore((s) => s.streamingId !== null);
  const appName = useStore((s) => s.settings.brand.name) || "ADT Bot";
  const device = platformComputerNoun();
  const [, tick] = useState(0);
  const lingering = streaming && Date.now() - lastDoneAt < LINGER_MS;

  useEffect(() => {
    if (!lingering || active) return;
    const timer = setTimeout(() => tick((n) => n + 1), LINGER_MS - (Date.now() - lastDoneAt) + 20);
    return () => clearTimeout(timer);
  }, [lingering, active, lastDoneAt]);

  if (!active && !lingering) return null;
  return (
    <div className="mac-control-banner" role="status" aria-live="polite">
      <MousePointer2 size={15} aria-hidden />
      <span>
        {appName} is controlling your {device}
      </span>
      <kbd className="mac-control-kbd" title="Stops every bot, from any app">
        {device === "Mac" ? "⌘⇧⎋" : "Ctrl+Alt+Shift+Esc"}
      </kbd>
      <button type="button" onClick={() => stopEverything()}>
        Stop
      </button>
    </div>
  );
}
