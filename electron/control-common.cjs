// What "Control this PC" shares between Windows (features/75-win-control.cjs) and Linux
// (features/76-linux-control.cjs): screenshot-to-screen coordinates, the JSON-lines helper client,
// clicks, app links and the clipboard (macOS uses it too). Pure, apart from the helper's child
// process and wl-clipboard.
const { spawn } = require("node:child_process");
const path = require("node:path");

/** Wide enough to read UI text, small enough for a vision model. */
const MAX_WIDTH = 1280;
/** A screenshot file smaller than this came back empty. */
const SUSPICIOUS_BYTES = 1024;
const MAX_TEXT = 20_000;

/** Where image coordinates land on screen: origin (in pixels) and image pixels per screen pixel. */
function frameFor(rect, imageWidth) {
  return { originX: rect.x, originY: rect.y, scale: rect.width > 0 ? imageWidth / rect.width : 1, width: rect.width, height: rect.height };
}

/** The frame a full-screen screenshot would have, used before the first screenshot. */
function defaultFrame(geometry, maxWidth = MAX_WIDTH) {
  const imageWidth = Math.min(maxWidth, Math.round(geometry.width * (geometry.backing || 1)));
  return frameFor({ x: geometry.x || 0, y: geometry.y || 0, width: geometry.width, height: geometry.height }, imageWidth);
}

/** Screenshot pixel -> global screen point. */
function toScreenPoint(frame, x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("x and y must be numbers (pixels in the latest screenshot).");
  return { x: Math.round(frame.originX + nx / frame.scale), y: Math.round(frame.originY + ny / frame.scale) };
}

/** Global screen point -> screenshot pixel. */
function toImagePoint(frame, x, y) {
  return { x: Math.round((x - frame.originX) * frame.scale), y: Math.round((y - frame.originY) * frame.scale) };
}

const BUTTONS = new Set(["left", "right", "middle"]);
function clickPayload(point, button = "left", clicks = 1) {
  if (!BUTTONS.has(button)) throw new Error('button must be "left", "right" or "middle".');
  return { x: point.x, y: point.y, button, clicks: Math.max(1, Math.min(3, Math.round(Number(clicks) || 1))) };
}

/** Wires a child process (one JSON object per line) into a request/reply client. Testable with a fake child. */
function createHelper(child) {
  const h = { child, pending: new Map(), buffer: "", next: 1, answered: false, killed: false };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    h.buffer += chunk;
    let index;
    while ((index = h.buffer.indexOf("\n")) !== -1) {
      const line = h.buffer.slice(0, index);
      h.buffer = h.buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      h.answered = true;
      h.pending.get(message.id)?.(message);
    }
  });
  child.stdin.on("error", () => undefined);
  return h;
}

/** Links that open in an app: web, mail, calls and messages, and apps' own links (whatsapp://…). */
const APP_LINK = /^(https?:\/\/|mailto:|tel:|sms:|callto:|whatsapp:|tg:|slack:|msteams:|zoommtg:|zoomus:|spotify:|ms-[a-z-]+:|notion:|obsidian:|vscode:|discord:|skype:)/i;

async function openUrl(shell, { url } = {}) {
  const value = String(url ?? "").trim();
  if (!APP_LINK.test(value) || value.length > 4000 || /[\0\r\n]/.test(value)) {
    throw new Error("Only web, mail, phone and messaging links, and links for apps like WhatsApp, Slack, Spotify, Zoom or Teams can be opened.");
  }
  await shell.openExternal(value);
  return { ok: true, url: value };
}

/** Most of the clipboard a bot gets back at once. */
const MAX_CLIPBOARD = 50_000;

/** Runs wl-copy (the text on stdin) or wl-paste (the text on stdout). */
function runClipboardTool(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: [input === undefined ? "ignore" : "pipe", input === undefined ? "pipe" : "ignore", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The clipboard didn't answer."));
    }, 10_000);
    child.stdout?.on("data", (d) => {
      if (out.length < MAX_CLIPBOARD * 4) out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // wl-paste's output is all there once it closes; wl-copy forks to serve the text, so its exit counts.
    child.on(input === undefined ? "close" : "exit", (code) => {
      clearTimeout(timer);
      if (input !== undefined) setTimeout(() => child.stderr.destroy(), 100); // wl-copy's server keeps it open
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${path.basename(file)} failed`));
    });
    if (input !== undefined) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
  });
}

/**
 * mac_clipboard: the clipboard's text, through Electron's clipboard on every desktop. On Wayland
 * an app in the background can't reach the clipboard, so there it goes through wl-clipboard
 * (wl-copy, wl-paste) when that's installed. tools: {copy, paste} file paths, or null.
 */
function createClipboard({ clipboard, tools = null, run = runClipboardTool }) {
  async function electronRead() {
    // Electron's clipboard is asynchronous (the web's clipboard API).
    const value = await clipboard.readText();
    if (value) return value;
    const items = await Promise.resolve(clipboard.read?.()).catch(() => []);
    return (items ?? []).some((item) => item.types?.length) ? null : "";
  }
  return async ({ action = "read", text } = {}) => {
    if (action === "read") {
      // wl-clipboard's own answers for an empty clipboard or one without text; anything else
      // (it can't reach the desktop) falls back to Electron's clipboard.
      const value = tools
        ? await run(tools.paste, ["--no-newline", "--type", "text"]).catch((error) => {
            if (/nothing is copied|no selection/i.test(error.message)) return "";
            if (/no suitable type/i.test(error.message)) return null;
            if (clipboard) return electronRead();
            throw error;
          })
        : await electronRead();
      if (value === null) return { text: "", length: 0, notText: true };
      return { text: value.slice(0, MAX_CLIPBOARD), length: value.length, truncated: value.length > MAX_CLIPBOARD };
    }
    if (action === "write") {
      const value = String(text ?? "");
      if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
      if (tools) {
        await run(tools.copy, ["--type", "text/plain;charset=utf-8"], value).catch((error) => {
          if (!clipboard) throw error;
          return clipboard.writeText(value);
        });
      } else await clipboard.writeText(value);
      return { ok: true, length: value.length };
    }
    throw new Error("action must be read or write.");
  };
}

function electronApi() {
  try {
    const e = require("electron");
    return typeof e === "object" && e ? e : null;
  } catch {
    return null;
  }
}

module.exports = { MAX_WIDTH, SUSPICIOUS_BYTES, MAX_TEXT, MAX_CLIPBOARD, frameFor, defaultFrame, toScreenPoint, toImagePoint, clickPayload, createHelper, APP_LINK, openUrl, createClipboard, runClipboardTool, electronApi };
