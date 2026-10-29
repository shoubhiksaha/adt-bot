// "Control this PC": the Linux side of computer use. Like the Windows side (75-win-control.cjs) it
// registers the "adt:mac:*" IPC channels the Mac control feature uses, so the renderer
// (src/features/mac-control/*) and the approval, taint and Stop-all wiring drive every platform the
// same way.
//
// The work happens in a long-lived Python helper (electron/native/linux-helper.py, shipped via
// electron-builder linux.extraResources) speaking the Windows helper's JSON-lines protocol. It reads
// and operates apps through AT-SPI on X11 and Wayland; on X11 it also takes screenshots and drives
// the pointer and keyboard directly (XTest), and on Wayland through the desktop's portals, which ask
// the person once. Every user value travels as JSON on the helper's stdin, never in a command line.
//
// Helper contract (request {id, cmd, ...} -> reply {id, result} or {id, error, code}): as on Windows
// (see 75-win-control.cjs), except
//   ping -> {trusted, pid, locked, idle, session: "x11"|"wayland"|"none", atspi, input, screenshot, missing}
//   key {keysym? | char?, modifiers: ["control"|"shift"|"alt"|"super"], app?}
//   screenshot {path, region?} -> {format: "bgra" (raw pixels, X11) | "png" (Wayland), width?, height?}
//   geometry {hint} -> the main monitor in the points clicks use (hint: Electron's own idea of it)
//   connect -> asks for the pointer and keyboard on Wayland (the desktop's dialog)
// Error codes as on the Mac, plus "missing" (something to install), "needs-approval" and "denied".
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MAX_WIDTH, SUSPICIOUS_BYTES, MAX_TEXT, frameFor, defaultFrame, toScreenPoint, toImagePoint, clickPayload, createHelper, openUrl, electronApi } = require("../control-common.cjs");

let SUPPORTED = process.platform === "linux";

/** The system's Python 3: every desktop Linux ships one (it runs parts of the desktop itself). */
const PYTHON = ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"].find((p) => fs.existsSync(p)) ?? "python3";

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

/** Mac habits work too: cmd+c is ctrl+c here. super/win is the Super key. */
const MODIFIERS = {
  cmd: "control", command: "control", meta: "control", "⌘": "control",
  ctrl: "control", control: "control", "⌃": "control",
  shift: "shift", "⇧": "shift",
  opt: "alt", option: "alt", alt: "alt", "⌥": "alt",
  super: "super", win: "super",
};

/** Keys without a character, as X keysym names. */
const KEY_NAMES = {
  return: "Return", enter: "Return", tab: "Tab", space: "space", spacebar: "space", backspace: "BackSpace", delete: "BackSpace",
  escape: "Escape", esc: "Escape", capslock: "Caps_Lock", insert: "Insert", help: "Help", home: "Home", pageup: "Prior", pgup: "Prior",
  forwarddelete: "Delete", del: "Delete", end: "End", pagedown: "Next", pgdn: "Next", left: "Left", leftarrow: "Left", up: "Up",
  uparrow: "Up", right: "Right", rightarrow: "Right", down: "Down", downarrow: "Down",
  volumeup: "XF86AudioRaiseVolume", volumedown: "XF86AudioLowerVolume", mute: "XF86AudioMute",
  ...Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** "ctrl+shift+t", "enter", "alt-left", "ctrl++" -> modifiers + a keysym name or one character. */
function parseCombo(combo) {
  const raw = String(combo ?? "").trim();
  if (!raw) throw new Error('Give a key, e.g. "enter" or "ctrl+s".');
  if (raw.length > 60) throw new Error("That key combination is too long.");
  const parts = raw.split(/[+-]/).map((p) => p.trim()).filter(Boolean);
  if (/[+-]$/.test(raw)) parts.push(raw.slice(-1));
  if (!parts.length) parts.push(raw);
  const key = parts[parts.length - 1];
  const modifiers = [];
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier "${part}". Use ctrl, shift, alt or super.`);
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const lower = key.toLowerCase();
  if (parts.length === 1 && MODIFIERS[lower]) throw new Error(`"${key}" on its own does nothing; combine it, e.g. "ctrl+${key}".`);
  const label = [...modifiers, lower.length > 1 ? lower : key].join("+");
  if (KEY_NAMES[lower]) return { modifiers, keysym: KEY_NAMES[lower], label };
  if ([...key].length === 1) return { modifiers, character: key, label };
  throw new Error(`Unknown key "${key}". Use one character or: ${Object.keys(KEY_NAMES).join(", ")}.`);
}

function keyPayload(parsed, app) {
  const payload = { modifiers: parsed.modifiers };
  if (parsed.keysym) payload.keysym = parsed.keysym;
  else payload.char = parsed.character;
  if (app) payload.app = app;
  return payload;
}

/**
 * An app's name as its launcher shows it ("Text Editor", "Firefox") or its command ("gedit"), never
 * a path: the helper only starts apps that have a launcher entry, so nothing here is run as a file.
 */
function appName(name) {
  const value = String(name ?? "").trim();
  if (!value || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error('Give the app\'s name, e.g. "Text Editor".');
  if (/[\\/]/.test(value)) throw new Error('Give the app\'s name as its launcher shows it, e.g. "Text Editor" or "Firefox", not a path.');
  return value;
}

/** Python with no user site-packages or environment tweaks, and no .pyc files written. */
function helperArgs(file) {
  return ["-I", "-B", file];
}

/**
 * The helper runs with the system's libraries: an AppImage's own library path (or anything injected
 * with LD_PRELOAD) must not leak into the system Python. Chromium sets NO_AT_BRIDGE=1 for itself;
 * apps the helper opens would inherit it and hide their controls from accessibility tools.
 */
function helperEnv(env, extra) {
  const out = { ...env, ...extra };
  for (const name of ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "GIO_EXTRA_MODULES", "GI_TYPELIB_PATH", "NO_AT_BRIDGE"]) {
    if (env.APPDIR || name !== "LD_LIBRARY_PATH") delete out[name];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The helper process

/** Shipped next to the app (resources/linux-helper.py): Python can't read inside app.asar. */
function helperPath() {
  const candidates = [path.join(__dirname, "..", "native", "linux-helper.py")].filter((file) => !file.includes(".asar"));
  if (process.resourcesPath) candidates.unshift(path.join(process.resourcesPath, "linux-helper.py"));
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

let helper = null;
let helperBroken = false;
let stateDir = path.join(os.homedir(), ".config", "adt-bot", "linux-control");

function startHelper() {
  const file = helperPath();
  if (!file) return null;
  const child = spawn(PYTHON, helperArgs(file), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: path.dirname(file),
    // ADT Bot's own windows belong to this process: the helper never operates them.
    env: helperEnv(process.env, { ADT_PARENT_PID: String(process.pid), ADT_STATE_DIR: stateDir }),
  });
  const h = createHelper(child);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    h.stderr = `${h.stderr ?? ""}${chunk}`.slice(-2000);
  });
  const gone = () => {
    if (!h.answered && !h.killed) helperBroken = true;
    if (helper === h) helper = null;
    const why = String(h.stderr ?? "").trim().split("\n").pop();
    for (const settle of h.pending.values()) settle({ error: `The Linux helper stopped${why ? `: ${why}` : "."}` });
    h.pending.clear();
  };
  child.on("error", gone);
  child.on("exit", gone);
  return h;
}

/** Stops the helper (Stop all, quitting, or a hung call): that also ends a Wayland control session. */
function stopHelper() {
  const h = helper;
  helper = null;
  if (!h) return;
  h.killed = true;
  h.child.kill();
}

const hasHelper = () => SUPPORTED && !helperBroken && Boolean(helper || helperPath());

function helperCall(cmd, payload, { what, timeoutMs = 15_000 } = {}) {
  if (!SUPPORTED) return Promise.reject(new Error("This only works on Linux."));
  if (!helper && !helperBroken) helper = startHelper();
  const h = helper;
  if (!h) {
    const reason = helperBroken ? "its Linux helper couldn't start (is python3 installed?)" : "this build of ADT Bot is missing its Linux helper (linux-helper.py)";
    return Promise.reject(new Error(`${what}: ${reason}.`));
  }
  const id = h.next++;
  const grace = h.answered ? 0 : 5_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      if (helper === h) stopHelper();
      reject(new Error(`${what} timed out: the app isn't responding.`));
    }, timeoutMs + grace);
    h.pending.set(id, (message) => {
      clearTimeout(timer);
      h.pending.delete(id);
      if (message.error === undefined) return resolve(message.result);
      reject(Object.assign(new Error(message.error), { code: message.code ?? undefined }));
    });
    h.child.stdin.write(`${JSON.stringify({ ...payload, id, cmd })}\n`);
  });
}

function ensureLinux() {
  if (!SUPPORTED) throw new Error("This only works on Linux.");
}

/** "x11" or "wayland", as the helper last saw it. */
let session = "unknown";

async function ensureUnlocked(what) {
  if (!hasHelper()) return;
  const state = await helperCall("ping", {}, { what, timeoutMs: 8_000 }).catch(() => null);
  if (state?.session) session = state.session;
  if (state?.locked) throw new Error(`${what}: this PC's screen is locked, so apps can't be seen or used. Ask the user to unlock it, then try again.`);
}

// ---------------------------------------------------------------------------------------------
// Geometry and the screenshot frame

/** Electron's idea of the main display, in the points the desktop uses (and pixels per point). */
function electronDisplay() {
  const screen = electronApi()?.screen;
  const display = screen?.getPrimaryDisplay?.();
  if (!display) return null;
  return { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, backing: display.scaleFactor || 1 };
}

/** Every display together, in points: a Wayland screenshot shows all of them. */
function electronDesktop() {
  const displays = electronApi()?.screen?.getAllDisplays?.() ?? [];
  if (!displays.length) return null;
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

let geometryCache = null;
async function geometry() {
  if (geometryCache && Date.now() - geometryCache.at < 15_000) return geometryCache.value;
  const value = await helperCall("geometry", { hint: electronDisplay() ?? undefined }, { what: "Reading the screen size", timeoutMs: 10_000 });
  geometryCache = { at: Date.now(), value };
  return value;
}

let lastFrame = null;
async function currentFrame() {
  return lastFrame ?? defaultFrame(await geometry());
}

// ---------------------------------------------------------------------------------------------
// Looking and acting

async function ui({ app: appName, window, query, menus, max } = {}) {
  ensureLinux();
  const snap = await helperCall(
    "snapshot",
    { app: appName ? String(appName).slice(0, 200) : undefined, window: window ? String(window).slice(0, 200) : undefined, query: query ? String(query).slice(0, 200) : undefined, menus: menus === true, max: Number(max) || undefined },
    { what: "Reading the app's controls", timeoutMs: 25_000 },
  );
  if (ownWindowInFront()) snap.frontmost = false;
  const frame = await currentFrame();
  const width = frame.width * frame.scale;
  const height = frame.height * frame.scale;
  for (const e of snap.elements ?? []) {
    if (!e.frame) continue;
    const c = toImagePoint(frame, e.frame.x + e.frame.w / 2, e.frame.y + e.frame.h / 2);
    if (c.x >= 0 && c.y >= 0 && c.x <= width && c.y <= height) e.at = c;
  }
  return snap;
}

const PRESS_ACTIONS = new Set(["press", "click", "double_click", "right_click", "focus"]);
async function pressElement({ element, action = "press" } = {}) {
  ensureLinux();
  if (!PRESS_ACTIONS.has(action)) throw new Error(`action must be one of ${[...PRESS_ACTIONS].join(", ")}.`);
  await ensureUnlocked("Pressing");
  return helperCall("press", { element: Number(element), action }, { what: "Pressing", timeoutMs: 15_000 });
}

async function setText({ element, text, replace = true, submit = false, background = true } = {}) {
  ensureLinux();
  const value = String(text ?? "");
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await ensureUnlocked("Typing");
  return helperCall("setText", { element: Number(element), text: value, replace: replace !== false, submit: submit === true, background: background !== false }, { what: "Typing", timeoutMs: 20_000 + value.length * 30 });
}

let browserWindow = () => electronApi()?.BrowserWindow;

/** An ADT Bot window has the keyboard (Electron knows; AT-SPI often can't tell on Wayland). */
function adtFocused() {
  return Boolean(browserWindow()?.getFocusedWindow?.());
}

/**
 * On Wayland, AT-SPI's "active" window lags behind (the app the user left still says it's in front),
 * so while an ADT Bot window has the keyboard, that's what's in front: the app list and the key tools agree.
 */
function ownWindowInFront() {
  return session === "wayland" && adtFocused();
}

/**
 * Keys meant for the app in front would go to ADT Bot itself (its chat box, its approval cards).
 * On X11 the helper brings a named app forward first; Wayland can't, so there it's refused too.
 */
function refuseKeysToSelf(what, appName) {
  if (adtFocused() && (!appName || session === "wayland")) {
    throw Object.assign(new Error(`${what} would go to ADT Bot, which is in front. ${session === "wayland" ? "Click the app's window first (mac_click), or ask the user to switch to it." : 'Name the app to send it to (app: "Text Editor"), or open it first.'}`), { code: "self" });
  }
}

/** Replies from the page that its pointer shield is up or down (preload.cjs), by webContents id. */
const shieldAcks = new Map();
let shieldAckListening = false;
function shieldAck(senderId) {
  shieldAcks.get(senderId)?.();
}

function setShield(contents, on) {
  if (!shieldAckListening) {
    electronApi()?.ipcMain?.on("adt-shield-ack", (event) => shieldAck(event.sender.id));
    shieldAckListening = true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), 500);
    const done = (acked) => {
      clearTimeout(timer);
      shieldAcks.delete(contents.id);
      resolve(acked);
    };
    shieldAcks.set(contents.id, () => done(true));
    contents.send("adt-shield", on);
  });
}

/** Input events that would press or scroll something. */
const POINTER_PRESSES = new Set(["mouseDown", "mouseUp", "mouseWheel", "contextMenu", "touchStart", "touchEnd"]);

/**
 * While a bot's click, drag, scroll or keys run, ADT Bot's own windows take none of it: the page drops
 * pointer input (preload.cjs) and keys stop before the page or its menus see them. Wayland doesn't say
 * where windows are, so this is what keeps a bot off an Allow button or a setting there (on X11 the
 * helper checks the point too). If any of it reached ADT Bot, the bot is told it went nowhere.
 */
async function shieldOwnWindows(kind, fn) {
  const contents = (browserWindow()?.getAllWindows?.() ?? []).filter((w) => !w.isDestroyed()).map((w) => w.webContents);
  let hits = 0;
  const onKey = (event) => {
    event.preventDefault();
    hits++;
  };
  const onInput = (_event, input) => {
    if (POINTER_PRESSES.has(input?.type)) hits++;
  };
  const raised = await Promise.all(contents.map((wc) => setShield(wc, true)));
  for (const wc of contents) {
    wc.on("before-input-event", onKey);
    wc.on("input-event", onInput);
  }
  let result;
  let failure;
  try {
    // A page that didn't answer can't drop clicks: then the helper refuses while ADT Bot is in front.
    result = await fn(raised.every(Boolean));
  } catch (error) {
    failure = error;
  }
  // A moment for the desktop to deliver the last event before ADT Bot takes input again.
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const wc of contents) {
    if (wc.isDestroyed()) continue;
    wc.off("before-input-event", onKey);
    wc.off("input-event", onInput);
    void setShield(wc, false);
  }
  if (failure) throw failure;
  if (hits) {
    const message =
      kind === "keys"
        ? "That went to ADT Bot (it has the keyboard), so it was stopped. Click the app's window first (mac_click), or ask the user to switch to it."
        : "That spot is on ADT Bot's own window, so it was stopped: bots can't use ADT Bot's buttons. Use a spot where the app shows, or ask the user to move ADT Bot aside or switch to the app.";
    throw Object.assign(new Error(message), { code: "self" });
  }
  return result;
}

async function typeText({ text, app: appName } = {}) {
  ensureLinux();
  const value = String(text ?? "");
  if (!value) return { ok: true, typed: 0 };
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await ensureUnlocked("Typing");
  refuseKeysToSelf("Typing", appName);
  const done = await shieldOwnWindows("keys", () => helperCall("type", { text: value, app: appName ? String(appName).slice(0, 200) : undefined }, { what: "Typing", timeoutMs: Math.min(180_000, 20_000 + value.length * 60) }));
  return { ok: true, typed: value.length, to: done?.to ?? "front" };
}

async function key({ combo, app: appName } = {}) {
  ensureLinux();
  const parsed = parseCombo(combo);
  const what = `Pressing ${parsed.label}`;
  await ensureUnlocked(what);
  refuseKeysToSelf("The key", appName);
  const done = await shieldOwnWindows("keys", () => helperCall("key", keyPayload(parsed, appName ? String(appName).slice(0, 200) : undefined), { what }));
  return { ok: true, label: parsed.label, to: done?.to ?? "front" };
}

/** Coordinates are screenshot pixels unless space is "screen" (the desktop's own points). */
async function pointFor(x, y, space) {
  if (space === "screen") return toScreenPoint({ originX: 0, originY: 0, scale: 1 }, x, y);
  return toScreenPoint(await currentFrame(), x, y);
}

async function click({ x, y, button = "left", clicks = 1, space } = {}) {
  ensureLinux();
  await ensureUnlocked("Clicking");
  const p = await pointFor(x, y, space);
  await shieldOwnWindows("pointer", (shielded) => helperCall("click", { ...clickPayload(p, button, clicks), shielded }, { what: "Clicking" }));
  return { ok: true, screen: p };
}

async function move({ x, y, space } = {}) {
  ensureLinux();
  await ensureUnlocked("Moving the pointer");
  const p = await pointFor(x, y, space);
  await helperCall("move", { x: p.x, y: p.y }, { what: "Moving the pointer" });
  return { ok: true, screen: p };
}

async function drag({ x, y, toX, toY, space } = {}) {
  ensureLinux();
  await ensureUnlocked("Dragging");
  const a = await pointFor(x, y, space);
  const b = await pointFor(toX, toY, space);
  await shieldOwnWindows("pointer", (shielded) => helperCall("drag", { x: a.x, y: a.y, toX: b.x, toY: b.y, shielded }, { what: "Dragging", timeoutMs: 30_000 }));
  return { ok: true, from: a, to: b };
}

async function scroll({ x, y, dx = 0, dy = 0, space } = {}) {
  ensureLinux();
  await ensureUnlocked("Scrolling");
  const p = x === undefined || y === undefined ? (await cursor()).screen : await pointFor(x, y, space);
  const sx = Math.max(-5000, Math.min(5000, Math.round(Number(dx) || 0)));
  const sy = Math.max(-5000, Math.min(5000, Math.round(Number(dy) || 0)));
  await shieldOwnWindows("pointer", () => helperCall("scroll", { x: p.x, y: p.y, dx: sx, dy: sy }, { what: "Scrolling" }));
  return { ok: true, screen: p };
}

async function cursor() {
  ensureLinux();
  const p = await helperCall("cursor", {}, { what: "Reading the pointer position" });
  const frame = await currentFrame();
  return { screen: { x: Math.round(p.x), y: Math.round(p.y) }, image: toImagePoint(frame, p.x, p.y) };
}

async function listApps() {
  ensureLinux();
  const reply = await helperCall("apps", {}, { what: "Listing apps", timeoutMs: 15_000 });
  const apps = Array.isArray(reply?.apps) ? reply.apps : [];
  return ownWindowInFront() ? apps.map((a) => ({ ...a, active: false })) : apps;
}

async function frontmost() {
  ensureLinux();
  if (ownWindowInFront()) {
    return { name: "ADT Bot", bundleId: null, pid: process.pid, window: browserWindow()?.getFocusedWindow?.()?.getTitle?.() || "ADT Bot", bounds: null };
  }
  return helperCall("front", {}, { what: "Reading the frontmost app" });
}

// ---------------------------------------------------------------------------------------------
// Screenshot: raw pixels (X11) or a PNG (Wayland's portal), resized to a small JPEG, remembering
// the frame so later clicks land where the model points.

/** The part of a whole-desktop image that is the wanted rectangle (points), in image pixels. */
function cropFor(rect, desktop, imageSize) {
  const scale = imageSize.width / desktop.width;
  const x = Math.max(0, Math.round((rect.x - desktop.x) * scale));
  const y = Math.max(0, Math.round((rect.y - desktop.y) * scale));
  return { x, y, width: Math.min(imageSize.width - x, Math.round(rect.width * scale)), height: Math.min(imageSize.height - y, Math.round(rect.height * scale)) };
}

async function screenshot({ region, window: frontWindow = false, maxWidth = MAX_WIDTH, format = "jpeg" } = {}) {
  ensureLinux();
  await ensureUnlocked("Taking a screenshot");
  const geo = await geometry();
  let rect = { x: geo.x || 0, y: geo.y || 0, width: geo.width, height: geo.height };
  let note = "";
  if (frontWindow) {
    const front = await frontmost().catch(() => null);
    if (front?.bounds && front.bounds.width > 0) rect = front.bounds;
    else note = "Couldn't read the front window's position; captured the whole screen.";
  } else if (region) {
    const frame = await currentFrame();
    const a = toScreenPoint(frame, region.x, region.y);
    const b = toScreenPoint(frame, Number(region.x) + Number(region.width), Number(region.y) + Number(region.height));
    if (b.x - a.x < 4 || b.y - a.y < 4) throw new Error("The region is too small.");
    rect = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }
  const width = Math.max(200, Math.min(2560, Math.round(Number(maxWidth) || MAX_WIDTH)));
  const png = format === "png";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adt-shot-"));
  const raw = path.join(dir, "raw");
  try {
    const shot = await helperCall("screenshot", { path: raw, region: frontWindow || region ? rect : undefined }, { what: "Taking a screenshot", timeoutMs: 60_000 });
    const stat = fs.existsSync(raw) ? fs.statSync(raw) : null;
    if (!stat || stat.size < SUSPICIOUS_BYTES) throw new Error("Taking a screenshot: the capture came back empty.");
    const native = electronApi()?.nativeImage;
    let image = shot.format === "bgra" ? native?.createFromBitmap(fs.readFileSync(raw), { width: shot.width, height: shot.height }) : native?.createFromPath(raw);
    if (!image || image.isEmpty()) throw new Error("Taking a screenshot: the capture couldn't be read.");
    if (shot.format === "png") {
      // The portal shows the whole desktop: keep the main display, the window or the region.
      const desktop = electronDesktop() ?? rect;
      const crop = cropFor(rect, desktop, image.getSize());
      if (crop.width > 0 && crop.height > 0 && (crop.width < image.getSize().width || crop.height < image.getSize().height)) image = image.crop(crop);
    }
    const captured = image.getSize();
    const resized = captured.width > width ? image.resize({ width, quality: "good" }) : image;
    const out = png ? resized.toPNG() : resized.toJPEG(70);
    const size = resized.getSize();
    const frame = frameFor(rect, size.width);
    lastFrame = frame;
    if (shot.format === "png" && rect.width > 0) geometryCache = { at: Date.now(), value: { ...geo, backing: captured.width / rect.width } };
    return {
      mediaType: png ? "image/png" : "image/jpeg",
      data: out.toString("base64"),
      width: size.width,
      height: size.height,
      scale: frame.scale,
      origin: { x: rect.x, y: rect.y },
      screen: { width: geo.width, height: geo.height, backing: geo.backing },
      note: note || undefined,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Reading text on screen: Tesseract, if it's installed (sudo apt install tesseract-ocr), on a
// full-size screenshot. Nothing leaves the PC.

/** Where Tesseract is, or null. */
function tesseractPath() {
  const dirs = [...String(process.env.PATH ?? "").split(":"), "/usr/bin", "/usr/local/bin", "/snap/bin"].filter(Boolean);
  for (const dir of new Set(dirs)) {
    const file = path.join(dir, "tesseract");
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Tesseract's TSV (one row per word) -> lines of text with their centre and confidence, in image pixels. */
function ocrLines(tsv) {
  const lines = new Map();
  for (const row of String(tsv ?? "").split("\n").slice(1)) {
    // level page block paragraph line word left top width height conf text
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = c.slice(11).join(" ").trim();
    const conf = Number(c[10]);
    const [left, top, width, height] = c.slice(6, 10).map(Number);
    if (!text || !(conf >= 0) || ![left, top, width, height].every(Number.isFinite)) continue;
    const key = `${c[2]}.${c[3]}.${c[4]}`;
    const line = lines.get(key) ?? { words: [], conf: 0, x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    line.words.push(text);
    line.conf += conf;
    line.x1 = Math.min(line.x1, left);
    line.y1 = Math.min(line.y1, top);
    line.x2 = Math.max(line.x2, left + width);
    line.y2 = Math.max(line.y2, top + height);
    lines.set(key, line);
  }
  return [...lines.values()]
    .map((l) => ({ text: l.words.join(" "), confidence: Math.round(l.conf / l.words.length) / 100, x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 }))
    .filter((l) => /[\p{L}\p{N}]/u.test(l.text));
}

function runTesseract(program, file, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [file, "stdout", "--psm", "11", "tsv"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Reading text on screen took too long."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`Reading text on screen failed: ${err.trim().split("\n").pop() || `Tesseract exited with ${code}`}`));
    });
  });
}

async function findText({ fast } = {}) {
  ensureLinux();
  const program = tesseractPath();
  if (!program) throw Object.assign(new Error("Reading text on screen needs Tesseract, which isn't installed. The user can install it: sudo apt install tesseract-ocr (Fedora: sudo dnf install tesseract)."), { code: "missing" });
  // A full-size capture reads small text better; the bot's own screenshot frame stays as it was.
  const previous = lastFrame;
  let shot;
  let ocrFrame;
  try {
    shot = await screenshot({ format: "png", maxWidth: fast === true ? MAX_WIDTH : 2560 });
    ocrFrame = lastFrame;
  } finally {
    lastFrame = previous;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adt-ocr-"));
  try {
    const file = path.join(dir, "screen.png");
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    const tsv = await runTesseract(program, file);
    const frame = await currentFrame();
    const lines = ocrLines(tsv).map((l) => {
      const screen = toScreenPoint(ocrFrame, l.x, l.y);
      return { text: l.text, confidence: l.confidence, at: toImagePoint(frame, screen.x, screen.y), screen };
    });
    return { lines, screen: shot.screen };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Opening and quitting apps

async function openApp({ name } = {}) {
  ensureLinux();
  const value = appName(name);
  const done = await helperCall("open", { name: value }, { what: `Opening ${value}`, timeoutMs: 20_000 }).catch((error) => {
    throw error.code === "not-found" ? new Error(`No app named "${value}" is installed.`) : error;
  });
  return { ok: true, name: done?.name ?? value };
}

/** Asks the app to quit (SIGTERM, like closing it): it can still save or ask first. */
async function quitApp({ name } = {}) {
  ensureLinux();
  const value = appName(name);
  // The helper matches the name like everything else ("Calculator" -> gnome-calculator), never ADT Bot.
  const found = await helperCall("find", { name: value }, { what: `Quitting ${value}` }).catch((error) => {
    throw error.code === "not-running" ? new Error(`"${value}" isn't running.`) : error;
  });
  if (!found?.pid || found.pid === process.pid) throw new Error(`"${value}" isn't running.`);
  try {
    process.kill(found.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  return { ok: true, quit: [found.name] };
}

// ---------------------------------------------------------------------------------------------

/** What works on this desktop: the session, AT-SPI, and how screenshots and input are done. */
async function permissions() {
  if (!SUPPORTED) return { supported: false, platform: process.platform };
  const caps = hasHelper() ? await helperCall("ping", {}, { what: "Checking this PC", timeoutMs: 10_000 }).catch((error) => ({ error: error.message })) : { error: "missing helper" };
  if (caps.session) session = caps.session;
  return {
    supported: true,
    platform: "linux",
    linux: {
      session: caps.session ?? "unknown",
      atspi: caps.atspi === true,
      input: caps.input ?? "none",
      screenshot: caps.screenshot ?? "none",
      missing: Array.isArray(caps.missing) ? caps.missing : [],
      ocr: Boolean(tesseractPath()),
      error: caps.error,
    },
    accessibility: caps.atspi === true,
    screenRecording: caps.screenshot && caps.screenshot !== "none" ? "granted" : "denied",
    automation: "granted",
    microphone: "granted",
    app: "ADT Bot",
  };
}

exports.register = ({ app, ipcMain, shell, access, onStopAll, userData }) => {
  if (!SUPPORTED) return; // macOS and Windows have their own (70-mac-control.cjs, 75-win-control.cjs).
  if (userData) stateDir = path.join(userData, "linux-control");
  onStopAll?.(stopHelper);
  const handle = (name, fn) => ipcMain.handle(`adt:mac:${name}`, (_e, payload) => fn(payload ?? {}));
  /** Anything that acts on the PC is off in Sandbox mode (looking and permissions still work). */
  const act = (name, fn) =>
    handle(name, (payload) => {
      if (access?.mode === "sandbox") throw new Error("Computer access is set to Sandbox, so bots can't control this PC.");
      return fn(payload);
    });

  handle("status", async () => ({ ...(await permissions()), screen: await geometry().catch(() => null) }));
  handle("permissions", permissions);
  handle("helper", () => ({ available: hasHelper() }));
  handle("idle", () => (hasHelper() ? helperCall("idle", {}, { what: "Checking activity", timeoutMs: 5_000 }) : { idle: null }));
  handle("screenshot", screenshot);
  handle("cursor", cursor);
  handle("apps", listApps);
  handle("frontmost", frontmost);
  handle("relaunch", () => {
    app?.relaunch();
    app?.exit(0);
  });
  // Wayland: the desktop's own dialog for the pointer and keyboard (remembered after the first OK).
  handle("connect", () => helperCall("connect", {}, { what: "Asking for control", timeoutMs: 200_000 }));
  handle("openSettings", () => Promise.resolve(false));
  handle("checkAutomation", () => Promise.resolve("granted"));
  handle("requestAccessibility", () => true);
  handle("requestMicrophone", () => Promise.resolve(true));

  act("ui", ui);
  act("press", pressElement);
  act("setText", setText);
  act("type", typeText);
  act("key", key);
  act("click", click);
  act("move", move);
  act("drag", drag);
  act("scroll", scroll);
  act("open", openApp);
  act("quit", quitApp);
  act("openUrl", (payload) => openUrl(shell, payload));
  handle("findText", findText);
  for (const name of ["applescript", "browser"]) {
    act(name, () => {
      throw new Error("This isn't available on Linux.");
    });
  }
  app?.on?.("will-quit", stopHelper);
};

exports.stopHelper = stopHelper;

exports._test = {
  get SUPPORTED() {
    return SUPPORTED;
  },
  setSupported: (value) => {
    SUPPORTED = value;
  },
  PYTHON,
  parseCombo,
  keyPayload,
  appName,
  helperArgs,
  helperEnv,
  helperPath,
  cropFor,
  ocrLines,
  findText,
  permissions,
  ui,
  typeText,
  key,
  click,
  screenshot,
  listApps,
  frontmost,
  openApp,
  quitApp,
  helperCall,
  shieldAck,
  setBrowserWindow: (fake) => {
    browserWindow = fake ? () => fake : () => electronApi()?.BrowserWindow;
  },
  setHelper: (child) => {
    helper = child ? Object.assign(createHelper(child), { answered: true }) : null;
    helperBroken = false;
  },
  resetFrame: () => {
    lastFrame = null;
    geometryCache = null;
    session = "unknown";
  },
};
