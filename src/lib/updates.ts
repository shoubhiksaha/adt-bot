// App updates (desktop only; electron/features/90-updates.cjs does the work). Web builds update when the
// page reloads, and the Android and iOS apps when a new build is installed.
import { desktopInvoke } from "./desktop";

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error" | "unsupported";

export type UpdateUnsupported = "dev" | "portable" | "linux-package" | "disk-image" | "translocated";

export type UpdateState = {
  appVersion: string;
  /** Why this copy can't update itself (null when it can). */
  unsupported: UpdateUnsupported | null;
  /** "feed" while ADT_UPDATE_FEED points at a test feed. */
  source: "github" | "feed";
  status: UpdateStatus;
  /** The version that's available, downloading or ready. */
  version: string;
  percent: number;
  error: string;
  /** Last successful check (ms), 0 if never. */
  checkedAt: number;
  autoCheck: boolean;
  /** Where the GitHub token is kept: the OS keychain, or only until the app quits (no keyring). */
  token: "keychain" | "session" | null;
  /** The OS keychain can store the token. */
  keychain: boolean;
};

/** The version this build was made from (package.json), for web and mobile. */
export const BUILD_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

export const updates = {
  state: () => desktopInvoke<UpdateState>("adt:updates:state"),
  check: () => desktopInvoke<UpdateState>("adt:updates:check"),
  install: () => desktopInvoke<UpdateState>("adt:updates:install"),
  setAuto: (enabled: boolean) => desktopInvoke<UpdateState>("adt:updates:auto", { enabled }),
  setToken: (token: string) => desktopInvoke<UpdateState>("adt:updates:token", { token }),
};

const UNSUPPORTED: Record<UpdateUnsupported, string> = {
  dev: "Updates work in the installed app, not in a development run.",
  portable: "The portable version can't update itself. Download the new version from the releases page.",
  "linux-package": "This copy can't update itself. Use the AppImage or the .deb package from the releases page.",
  "disk-image": "ADT Bot is running from its disk image. Drag it to the Applications folder and open it from there to get updates.",
  translocated: "macOS is running ADT Bot from a temporary location. Move it to the Applications folder and open it from there to get updates.",
};

/** "5 minutes ago", "yesterday"… */
export function ago(then: number, now = Date.now()): string {
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** One line for Settings → About. */
export function updateSummary(state: UpdateState, now = Date.now()): string {
  if (state.unsupported) return UNSUPPORTED[state.unsupported];
  switch (state.status) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Version ${state.version} is available.`;
    case "downloading":
      return `Downloading version ${state.version}… ${state.percent}%`;
    case "ready":
      return `Restarting to install version ${state.version}…`;
    case "error":
      return state.error || "The last check didn't work.";
    case "current":
      return `You're up to date${state.checkedAt ? ` (checked ${ago(state.checkedAt, now)})` : ""}.`;
    default:
      return state.checkedAt ? `Last checked ${ago(state.checkedAt, now)}.` : "Not checked yet.";
  }
}

/** Which buttons make sense right now. */
export function updateActions(state: UpdateState): { check: boolean; install: boolean } {
  if (state.unsupported) return { check: false, install: false };
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "ready";
  return { check: !busy, install: state.status === "available" };
}

/** Rough shape check before sending a token to the main process (it checks again). */
export function tokenProblem(token: string): string {
  const clean = token.trim();
  if (!clean) return "";
  return /^[A-Za-z0-9_]{20,255}$/.test(clean) ? "" : "That doesn't look like a GitHub token (they start with github_pat_ or ghp_).";
}
