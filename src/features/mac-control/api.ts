import { desktopInvoke } from "../../lib/desktop";

/** Typed bridge to electron/features/70-mac-control.cjs ("adt:mac:*"). */
export type MacPermissions = {
  supported: boolean;
  platform: string;
  accessibility?: boolean | null;
  screenRecording?: string;
  /** Allowed in System Settings, but the running app still has macOS's old answer until it restarts. */
  screenNeedsRestart?: boolean;
  /** System Events automation: "granted", "denied", or "unknown" until macOS has been asked. */
  automation?: "granted" | "denied" | "unknown";
  microphone?: string;
  app?: string;
  screen?: { width: number; height: number; backing: number } | null;
  /** Linux (electron/features/76-linux-control.cjs): the session, and how each part works there. */
  linux?: {
    session: "x11" | "wayland" | "none" | "unknown";
    atspi: boolean;
    input: "xtest" | "portal" | "portal-saved" | "portal-needs-approval" | "none";
    screenshot: "x11" | "portal" | "none";
    missing: string[];
    /** Tesseract is installed: bots can read text on screen (mac_find_text). */
    ocr?: boolean;
    /** Browsers that let ADT Bot use their pages now (remote debugging on, browser open). */
    browsers?: string[];
    /** How the clipboard is reached: wl-clipboard is needed for it on Wayland. */
    clipboard?: "built-in" | "wl-clipboard" | "missing";
    error?: string;
  };
};

export type MacScreenshot = {
  mediaType: string;
  data: string;
  width: number;
  height: number;
  scale: number;
  origin: { x: number; y: number };
  screen: { width: number; height: number; backing: number };
  note?: string;
};

export type MacApp = { name: string; bundleId: string | null; pid: number; active: boolean; hidden: boolean };
export type MacFrontmost = { name: string; bundleId: string | null; pid: number; window: string | null; bounds: { x: number; y: number; width: number; height: number } | null };

/** Electron prefixes IPC errors with "Error invoking remote method …: Error:"; keep the useful part. */
export function cleanError(error: unknown): Error {
  const message = String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  return new Error(message);
}

export async function mac<T>(name: string, payload?: unknown): Promise<T> {
  try {
    return await desktopInvoke<T>(`adt:mac:${name}`, payload);
  } catch (error) {
    throw cleanError(error);
  }
}
