// Voice mode's diagnostics: why it stopped or kept talking, what it heard and what came back.
// Shared by both voice engines (voice-session.ts and live-session.ts).
import { desktopInvoke } from "./desktop";
import { useStore } from "./store";

/**
 * In the console when localStorage "adt-debug-voice" is "1" (read once), and in voice-debug.log on
 * this computer when Settings → Voice → Voice diagnostics is on.
 */
let debugOn: boolean | undefined;
export const debugVoice = (...parts: unknown[]) => {
  try {
    debugOn ??= localStorage.getItem("adt-debug-voice") === "1";
  } catch {
    debugOn = false;
  }
  if (debugOn) console.debug("[voice]", ...parts);
  if (useStore.getState().settings.voice.diagnostics) logVoice(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
};

/** Lines for voice-debug.log, written every couple of seconds (desktop only). */
let logLines: string[] = [];
let logTimer: ReturnType<typeof setTimeout> | null = null;
function logVoice(line: string) {
  if (typeof window === "undefined" || !window.adtbotDesktop?.invoke) return;
  logLines.push(`${new Date().toISOString()} ${line}`);
  logTimer ??= setTimeout(() => {
    const lines = logLines;
    logLines = [];
    logTimer = null;
    void desktopInvoke("adt:voice:log", { lines }).catch(() => undefined);
  }, 2000);
}
