// "Control this PC": the Windows side of computer use. It registers the same "adt:mac:*" IPC
// channels the Mac control feature uses (electron/features/70-mac-control.cjs), so the renderer
// (src/features/mac-control/*) and the approval, taint and Stop-all wiring drive both platforms the
// same way. The tool names stay mac_* for compatibility; what the user and the model read is made
// platform-neutral in the renderer.
//
// All the work happens in a long-lived Windows PowerShell helper (electron/native/win-helper.ps1,
// shipped via electron-builder win.extraResources) that speaks the same JSON-lines protocol as the
// Mac helper, using the in-box UI Automation client: nothing is installed on a Windows 10/11 PC.
// Every user value travels as JSON on the helper's stdin, never spliced into script source.
// Without the script, every call fails with a clear "missing its Windows helper" error.
//
// Helper contract (request {id, cmd, ...} -> reply {id, result} or {id, error, code}):
//   ping -> {trusted, pid, locked, idle}      idle -> {idle}      geometry -> {x, y, width, height, backing}
//   snapshot {app?, window?, query?, max?} -> the Mac snapshot shape (name, pid, window, windows,
//     elements [{id, role, label?, value?, frame, disabled?, focused?, selected?, input?}], matched,
//     truncated, frontmost, note?), roles named as on the Mac ("button", "text field", "row"...)
//   press {element, action} -> {method}      setText {element, text, replace, submit, background}
//     -> {typed, background?, submitted?, reason?, value?, partial?}
//   type {text, app?} -> {typed, to}   key {code? | char?, modifiers, app?} -> {ok, to}
//   click {x, y, button, clicks}   move {x, y}   drag {x, y, toX, toY}   scroll {x, y, dx, dy}
//   cursor -> {x, y}   apps -> {apps: [{name, pid, active, hidden}]}   front -> {name, pid, window, bounds}
//   screenshot {path, region?} -> writes a PNG   open {name} -> {name} (error code "not-found")
// Error codes as on the Mac: "busy" (the user is active), "stale", "not-front", "not-running", "locked".
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_WIDTH,
  SUSPICIOUS_BYTES,
  MAX_TEXT,
  frameFor,
  defaultFrame,
  toScreenPoint,
  toImagePoint,
  clickPayload,
  createHelper,
  APP_LINK,
  openUrl,
  createClipboard,
  electronApi,
} = require("../control-common.cjs");

let SUPPORTED = process.platform === "win32";

// Windows PowerShell (5.1) ships with every Windows 10/11; prefer it over pwsh, which may be absent.
const POWERSHELL = (() => {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const builtin = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(builtin) ? builtin : "powershell.exe";
})();

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

const MODIFIERS = {
  cmd: "command", command: "command", meta: "command", super: "command", win: "command", "⌘": "command",
  shift: "shift", "⇧": "shift",
  opt: "option", option: "option", alt: "option", "⌥": "option",
  ctrl: "control", control: "control", "⌃": "control",
};

/** Keys without a character, as Windows virtual-key codes. */
const KEY_CODES = {
  return: 13, enter: 13, tab: 9, space: 32, spacebar: 32, backspace: 8, delete: 8, escape: 27, esc: 27,
  capslock: 20, insert: 45, help: 47, home: 36, pageup: 33, pgup: 33, forwarddelete: 46, del: 46,
  end: 35, pagedown: 34, pgdn: 34, left: 37, leftarrow: 37, up: 38, uparrow: 38, right: 39, rightarrow: 39,
  down: 40, downarrow: 40,
  f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
  f13: 124, f14: 125, f15: 126, f16: 127, f17: 128, f18: 129, f19: 130,
  volumeup: 175, volumedown: 174, mute: 173,
};

/** "ctrl+shift+t", "enter", "alt-left", "ctrl++" -> modifiers + a key code or one character. */
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
    if (!mod) throw new Error(`Unknown modifier "${part}". Use ctrl, shift, alt or win.`);
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const lower = key.toLowerCase();
  if (parts.length === 1 && MODIFIERS[lower]) throw new Error(`"${key}" on its own does nothing; combine it, e.g. "ctrl+${key}".`);
  const label = [...modifiers, lower.length > 1 ? lower : key].join("+");
  if (KEY_CODES[lower] !== undefined) return { modifiers, keyCode: KEY_CODES[lower], label };
  if ([...key].length === 1) return { modifiers, character: key, label };
  throw new Error(`Unknown key "${key}". Use one character or: ${Object.keys(KEY_CODES).join(", ")}.`);
}

/** The helper payload for a parsed combo: a key code or a character, plus modifier names. */
function keyPayload(parsed, app) {
  const payload = { modifiers: parsed.modifiers };
  if (parsed.keyCode !== undefined) payload.code = parsed.keyCode;
  else payload.char = parsed.character;
  if (app) payload.app = app;
  return payload;
}

// ---------------------------------------------------------------------------------------------
// The helper process and JSON-lines client

function helperPath() {
  const candidates = [path.join(__dirname, "..", "native", "win-helper.ps1")];
  if (process.resourcesPath) candidates.unshift(path.join(process.resourcesPath, "win-helper.ps1"));
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

let helper = null;
/** The helper died before ever answering (no PowerShell, blocked at launch): don't keep retrying this session. */
let helperBroken = false;

/** The helper's argv: a fixed script path, no user values (those go as JSON on stdin). */
function helperArgs(file) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file];
}

function startHelper() {
  const file = helperPath();
  if (!file) return null;
  const child = spawn(POWERSHELL, helperArgs(file), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Its own folder, so a bare program name never resolves to a file in some other working folder.
    cwd: path.dirname(file),
    // ADT Bot's own windows belong to this process: the helper skips them when picking "the app in front".
    env: { ...process.env, ADT_PARENT_PID: String(process.pid) },
  });
  const h = createHelper(child);
  // Keep the end of stderr: a helper that can't start (PowerShell blocked by policy) says why there.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    h.stderr = `${h.stderr ?? ""}${chunk}`.slice(-2000);
  });
  const gone = () => {
    if (!h.answered && !h.killed) helperBroken = true;
    if (helper === h) helper = null;
    const why = String(h.stderr ?? "").trim().split("\n")[0];
    for (const settle of h.pending.values()) settle({ error: `The Windows helper stopped${why ? `: ${why}` : "."}` });
    h.pending.clear();
  };
  child.on("error", gone);
  child.on("exit", gone);
  return h;
}

/** Stops the helper (Stop all, quitting, or a hung call); the next call starts a new one. */
function stopHelper() {
  const h = helper;
  helper = null;
  if (!h) return;
  h.killed = true;
  h.child.kill();
}

const hasHelper = () => SUPPORTED && !helperBroken && Boolean(helper || helperPath());

/** First launch can take ~1 s while PowerShell compiles the helper's native shim. */
function helperCall(cmd, payload, { what, timeoutMs = 15_000 } = {}) {
  if (!SUPPORTED) return Promise.reject(new Error("PC control only works on Windows."));
  if (!helper && !helperBroken) helper = startHelper();
  const h = helper;
  if (!h) {
    const reason = helperBroken ? "its Windows helper couldn't start (PowerShell may be blocked on this PC)" : "this build of ADT Bot is missing its Windows helper (win-helper.ps1)";
    return Promise.reject(new Error(`${what}: ${reason}.`));
  }
  const id = h.next++;
  // A cold start (PowerShell plus compiling the helper's native part) can take several seconds.
  const grace = h.answered ? 0 : 15_000;
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

function ensureWin() {
  if (!SUPPORTED) throw new Error("PC control only works on Windows.");
}

async function ensureUnlocked(what) {
  if (!hasHelper()) return;
  const state = await helperCall("ping", {}, { what, timeoutMs: 8_000 }).catch(() => null);
  if (state?.locked) throw new Error(`${what}: this PC's screen is locked, so apps can't be seen or used. Ask the user to unlock it, then try again.`);
}

// ---------------------------------------------------------------------------------------------
// Geometry and the screenshot frame

let geometryCache = null;
async function geometry() {
  if (geometryCache && Date.now() - geometryCache.at < 15_000) return geometryCache.value;
  const value = await helperCall("geometry", {}, { what: "Reading the screen size", timeoutMs: 10_000 });
  geometryCache = { at: Date.now(), value };
  return value;
}

let lastFrame = null;
async function currentFrame() {
  return lastFrame ?? defaultFrame(await geometry());
}

/** The controls in an app's window (same shape the Mac helper returns), each with its centre in screenshot pixels. */
async function ui({ app: appName, window, query, menus, max } = {}) {
  ensureWin();
  const snap = await helperCall(
    "snapshot",
    { app: appName ? String(appName).slice(0, 200) : undefined, window: window ? String(window).slice(0, 200) : undefined, query: query ? String(query).slice(0, 200) : undefined, menus: menus === true, max: Number(max) || undefined },
    { what: "Reading the app's controls", timeoutMs: 25_000 },
  );
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
  ensureWin();
  if (!PRESS_ACTIONS.has(action)) throw new Error(`action must be one of ${[...PRESS_ACTIONS].join(", ")}.`);
  await ensureUnlocked("Pressing");
  return helperCall("press", { element: Number(element), action }, { what: "Pressing", timeoutMs: 15_000 });
}

async function setText({ element, text, replace = true, submit = false, background = true } = {}) {
  ensureWin();
  const value = String(text ?? "");
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await ensureUnlocked("Typing");
  return helperCall("setText", { element: Number(element), text: value, replace: replace !== false, submit: submit === true, background: background !== false }, { what: "Typing", timeoutMs: 20_000 + value.length * 30 });
}

async function typeText({ text, app: appName } = {}) {
  ensureWin();
  const value = String(text ?? "");
  if (!value) return { ok: true, typed: 0 };
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await ensureUnlocked("Typing");
  const done = await helperCall("type", { text: value, app: appName ? String(appName).slice(0, 200) : undefined }, { what: "Typing", timeoutMs: Math.min(180_000, 20_000 + value.length * 60) });
  return { ok: true, typed: value.length, to: done?.to ?? "front" };
}

async function key({ combo, app: appName } = {}) {
  ensureWin();
  const parsed = parseCombo(combo);
  const what = `Pressing ${parsed.label}`;
  await ensureUnlocked(what);
  const done = await helperCall("key", keyPayload(parsed, appName ? String(appName).slice(0, 200) : undefined), { what });
  return { ok: true, label: parsed.label, to: done?.to ?? "front" };
}

async function click({ x, y, button = "left", clicks = 1, space } = {}) {
  ensureWin();
  await ensureUnlocked("Clicking");
  const p = await pointFor(x, y, space);
  await helperCall("click", clickPayload(p, button, clicks), { what: "Clicking" });
  return { ok: true, screen: p };
}

async function move({ x, y, space } = {}) {
  ensureWin();
  await ensureUnlocked("Moving the pointer");
  const p = await pointFor(x, y, space);
  await helperCall("move", { x: p.x, y: p.y }, { what: "Moving the pointer" });
  return { ok: true, screen: p };
}

async function drag({ x, y, toX, toY, space } = {}) {
  ensureWin();
  await ensureUnlocked("Dragging");
  const a = await pointFor(x, y, space);
  const b = await pointFor(toX, toY, space);
  await helperCall("drag", { x: a.x, y: a.y, toX: b.x, toY: b.y }, { what: "Dragging", timeoutMs: 30_000 });
  return { ok: true, from: a, to: b };
}

async function scroll({ x, y, dx = 0, dy = 0, space } = {}) {
  ensureWin();
  await ensureUnlocked("Scrolling");
  const p = x === undefined || y === undefined ? (await cursor()).screen : await pointFor(x, y, space);
  const sx = Math.max(-5000, Math.min(5000, Math.round(Number(dx) || 0)));
  const sy = Math.max(-5000, Math.min(5000, Math.round(Number(dy) || 0)));
  await helperCall("scroll", { x: p.x, y: p.y, dx: sx, dy: sy }, { what: "Scrolling" });
  return { ok: true, screen: p };
}

async function cursor() {
  ensureWin();
  const p = await helperCall("cursor", {}, { what: "Reading the pointer position" });
  const frame = await currentFrame();
  return { screen: { x: Math.round(p.x), y: Math.round(p.y) }, image: toImagePoint(frame, p.x, p.y) };
}

/** Coordinates are screenshot pixels unless space is "screen" (physical screen pixels). */
async function pointFor(x, y, space) {
  if (space === "screen") return toScreenPoint({ originX: 0, originY: 0, scale: 1 }, x, y);
  return toScreenPoint(await currentFrame(), x, y);
}

/** The helper wraps the list ({apps: [...]}) because PowerShell flattens a one-item array. */
async function listApps() {
  ensureWin();
  const reply = await helperCall("apps", {}, { what: "Listing apps", timeoutMs: 15_000 });
  return Array.isArray(reply?.apps) ? reply.apps : [];
}

async function frontmost() {
  ensureWin();
  return helperCall("front", {}, { what: "Reading the frontmost app" });
}

// ---------------------------------------------------------------------------------------------
// Screenshot: the helper writes a PNG, resized here to a small JPEG, remembering the frame.

async function screenshot({ region, window: frontWindow = false, maxWidth = MAX_WIDTH, format = "jpeg" } = {}) {
  ensureWin();
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
  const raw = path.join(dir, "raw.png");
  const out = path.join(dir, png ? "out.png" : "out.jpg");
  try {
    await helperCall("screenshot", { path: raw, region: frontWindow || region ? rect : undefined }, { what: "Taking a screenshot", timeoutMs: 20_000 });
    const stat = fs.existsSync(raw) ? fs.statSync(raw) : null;
    if (!stat || stat.size < SUSPICIOUS_BYTES) throw new Error("Taking a screenshot: the capture came back empty.");
    const image = electronApi()?.nativeImage?.createFromPath(raw);
    if (!image || image.isEmpty()) throw new Error("Taking a screenshot: the capture couldn't be read.");
    const captured = image.getSize();
    const resized = captured.width > width ? image.resize({ width, quality: "good" }) : image;
    fs.writeFileSync(out, png ? resized.toPNG() : resized.toJPEG(70));
    const size = resized.getSize();
    const frame = frameFor(rect, size.width);
    lastFrame = frame;
    return {
      mediaType: png ? "image/png" : "image/jpeg",
      data: fs.readFileSync(out).toString("base64"),
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
// Opening, quitting and links

/** Files that run code when opened: an "app name" must never be one of these. */
const RUNS_CODE = /\.(bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|msi|msp|com|pif|reg|cpl|jar)$/i;

/**
 * An app's name as the Start menu shows it ("Notepad", "WhatsApp"), never a path, link or script:
 * opening a path or a .bat would run arbitrary files, which isn't what "open an app" means.
 */
function appName(name) {
  const value = String(name ?? "").trim();
  if (!value || value.length > 200 || /[\0\r\n]/.test(value)) throw new Error('Give the app\'s name, e.g. "Notepad".');
  if (/[\\/:*?"<>|]/.test(value) || RUNS_CODE.test(value)) throw new Error('Give the app\'s name as the Start menu shows it, e.g. "Notepad" or "WhatsApp", not a path or file.');
  return value;
}

/**
 * Opens an app by its Start-menu name (Store apps such as WhatsApp included). The helper looks the
 * name up and starts it without a command shell, so nothing in the name is ever parsed as a command.
 */
async function openApp({ name } = {}) {
  ensureWin();
  const value = appName(name);
  const done = await helperCall("open", { name: value }, { what: `Opening ${value}`, timeoutMs: 20_000 }).catch((error) => {
    throw error.code === "not-found" ? new Error(`No app named "${value}" is installed.`) : error;
  });
  return { ok: true, name: done?.name ?? value };
}

async function quitApp({ name } = {}) {
  ensureWin();
  const value = appName(name);
  const apps = await listApps().catch(() => []);
  const want = value.toLowerCase();
  // Only the app named exactly: "c" must not quit every app starting with c.
  const match = apps.filter((a) => a.name?.toLowerCase() === want);
  if (!match.length) throw new Error(`"${name}" isn't running.`);
  // taskkill without /F asks the window to close, like quitting: the app can still ask to save.
  for (const a of match) {
    await new Promise((resolve) => execFile("taskkill.exe", ["/PID", String(a.pid)], { windowsHide: true }, () => resolve()));
  }
  return { ok: true, quit: match.map((a) => a.name) };
}

// ---------------------------------------------------------------------------------------------

/** UI Automation needs no special permission, so these are all "granted"; the shape matches the Mac side. */
async function permissions() {
  return SUPPORTED
    ? { supported: true, platform: "win32", accessibility: true, screenRecording: "granted", automation: "granted", microphone: electronApi()?.systemPreferences?.getMediaAccessStatus?.("microphone") ?? "granted", app: "ADT Bot" }
    : { supported: false, platform: process.platform };
}

exports.register = ({ app, ipcMain, shell, access, onStopAll }) => {
  if (!SUPPORTED) return; // On macOS, electron/features/70-mac-control.cjs owns the adt:mac:* channels.
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
  // Windows asks for no accessibility/automation grant; these keep the renderer's calls harmless.
  handle("openSettings", () => Promise.resolve(false));
  handle("checkAutomation", () => Promise.resolve("granted"));
  handle("requestAccessibility", () => true);
  handle("requestMicrophone", () => Promise.resolve(electronApi()?.systemPreferences?.getMediaAccessStatus?.("microphone") === "granted"));

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
  // Mac-only tools (AppleScript, browser scripting, screen OCR) are not exposed on Windows, but keep
  // a clear error in case an old recipe or a bot calls their channels.
  act("clipboard", (payload) => createClipboard({ clipboard: electronApi()?.clipboard })(payload));
  for (const name of ["applescript", "browser", "findText"]) {
    act(name, () => {
      throw new Error("This isn't available on Windows.");
    });
  }
  app?.on?.("will-quit", stopHelper);
};

exports.stopHelper = stopHelper;

exports._test = {
  get SUPPORTED() {
    return SUPPORTED;
  },
  /** Tests run on macOS/Linux; pretend to be Windows so the action paths can be exercised. */
  setSupported: (value) => {
    SUPPORTED = value;
  },
  POWERSHELL,
  frameFor,
  defaultFrame,
  toScreenPoint,
  toImagePoint,
  parseCombo,
  keyPayload,
  clickPayload,
  APP_LINK,
  appName,
  helperArgs,
  helperPath,
  createHelper,
  permissions,
  ui,
  key,
  click,
  listApps,
  openApp,
  helperCall,
  /** Tests: talk to a fake helper process instead of starting PowerShell. */
  setHelper: (child) => {
    helper = child ? Object.assign(createHelper(child), { answered: true }) : null;
    helperBroken = false;
  },
  resetFrame: () => {
    lastFrame = null;
    geometryCache = null;
  },
};
