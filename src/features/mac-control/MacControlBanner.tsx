import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";
import { stopStreaming } from "../../lib/chat";
import { useStore } from "../../lib/store";
import { useMacControl } from "./store";

const LINGER_MS = 2500;

/** "ADT Bot is controlling your Mac — Stop", shown while a Mac tool runs (and briefly between steps). */
export function MacControlBanner() {
  const active = useMacControl((s) => s.active);
  const lastDoneAt = useMacControl((s) => s.lastDoneAt);
  const streaming = useStore((s) => s.streamingId !== null);
  const appName = useStore((s) => s.settings.brand.name) || "ADT Bot";
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
      <span>{appName} is controlling your Mac</span>
      <button type="button" onClick={() => stopStreaming()}>
        Stop
      </button>
    </div>
  );
}
