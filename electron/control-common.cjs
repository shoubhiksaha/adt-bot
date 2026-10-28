// What "Control this PC" shares between Windows (features/75-win-control.cjs) and Linux
// (features/76-linux-control.cjs): screenshot-to-screen coordinates, the JSON-lines helper client,
// clicks and app links. Pure, apart from the helper's child process.

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

function electronApi() {
  try {
    const e = require("electron");
    return typeof e === "object" && e ? e : null;
  } catch {
    return null;
  }
}

module.exports = { MAX_WIDTH, SUSPICIOUS_BYTES, MAX_TEXT, frameFor, defaultFrame, toScreenPoint, toImagePoint, clickPayload, createHelper, APP_LINK, openUrl, electronApi };
