// "Control your Mac": screenshots, pointer, keyboard and apps for bots (computer use).
// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors
// (CoreGraphics JXA scripts, key map, permission detection), reworked so that every user value
// travels as an argv entry to osascript/JXA: nothing the model sends is ever spliced into script
// source. Every call is approved in the app first (src/lib/agent/approvals.ts); this side executes.
const { execFile, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OSASCRIPT = "/usr/bin/osascript";
const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";
const OPEN = "/usr/bin/open";
/** Wide enough to read UI text, small enough for a vision model. */
const MAX_WIDTH = 1280;
/** A real capture is never this small; a blocked one often is. */
const SUSPICIOUS_BYTES = 1024;
const MAX_TEXT = 20_000;
const MAX_SCRIPT = 100_000;

const SUPPORTED = process.platform === "darwin";

/** Deep links to the right System Settings pane. */
const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};
const PANE_LABEL = {
  accessibility: "Privacy & Security → Accessibility",
  "screen-recording": "Privacy & Security → Screen & System Audio Recording",
  automation: "Privacy & Security → Automation",
  microphone: "Privacy & Security → Microphone",
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

/** osascript argv: the script is fixed source, user values come after "--" so none can be read as options. */
function osascriptArgs(source, values = [], language = "JavaScript") {
  return ["-l", language, "-e", source, "--", ...values.map((v) => String(v))];
}

/**
 * Where image coordinates land on screen. A frame says which part of the screen an image shows
 * (origin, in display points) and how many image pixels there are per point.
 */
function frameFor(rect, imageWidth) {
  return { originX: rect.x, originY: rect.y, scale: rect.width > 0 ? imageWidth / rect.width : 1, width: rect.width, height: rect.height };
}

/** The frame a full-screen screenshot would have, used before the first screenshot. */
function defaultFrame(geometry, maxWidth = MAX_WIDTH) {
  const imageWidth = Math.min(maxWidth, Math.round(geometry.width * (geometry.backing || 1)));
  return frameFor({ x: 0, y: 0, width: geometry.width, height: geometry.height }, imageWidth);
}

/** Screenshot pixel → global display point. */
function toScreenPoint(frame, x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("x and y must be numbers (pixels in the latest screenshot).");
  return { x: Math.round(frame.originX + nx / frame.scale), y: Math.round(frame.originY + ny / frame.scale) };
}

/** Global display point → screenshot pixel. */
function toImagePoint(frame, x, y) {
  return { x: Math.round((x - frame.originX) * frame.scale), y: Math.round((y - frame.originY) * frame.scale) };
}

const MODIFIERS = {
  cmd: "command", command: "command", meta: "command", super: "command", win: "command", "⌘": "command",
  shift: "shift", "⇧": "shift",
  opt: "option", option: "option", alt: "option", "⌥": "option",
  ctrl: "control", control: "control", "⌃": "control",
};

/** Keys without a character, as macOS virtual key codes (Carbon kVK_*). */
const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, spacebar: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  capslock: 57, keypadenter: 76, help: 114, home: 115, pageup: 116, pgup: 116, forwarddelete: 117, del: 117,
  end: 119, pagedown: 121, pgdn: 121, left: 123, leftarrow: 123, right: 124, rightarrow: 124, down: 125,
  downarrow: 125, up: 126, uparrow: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80,
  volumeup: 72, volumedown: 73, mute: 74,
};

/** "cmd+shift+4", "enter", "ctrl-alt-left", "cmd++" → modifiers + a key code or one character. */
function parseCombo(combo) {
  const raw = String(combo ?? "").trim();
  if (!raw) throw new Error("Give a key, e.g. \"enter\" or \"cmd+s\".");
  if (raw.length > 60) throw new Error("That key combination is too long.");
  const parts = raw.split(/[+-]/).map((p) => p.trim()).filter(Boolean);
  if (/[+-]$/.test(raw)) parts.push(raw.slice(-1));
  if (!parts.length) parts.push(raw);
  const key = parts[parts.length - 1];
  const modifiers = [];
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier "${part}". Use cmd, shift, option/alt or ctrl.`);
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const lower = key.toLowerCase();
  if (parts.length === 1 && MODIFIERS[lower]) throw new Error(`"${key}" on its own does nothing; combine it, e.g. "cmd+${key}".`);
  const label = [...modifiers, lower.length > 1 ? lower : key].join("+");
  if (KEY_CODES[lower] !== undefined) return { modifiers, keyCode: KEY_CODES[lower], label };
  if ([...key].length === 1) return { modifiers, character: key, label };
  throw new Error(`Unknown key "${key}". Use one character or: ${Object.keys(KEY_CODES).join(", ")}.`);
}

/** argv for KEY_JXA. */
function keyArgs(parsed) {
  return parsed.keyCode !== undefined
    ? ["code", String(parsed.keyCode), parsed.modifiers.join(",")]
    : ["char", parsed.character, parsed.modifiers.join(",")];
}

const BUTTONS = { left: 0, right: 1, middle: 2 };

/** argv for CLICK_JXA. */
function clickArgs(point, button = "left", clicks = 1) {
  const b = BUTTONS[button];
  if (b === undefined) throw new Error('button must be "left", "right" or "middle".');
  const n = Math.max(1, Math.min(3, Math.round(Number(clicks) || 1)));
  return [String(point.x), String(point.y), String(b), String(n)];
}

/** Which permission a failed osascript/screencapture run is missing. */
function detectPermission(stderr) {
  const text = String(stderr ?? "");
  if (/not allowed assistive access|not allowed to send keystrokes|\(-(?:1719|25211)\)|osascript is not allowed/i.test(text)) return "accessibility";
  if (/not authori[sz](?:ed|ing) to send apple events|\(-1743\)/i.test(text)) return "automation";
  if (/screencapture: cannot run|not authori[sz]ed to capture|screen recording permission|could not create image from display/i.test(text)) return "screen-recording";
  return undefined;
}

function hostAppLabel() {
  const bundle = /\/([^/]+)\.app\//.exec(process.execPath ?? "");
  return bundle ? bundle[1] : "ADT Bot (during development: \"Electron\" or your terminal)";
}

function permissionError(permission, what) {
  return new Error(
    `${what}: macOS blocked this. Turn on "${hostAppLabel()}" in System Settings → ${PANE_LABEL[permission]} ` +
      "(Settings → Computer control has a button for it)." +
      (permission === "screen-recording" ? " macOS applies a new Screen Recording grant only after the app is restarted." : ""),
  );
}

// ---------------------------------------------------------------------------------------------
// Scripts. Each defines run(argv) and reads its inputs from argv only.

const CG_PRELUDE = `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function pause(s) { $.NSThread.sleepForTimeInterval(s); }
function pt(x, y) { return { x: x, y: y }; }
`;

// CGEvent types: 1 leftDown 2 leftUp 3 rightDown 4 rightUp 5 moved 6 leftDragged 25 otherDown 26 otherUp.
// Field 1 = click state (1 single, 2 double). Tap 0 = kCGHIDEventTap.
const MOVE_JXA = `${CG_PRELUDE}
function run(argv) {
  var e = $.CGEventCreateMouseEvent($(), 5, pt(parseFloat(argv[0]), parseFloat(argv[1])), 0);
  if (!e) throw new Error('CGEventCreateMouseEvent unavailable');
  $.CGEventPost(0, e);
  return 'ok';
}`;

const CURSOR_JXA = `${CG_PRELUDE}
function run() {
  var p = $.CGEventGetLocation($.CGEventCreate($()));
  return JSON.stringify({ x: p.x, y: p.y });
}`;

const CLICK_JXA = `${CG_PRELUDE}
function run(argv) {
  var p = pt(parseFloat(argv[0]), parseFloat(argv[1]));
  var button = parseInt(argv[2], 10) || 0;
  var clicks = Math.max(1, Math.min(3, parseInt(argv[3], 10) || 1));
  var downType = button === 1 ? 3 : button === 2 ? 25 : 1;
  var upType = button === 1 ? 4 : button === 2 ? 26 : 2;
  var move = $.CGEventCreateMouseEvent($(), 5, p, button);
  if (!move) throw new Error('CGEventCreateMouseEvent unavailable');
  $.CGEventPost(0, move);
  pause(0.03);
  for (var i = 1; i <= clicks; i++) {
    var down = $.CGEventCreateMouseEvent($(), downType, p, button);
    $.CGEventSetIntegerValueField(down, 1, i);
    $.CGEventPost(0, down);
    pause(0.01);
    var up = $.CGEventCreateMouseEvent($(), upType, p, button);
    $.CGEventSetIntegerValueField(up, 1, i);
    $.CGEventPost(0, up);
    if (i < clicks) pause(0.05);
  }
  return 'ok';
}`;

const SCROLL_JXA = `${CG_PRELUDE}
function run(argv) {
  var p = pt(parseFloat(argv[0]), parseFloat(argv[1]));
  var dx = parseInt(argv[2], 10) || 0;
  var dy = parseInt(argv[3], 10) || 0;
  var move = $.CGEventCreateMouseEvent($(), 5, p, 0);
  if (move) $.CGEventPost(0, move);
  var steps = Math.max(1, Math.min(24, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 40)));
  for (var i = 0; i < steps; i++) {
    // Pixel units; a positive wheel value scrolls the content up, so invert.
    var e = $.CGEventCreateScrollWheelEvent($(), 0, 2, Math.round(-dy / steps), Math.round(-dx / steps));
    if (!e) throw new Error('CGEventCreateScrollWheelEvent unavailable');
    $.CGEventPost(0, e);
    pause(0.012);
  }
  return 'ok';
}`;

const DRAG_JXA = `${CG_PRELUDE}
function run(argv) {
  var from = pt(parseFloat(argv[0]), parseFloat(argv[1]));
  var to = pt(parseFloat(argv[2]), parseFloat(argv[3]));
  var move = $.CGEventCreateMouseEvent($(), 5, from, 0);
  if (!move) throw new Error('CGEventCreateMouseEvent unavailable');
  $.CGEventPost(0, move);
  pause(0.05);
  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 1, from, 0));
  pause(0.08);
  for (var i = 1; i <= 30; i++) {
    var t = i / 30;
    $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 6, pt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t), 0));
    pause(0.012);
  }
  pause(0.05);
  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), 2, to, 0));
  return 'ok';
}`;

/** Saves every item on the clipboard, puts text there, and puts the saved items back. */
const CLIPBOARD_FNS = `ObjC.import('AppKit');
ObjC.import('Foundation');
function saveClipboard() {
  var pb = $.NSPasteboard.generalPasteboard;
  var saved = [];
  var items = pb.pasteboardItems;
  var count = items.isNil() ? 0 : items.count;
  for (var i = 0; i < count; i++) {
    var item = items.objectAtIndex(i);
    var types = item.types;
    var entry = [];
    for (var j = 0; j < types.count; j++) {
      var type = types.objectAtIndex(j);
      var data = item.dataForType(type);
      if (!data.isNil()) entry.push([type, data]);
    }
    saved.push(entry);
  }
  return saved;
}
function setClipboardText(text) {
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
}
function restoreClipboard(saved) {
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  if (!saved.length) return;
  var items = $.NSMutableArray.array;
  for (var i = 0; i < saved.length; i++) {
    var item = $.NSPasteboardItem.alloc.init;
    for (var j = 0; j < saved[i].length; j++) item.setDataForType(saved[i][j][1], saved[i][j][0]);
    items.addObject(item);
  }
  pb.writeObjects(items);
}
`;

/**
 * Types argv[0]. Plain ASCII goes through System Events keystroke (chunked); newlines and tabs are
 * key presses; anything else (accents, emoji, CJK) is pasted, and the clipboard is put back after.
 */
const TYPE_JXA = `${CLIPBOARD_FNS}
function pause(s) { $.NSThread.sleepForTimeInterval(s); }
function run(argv) {
  var text = argv[0] || '';
  var se = Application('System Events');
  var lines = text.split('\\n');
  for (var i = 0; i < lines.length; i++) {
    if (i > 0) se.keyCode(36);
    var pieces = lines[i].split('\\t');
    for (var k = 0; k < pieces.length; k++) {
      if (k > 0) se.keyCode(48);
      var piece = pieces[k];
      if (!piece) continue;
      if (/^[\\x20-\\x7e]+$/.test(piece)) {
        for (var c = 0; c < piece.length; c += 120) se.keystroke(piece.slice(c, c + 120));
      } else {
        var saved = saveClipboard();
        setClipboardText(piece);
        se.keystroke('v', { using: 'command down' });
        pause(0.4);
        restoreClipboard(saved);
      }
    }
  }
  return 'ok';
}`;

/** argv: kind ("code" | "char"), value, comma-separated modifiers (command, shift, option, control). */
const KEY_JXA = `function run(argv) {
  var se = Application('System Events');
  var using = argv[2] ? argv[2].split(',').map(function (m) { return m + ' down'; }) : [];
  var opts = using.length ? { using: using } : {};
  if (argv[0] === 'code') se.keyCode(parseInt(argv[1], 10), opts);
  else se.keystroke(argv[1], opts);
  return 'ok';
}`;

// The primary display (menu bar, origin 0,0): the one screencapture captures. mainScreen is
// whichever display has the key window, which may be another one.
const GEOMETRY_JXA = `ObjC.import('AppKit');
function run() {
  var s = $.NSScreen.screens.objectAtIndex(0);
  return JSON.stringify({ width: s.frame.size.width, height: s.frame.size.height, backing: s.backingScaleFactor });
}`;

const APPS_JXA = `ObjC.import('AppKit');
function run() {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var out = [];
  for (var i = 0; i < apps.count; i++) {
    var a = apps.objectAtIndex(i);
    if (Number(a.activationPolicy) !== 0) continue;
    out.push({ name: ObjC.unwrap(a.localizedName), bundleId: ObjC.unwrap(a.bundleIdentifier) || null, pid: a.processIdentifier, active: Boolean(a.active), hidden: Boolean(a.hidden) });
  }
  return JSON.stringify(out);
}`;

/** Frontmost app (no permission needed) and its front window (needs Accessibility/Automation; best effort). */
const FRONT_JXA = `ObjC.import('AppKit');
function run() {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var out = { name: ObjC.unwrap(app.localizedName), bundleId: ObjC.unwrap(app.bundleIdentifier) || null, pid: app.processIdentifier, window: null, bounds: null };
  try {
    var proc = Application('System Events').processes.whose({ unixId: app.processIdentifier })[0];
    var w = proc.windows[0];
    out.window = w.name();
    var pos = w.position();
    var size = w.size();
    out.bounds = { x: pos[0], y: pos[1], width: size[0], height: size[1] };
  } catch (e) {
    out.windowError = String(e);
  }
  return JSON.stringify(out);
}`;

/** argv[0] = app name or bundle id. Asks the app to quit (it can still ask to save). */
const QUIT_JXA = `ObjC.import('AppKit');
function run(argv) {
  var want = String(argv[0] || '').toLowerCase();
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var quit = [];
  for (var i = 0; i < apps.count; i++) {
    var a = apps.objectAtIndex(i);
    var name = String(ObjC.unwrap(a.localizedName) || '');
    var id = String(ObjC.unwrap(a.bundleIdentifier) || '');
    if (name.toLowerCase() === want || id.toLowerCase() === want) {
      a.terminate;
      quit.push(name);
    }
  }
  return JSON.stringify(quit);
}`;

const PERMISSIONS_JXA = `ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
function run() {
  var out = {};
  try { ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]); out.accessibility = $.AXIsProcessTrusted(); } catch (e) { out.accessibility = null; }
  try { ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); out.screen = $.CGPreflightScreenCaptureAccess(); } catch (e) { out.screen = null; }
  return JSON.stringify(out);
}`;

// ---------------------------------------------------------------------------------------------
// Execution

function exec(file, args, { what, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout).trim());
      const permission = detectPermission(stderr);
      if (permission) return reject(permissionError(permission, what));
      const detail = String(stderr || error.message || "").trim().split("\n").slice(0, 4).join("\n");
      reject(new Error(`${what} failed${error.killed ? " (timed out)" : ""}${detail ? `: ${detail}` : ""}`));
    });
  });
}

function jxa(source, values, what, timeoutMs) {
  return exec(OSASCRIPT, osascriptArgs(source, values), { what, timeoutMs });
}

function ensureMac() {
  if (!SUPPORTED) throw new Error("Mac control only works on macOS.");
}

// ---------------------------------------------------------------------------------------------
// The native helper (electron/native/mac-helper.swift): reads apps' accessibility trees, presses
// elements, clicks and types. One long-lived process, so an action takes milliseconds instead of
// starting osascript each time. Without it (a build that lacks it), the osascript paths are used.

function helperPath() {
  const candidates = [path.join(__dirname, "..", "..", "build", "native", "adt-mac-helper")];
  if (process.resourcesPath) candidates.unshift(path.join(process.resourcesPath, "bin", "adt-mac-helper"));
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

let helper = null;
/** The helper died before ever answering (bad signature, killed at launch): use osascript instead. */
let helperBroken = false;

function startHelper() {
  const file = helperPath();
  if (!file) return null;
  const child = spawn(file, [], { stdio: ["pipe", "pipe", "ignore"] });
  const h = { child, pending: new Map(), buffer: "", next: 1 };
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
  const gone = () => {
    if (!h.answered && !h.killed) helperBroken = true;
    if (helper === h) helper = null;
    for (const settle of h.pending.values()) settle({ error: "The Mac helper stopped." });
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
  h.child.kill("SIGKILL");
}

const hasHelper = () => SUPPORTED && !helperBroken && Boolean(helper || helperPath());

function helperCall(cmd, payload, { what, timeoutMs = 15_000 }) {
  ensureMac();
  if (!helper) helper = startHelper();
  const h = helper;
  if (!h) return Promise.reject(new Error(`${what}: this build of ADT Bot is missing its Mac helper. Use mac_screenshot and mac_click instead.`));
  const id = h.next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      // A call that never returns means an app that stopped responding: start over next time.
      if (helper === h) stopHelper();
      reject(new Error(`${what} timed out: the app isn't responding.`));
    }, timeoutMs);
    h.pending.set(id, (message) => {
      clearTimeout(timer);
      h.pending.delete(id);
      if (message.error === undefined) return resolve(message.result);
      if (message.code === "accessibility") return reject(permissionError("accessibility", what));
      reject(Object.assign(new Error(message.error), { code: message.code ?? undefined }));
    });
    h.child.stdin.write(`${JSON.stringify({ ...payload, id, cmd })}\n`);
  });
}

/** Keys and clicks sent while the Mac is locked would go to the lock screen's password field. */
async function ensureUnlocked(what) {
  if (!hasHelper()) return;
  const state = await helperCall("ping", {}, { what, timeoutMs: 5_000 }).catch(() => null);
  if (state?.locked) throw new Error(`${what}: this Mac's screen is locked, so apps can't be seen or used. Ask the user to unlock it, then try again.`);
}

const busyError = (what, idle) =>
  Object.assign(
    new Error(`${what}: the user is using this Mac right now (keyboard or mouse used ${idle.toFixed(1)} s ago). Wait for them to pause and try again, or work in the background (mac_ui, mac_press, mac_set_text with the app named).`),
    { code: "busy" },
  );

/**
 * Pointer and key events go to whatever the user is doing: wait for a pause (up to 4 s), and
 * refuse if there's none. The helper does the same itself for what it sends.
 */
async function requireUserPause(what) {
  if (!hasHelper()) return;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const idle = (await helperCall("idle", {}, { what, timeoutMs: 5_000 }).catch(() => null))?.idle;
    if (typeof idle !== "number" || idle >= 1.2) return;
    if (Date.now() > deadline) throw busyError(what, idle);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The controls in an app's window (buttons, fields, links, rows, text) from macOS accessibility,
 * with ids for mac_press / mac_set_text. Each element also gets its centre in screenshot pixels.
 */
async function ui({ app: appName, window, query, menus, max } = {}) {
  await requireAccessibility("Reading the app's controls");
  const snap = await helperCall(
    "snapshot",
    { app: appName ? String(appName).slice(0, 200) : undefined, window: window ? String(window).slice(0, 200) : undefined, query: query ? String(query).slice(0, 200) : undefined, menus: menus === true, max: Number(max) || undefined },
    { what: "Reading the app's controls", timeoutMs: 20_000 },
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
  await requireAccessibility("Pressing");
  if (!PRESS_ACTIONS.has(action)) throw new Error(`action must be one of ${[...PRESS_ACTIONS].join(", ")}.`);
  return helperCall("press", { element: Number(element), action }, { what: "Pressing", timeoutMs: 15_000 });
}

async function setText({ element, text, replace = true, submit = false, background = true } = {}) {
  const value = String(text ?? "");
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await requireAccessibility("Typing");
  return helperCall("setText", { element: Number(element), text: value, replace: replace !== false, submit: submit === true, background: background !== false }, { what: "Typing", timeoutMs: 20_000 + value.length * 30 });
}

let geometryCache = null;
async function geometry() {
  if (geometryCache && Date.now() - geometryCache.at < 15_000) return geometryCache.value;
  const value = JSON.parse(await jxa(GEOMETRY_JXA, [], "Reading the screen size"));
  geometryCache = { at: Date.now(), value };
  return value;
}

/** How the latest screenshot maps to the screen; actions use the same coordinates. */
let lastFrame = null;
async function currentFrame() {
  return lastFrame ?? defaultFrame(await geometry());
}

function electronApi() {
  try {
    const e = require("electron");
    return typeof e === "object" && e ? e : null;
  } catch {
    return null;
  }
}

/** Automation (System Events): only known once macOS has been asked; remembered from the last answer. */
let automationState = "unknown";

/**
 * Where macOS stands on each permission now. The app's own answers for Screen Recording are cached
 * by macOS until the app restarts, so it also asks a fresh helper process (which macOS attributes
 * to this app) and reports when the change is waiting for a restart.
 */
async function permissions({ fresh = true } = {}) {
  if (!SUPPORTED) return { supported: false, platform: process.platform };
  const sp = electronApi()?.systemPreferences;
  const live = fresh ? await jxa(PERMISSIONS_JXA, [], "Checking permissions", 10_000).then(JSON.parse, () => ({})) : {};
  const cachedScreen = sp?.getMediaAccessStatus?.("screen") ?? "unknown";
  const accessibility = Boolean(sp?.isTrustedAccessibilityClient?.(false)) || live.accessibility === true ? true : (live.accessibility ?? (sp ? false : null));
  const screenRecording =
    live.screen === true ? "granted" : live.screen === false ? (cachedScreen === "not-determined" ? "not-determined" : "denied") : cachedScreen;
  return {
    supported: true,
    platform: "darwin",
    accessibility,
    screenRecording,
    /** Allowed in System Settings, but this running copy of the app still has the old answer. */
    screenNeedsRestart: screenRecording === "granted" && cachedScreen !== "granted",
    automation: automationState,
    microphone: sp?.getMediaAccessStatus?.("microphone") ?? "unknown",
    app: hostAppLabel(),
  };
}

async function requireAccessibility(what) {
  // The in-app check is live for Accessibility; only ask a helper process when it says no.
  if (electronApi()?.systemPreferences?.isTrustedAccessibilityClient?.(false)) return;
  const p = await permissions();
  if (p.accessibility === false) throw permissionError("accessibility", what);
}

/** Asks System Events for something harmless: shows macOS's Automation prompt the first time. */
async function checkAutomation() {
  ensureMac();
  try {
    await exec(OSASCRIPT, ["-e", 'tell application "System Events" to return name of first application process whose frontmost is true'], { what: "Checking Automation", timeoutMs: 60_000 });
    automationState = "granted";
  } catch (error) {
    if (/Automation/.test(String(error.message))) automationState = "denied";
    else throw error;
  }
  return automationState;
}

/** A one-pixel capture puts the app in the Screen Recording list (and shows macOS's prompt the first time). */
async function registerScreenRecording() {
  const file = path.join(os.tmpdir(), `adt-probe-${randomUUID()}.png`);
  await exec(SCREENCAPTURE, ["-x", "-R0,0,1,1", file], { what: "Checking Screen Recording", timeoutMs: 15_000 }).catch(() => undefined);
  fs.rm(file, { force: true }, () => undefined);
}

async function sipsSize(file) {
  const out = await exec(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", file], { what: "Reading the screenshot size" });
  return { width: Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1] ?? 0), height: Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1] ?? 0) };
}

/**
 * Captures the main display, a region (in the latest screenshot's coordinates), or the frontmost
 * window; downsizes to ≤ maxWidth px wide JPEG (or PNG) and remembers the frame for later clicks.
 */
async function screenshot({ region, window: frontWindow = false, maxWidth = MAX_WIDTH, format = "jpeg" } = {}) {
  ensureMac();
  const geo = await geometry();
  let rect = { x: 0, y: 0, width: geo.width, height: geo.height };
  let note = "";
  if (frontWindow) {
    const front = await frontmost();
    if (front.bounds && front.bounds.width > 0) rect = front.bounds;
    else note = "Couldn't read the front window's position (Accessibility permission?); captured the whole screen.";
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
    const args = ["-x", "-t", "png"];
    if (frontWindow || region) args.push("-R", `${rect.x},${rect.y},${rect.width},${rect.height}`);
    await exec(SCREENCAPTURE, [...args, raw], { what: "Taking a screenshot" }).catch((error) => {
      throw /screencapture/.test(error.message) && !detectPermission(error.message) ? permissionError("screen-recording", "Taking a screenshot") : error;
    });
    const stat = fs.existsSync(raw) ? fs.statSync(raw) : null;
    if (!stat || stat.size < SUSPICIOUS_BYTES) throw permissionError("screen-recording", "Taking a screenshot");
    let size;
    const image = electronApi()?.nativeImage?.createFromPath(raw);
    if (image && !image.isEmpty()) {
      // In-process: no sips processes to start.
      const captured = image.getSize();
      const resized = captured.width > width ? image.resize({ width, quality: "good" }) : image;
      fs.writeFileSync(out, png ? resized.toPNG() : resized.toJPEG(70));
      size = resized.getSize();
    } else {
      const captured = await sipsSize(raw);
      const convert = [];
      if (captured.width > width) convert.push("--resampleWidth", String(width));
      if (!png) convert.push("-s", "format", "jpeg", "-s", "formatOptions", "70");
      if (convert.length) await exec(SIPS, [...convert, raw, "--out", out], { what: "Resizing the screenshot" });
      else fs.copyFileSync(raw, out);
      size = await sipsSize(out);
    }
    const frame = frameFor(rect, size.width);
    lastFrame = frame;
    const perms = await permissions({ fresh: false }).catch(() => null);
    if (perms?.screenRecording && perms.screenRecording !== "granted" && perms.screenRecording !== "unknown") {
      note = [note, "Screen Recording permission isn't granted: other apps' windows may be missing (only the desktop shows)."].filter(Boolean).join(" ");
    }
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

async function cursor() {
  ensureMac();
  const p = JSON.parse(await jxa(CURSOR_JXA, [], "Reading the pointer position"));
  const frame = await currentFrame();
  return { screen: { x: Math.round(p.x), y: Math.round(p.y) }, image: toImagePoint(frame, p.x, p.y) };
}

/** Coordinates are screenshot pixels unless space is "screen" (display points). */
async function pointFor(x, y, space) {
  if (space === "screen") return toScreenPoint({ originX: 0, originY: 0, scale: 1 }, x, y);
  return toScreenPoint(await currentFrame(), x, y);
}

async function move({ x, y, space } = {}) {
  ensureMac();
  await requireAccessibility("Moving the pointer");
  await ensureUnlocked("Moving the pointer");
  const p = await pointFor(x, y, space);
  await requireUserPause("Moving the pointer");
  await jxa(MOVE_JXA, [p.x, p.y], "Moving the pointer");
  return { ok: true, screen: p };
}

async function click({ x, y, button = "left", clicks = 1, space } = {}) {
  ensureMac();
  await requireAccessibility("Clicking");
  await ensureUnlocked("Clicking");
  const p = await pointFor(x, y, space);
  const args = clickArgs(p, button, clicks);
  if (hasHelper()) await helperCall("click", { x: p.x, y: p.y, button, clicks: Number(args[3]) }, { what: "Clicking" }).catch((error) => (helperBroken ? jxa(CLICK_JXA, args, "Clicking") : Promise.reject(error)));
  else await jxa(CLICK_JXA, args, "Clicking");
  return { ok: true, screen: p };
}

async function drag({ x, y, toX, toY, space } = {}) {
  ensureMac();
  await requireAccessibility("Dragging");
  await ensureUnlocked("Dragging");
  const a = await pointFor(x, y, space);
  const b = await pointFor(toX, toY, space);
  await requireUserPause("Dragging");
  await jxa(DRAG_JXA, [a.x, a.y, b.x, b.y], "Dragging", 30_000);
  return { ok: true, from: a, to: b };
}

async function scroll({ x, y, dx = 0, dy = 0, space } = {}) {
  ensureMac();
  await requireAccessibility("Scrolling");
  await ensureUnlocked("Scrolling");
  const p = x === undefined || y === undefined ? (await cursor()).screen : await pointFor(x, y, space);
  const sx = Math.max(-5000, Math.min(5000, Math.round(Number(dx) || 0)));
  const sy = Math.max(-5000, Math.min(5000, Math.round(Number(dy) || 0)));
  await requireUserPause("Scrolling");
  await jxa(SCROLL_JXA, [p.x, p.y, sx, sy], "Scrolling");
  return { ok: true, screen: p };
}

async function typeText({ text, app: appName } = {}) {
  ensureMac();
  const value = String(text ?? "");
  if (!value) return { ok: true, typed: 0 };
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await requireAccessibility("Typing");
  await ensureUnlocked("Typing");
  const timeoutMs = Math.min(180_000, 20_000 + value.length * 60);
  // The helper types any character as a key event (clipboard untouched), into the named app from
  // behind when it isn't in front, and waits for the user to pause before typing into the front app.
  if (hasHelper()) {
    const done = await helperCall("type", { text: value, app: appName ? String(appName).slice(0, 200) : undefined }, { what: "Typing", timeoutMs }).catch((error) =>
      helperBroken ? jxa(TYPE_JXA, [value], "Typing", timeoutMs).then(() => ({ to: "front" })) : Promise.reject(error),
    );
    return { ok: true, typed: value.length, to: done?.to ?? "front" };
  }
  await jxa(TYPE_JXA, [value], "Typing", timeoutMs);
  return { ok: true, typed: value.length, to: "front" };
}

async function key({ combo, app: appName } = {}) {
  ensureMac();
  const parsed = parseCombo(combo);
  const what = `Pressing ${parsed.label}`;
  await requireAccessibility(what);
  await ensureUnlocked(what);
  if (hasHelper()) {
    const payload = { modifiers: parsed.modifiers, app: appName ? String(appName).slice(0, 200) : undefined };
    if (parsed.keyCode !== undefined) payload.code = parsed.keyCode;
    else payload.char = parsed.character;
    const done = await helperCall("key", payload, { what }).catch((error) => (helperBroken ? jxa(KEY_JXA, keyArgs(parsed), what).then(() => ({ to: "front" })) : Promise.reject(error)));
    return { ok: true, label: parsed.label, to: done?.to ?? "front" };
  }
  await jxa(KEY_JXA, keyArgs(parsed), what);
  return { ok: true, label: parsed.label, to: "front" };
}

async function listApps() {
  ensureMac();
  return JSON.parse(await jxa(APPS_JXA, [], "Listing apps"));
}

async function frontmost() {
  ensureMac();
  return JSON.parse(await jxa(FRONT_JXA, [], "Reading the frontmost app"));
}

function appName(name) {
  const value = String(name ?? "").trim();
  if (!value || value.length > 200 || /[\0\n]/.test(value)) throw new Error("Give the app's name, e.g. \"Safari\".");
  return value;
}

async function openApp({ name } = {}) {
  ensureMac();
  const value = appName(name);
  // "open -a" launches the app, or brings it forward when it's already running.
  await exec(OPEN, ["-a", value], { what: `Opening ${value}` }).catch((error) => {
    throw /unable to find application/i.test(error.message) ? new Error(`No app named "${value}" is installed.`) : error;
  });
  return { ok: true, name: value };
}

async function quitApp({ name } = {}) {
  ensureMac();
  const quit = JSON.parse(await jxa(QUIT_JXA, [appName(name)], "Quitting the app"));
  if (!quit.length) throw new Error(`"${name}" isn't running.`);
  return { ok: true, quit };
}

/** Links that open in an app: web, mail, calls and messages, and apps' own links (e.g. whatsapp://send?phone=…&text=…). */
const APP_LINK = /^(https?:\/\/|mailto:|tel:|sms:|facetime:|facetime-audio:|imessage:|whatsapp:|tg:|slack:|msteams:|zoommtg:|zoomus:|spotify:|music:|maps:|x-apple\.systempreferences:|notion:|obsidian:|vscode:|discord:)/i;

async function openUrl(shell, { url } = {}) {
  const value = String(url ?? "").trim();
  if (!APP_LINK.test(value) || value.length > 4000 || /[\0\r\n]/.test(value)) {
    throw new Error("Only web, mail, phone and messaging links, and links for apps like WhatsApp, Slack, Spotify, Zoom or Maps can be opened.");
  }
  await shell.openExternal(value);
  return { ok: true, url: value };
}

async function appleScript({ source, language = "applescript" } = {}) {
  ensureMac();
  const code = String(source ?? "");
  if (!code.trim()) throw new Error("Give the script to run.");
  if (code.length > MAX_SCRIPT) throw new Error("The script is too long.");
  await ensureUnlocked("Running the script");
  await requireUserPause("Running the script");
  // The script itself is the user's (approved) input here; it's the only thing in the source position.
  const lang = language === "javascript" ? "JavaScript" : "AppleScript";
  const output = await exec(OSASCRIPT, ["-l", lang, "-e", code], { what: "Running the script", timeoutMs: 60_000 });
  return { ok: true, output };
}

// ---------------------------------------------------------------------------------------------
// Web pages in the user's browser, read and used through the page itself (the browser's
// "execute javascript" scripting command): exact, and it works with the browser in the background,
// where Safari doesn't expose page contents to accessibility at all. Ghost OS reads pages over the
// Chrome debugging port instead, but Chrome no longer allows that on the user's own profile.

/** Browser names as in /Applications, and how each is scripted. */
const BROWSERS = {
  "Brave Browser": "chromium",
  "Google Chrome": "chromium",
  "Google Chrome Beta": "chromium",
  "Google Chrome Canary": "chromium",
  "Microsoft Edge": "chromium",
  Arc: "chromium",
  Vivaldi: "chromium",
  Chromium: "chromium",
  Opera: "chromium",
  Safari: "safari",
  "Safari Technology Preview": "safari",
};

/** argv: browser, operation (js | tabs | open | go | switch), value. */
const BROWSER_JXA = `function run(argv) {
  var app = Application(argv[0]);
  var safari = argv[3] === 'safari';
  if (!app.running()) throw new Error('ADT_NOT_RUNNING');
  if (app.windows.length === 0) throw new Error('ADT_NO_WINDOW');
  var w = app.windows[0];
  var op = argv[1];
  if (op === 'js') return safari ? app.doJavaScript(argv[2], { in: w.currentTab }) : w.activeTab.execute({ javascript: argv[2] });
  if (op === 'tabs') {
    var tabs = w.tabs();
    var out = [];
    for (var i = 0; i < tabs.length && i < 60; i++) out.push({ title: tabs[i].name ? tabs[i].name() : tabs[i].title(), url: tabs[i].url() });
    var active = safari ? w.currentTab.index() - 1 : w.activeTabIndex() - 1;
    return JSON.stringify({ active: active, tabs: out });
  }
  if (op === 'open') {
    var tab = app.Tab({ url: argv[2] });
    w.tabs.push(tab);
    if (safari) w.currentTab = w.tabs[w.tabs.length - 1];
    return 'ok';
  }
  if (op === 'go') {
    if (safari) w.currentTab.url = argv[2];
    else w.activeTab.url = argv[2];
    return 'ok';
  }
  if (op === 'switch') {
    var n = parseInt(argv[2], 10);
    if (safari) w.currentTab = w.tabs[n];
    else w.activeTabIndex = n + 1;
    return 'ok';
  }
  throw new Error('unknown operation');
}`;

/**
 * Runs inside the page: lists what can be clicked or typed into (giving each an id that stays the
 * same while the page lives), clicks, types, scrolls, reads the text. Called with one JSON object.
 */
const PAGE_FN = `function (req) {
  var D = document, W = window;
  var reg = W.__adtEls || (W.__adtEls = { next: 1, byId: {} });
  function clean(s, n) { s = String(s == null ? '' : s).replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s; }
  function box(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var st = W.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return null;
    return r;
  }
  function editable(el) { return el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type || ''); }
  function role(el) {
    var r = el.getAttribute('role');
    if (r) return r === 'textbox' || r === 'searchbox' ? 'text field' : r;
    var t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'pop-up menu';
    if (t === 'TEXTAREA' || el.isContentEditable) return 'text area';
    if (t === 'INPUT') {
      var ty = (el.type || 'text').toLowerCase();
      if (/^(submit|button|reset|image)$/.test(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'search') return 'search field';
      if (ty === 'password') return 'password field';
      return 'text field';
    }
    return 'button';
  }
  function label(el) {
    var l = el.getAttribute('aria-label') || '';
    var by = el.getAttribute('aria-labelledby');
    if (!l && by) l = by.split(/\\s+/).map(function (id) { var t = D.getElementById(id); return t ? t.textContent : ''; }).join(' ');
    if (!l && el.labels && el.labels.length) l = el.labels[0].textContent;
    if (!l && !editable(el) && el.tagName !== 'SELECT') l = el.innerText || el.textContent || '';
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('data-placeholder') || '';
    if (!l && el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) l = el.value;
    if (!l && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) l = el.getAttribute('name') || '';
    if (!l) { var img = el.querySelector && el.querySelector('img[alt],svg[aria-label]'); if (img) l = img.getAttribute('alt') || img.getAttribute('aria-label'); }
    return clean(l, 120);
  }
  var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=treeitem],[role=gridcell][tabindex],[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only]';
  function collect(root, out) {
    var found = root.querySelectorAll(SEL);
    for (var i = 0; i < found.length; i++) out.push(found[i]);
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) collect(all[j].shadowRoot, out);
    return out;
  }
  function idOf(el) {
    if (!el.__adtId) { el.__adtId = reg.next++; reg.byId[el.__adtId] = el; }
    return el.__adtId;
  }
  function find(id) {
    var el = reg.byId[id];
    if (!el || !el.isConnected) throw new Error('ADT_STALE');
    return el;
  }
  function snapshot() {
    var words = clean(req.query || '', 200).toLowerCase().split(' ').filter(Boolean);
    var max = Math.max(10, Math.min(400, req.max || 150));
    var vw = W.innerWidth, vh = W.innerHeight;
    var els = collect(D, []);
    var out = [], matched = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest('[aria-hidden=true],[inert]')) continue;
      var r = box(el);
      if (!r) continue;
      var e = { id: 0, role: role(el), label: label(el) };
      if (editable(el)) { e.input = true; e.value = clean(el.isContentEditable ? el.innerText : (el.type === 'password' ? (el.value ? '\\u2022\\u2022\\u2022' : '') : el.value), 300); }
      else if (el.tagName === 'SELECT') e.value = clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '', 80);
      if (!e.label && !e.input && e.role !== 'checkbox' && el.tagName !== 'SELECT') continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') e.disabled = true;
      if (el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true') e.selected = true;
      if (D.activeElement === el) e.focused = true;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) e.offscreen = true;
      if (el.tagName === 'A' && el.href && !/^javascript:/i.test(el.getAttribute('href') || '')) e.href = clean(el.href, 200);
      if (words.length) { var hay = (e.role + ' ' + e.label + ' ' + (e.value || '') + ' ' + (e.href || '')).toLowerCase(); if (!words.every(function (w) { return hay.indexOf(w) >= 0; })) continue; }
      matched++;
      if (out.length >= max) continue;
      e.id = idOf(el);
      out.push(e);
    }
    var result = { url: location.href, title: clean(D.title, 200), elements: out, matched: matched, scroll: { y: Math.round(W.scrollY), height: Math.round(D.documentElement.scrollHeight), view: vh } };
    if (req.content) {
      var main = D.querySelector('main,[role=main],article') || D.body;
      var text = clean(main ? main.innerText : '', 1e6);
      var from = Math.max(0, req.offset || 0);
      result.text = text.slice(from, from + (req.chars || 12000));
      result.textLength = text.length;
    }
    return result;
  }
  function pointer(el, type) {
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, composed: true, view: W, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: type.indexOf('down') >= 0 ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(type.indexOf('pointer') === 0 && W.PointerEvent ? new PointerEvent(type, o) : new MouseEvent(type, o));
  }
  function click(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    pointer(el, 'pointerdown'); pointer(el, 'mousedown');
    if (el.focus) el.focus({ preventScroll: true });
    pointer(el, 'pointerup'); pointer(el, 'mouseup');
    el.click();
    return { ok: true, label: label(el), role: role(el) };
  }
  function valueOf(el) { return el.isContentEditable ? el.innerText : el.value; }
  function key(el, k) {
    var o = { key: k, code: k, keyCode: k === 'Enter' ? 13 : 0, which: k === 'Enter' ? 13 : 0, bubbles: true, cancelable: true, composed: true };
    var go = el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    return go;
  }
  function type(el) {
    var text = String(req.text || '');
    if (el.tagName === 'SELECT') {
      var want = clean(text, 200).toLowerCase(), hit = -1;
      for (var i = 0; i < el.options.length; i++) { var t = clean(el.options[i].text, 200).toLowerCase(); if (t === want || el.options[i].value.toLowerCase() === want) { hit = i; break; } if (hit < 0 && t.indexOf(want) >= 0) hit = i; }
      if (hit < 0) throw new Error('No option "' + text + '"; the options are: ' + Array.prototype.map.call(el.options, function (o) { return o.text; }).slice(0, 30).join(', '));
      el.selectedIndex = hit;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.options[hit].text };
    }
    if (!editable(el)) throw new Error('ADT_NOT_EDITABLE');
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    var before = valueOf(el);
    if (el.isContentEditable) {
      var range = D.createRange();
      range.selectNodeContents(el);
      if (req.append) range.collapse(false);
      var sel = W.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } else if (req.append) { el.setSelectionRange && el.setSelectionRange(el.value.length, el.value.length); }
    else if (el.select) el.select();
    var expected = req.append ? before + text : text;
    // As if typed: editors (React, Lexical, Draft, ProseMirror) see a normal insert.
    var ok = text ? D.execCommand('insertText', false, text) : D.execCommand('delete');
    if (!ok || clean(valueOf(el), 1e6) !== clean(expected, 1e6)) {
      if (el.isContentEditable) { el.textContent = expected; }
      else {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, expected);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    var out = { ok: true, value: clean(el.type === 'password' ? '' : valueOf(el), 300) };
    if (req.submit) {
      var go = key(el, 'Enter');
      var form = el.form || el.closest('form');
      if (go && form && valueOf(el) !== '') { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
      out.submitted = true;
    }
    return out;
  }
  try {
    var r;
    if (req.op === 'read') r = snapshot();
    else if (req.op === 'click') r = click(find(req.id));
    else if (req.op === 'type') r = type(find(req.id));
    else if (req.op === 'scroll') { if (req.id) find(req.id).scrollIntoView({ block: 'center' }); else W.scrollBy(0, req.dy || W.innerHeight * 0.8); r = { ok: true, y: Math.round(W.scrollY) }; }
    else if (req.op === 'back') { history.back(); r = { ok: true }; }
    else if (req.op === 'forward') { history.forward(); r = { ok: true }; }
    else if (req.op === 'reload') { location.reload(); r = { ok: true }; }
    else throw new Error('unknown operation');
    return JSON.stringify({ result: r });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message || e) });
  }
}`;

/** The page script call for one request: the request is JSON, so it can only ever be data. */
function pageScript(req) {
  return `(${PAGE_FN})(${JSON.stringify(req).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")})`;
}

function browserError(name, kind, error) {
  const text = String(error?.message ?? error);
  if (/ADT_NOT_RUNNING/.test(text)) return new Error(`${name} isn't open. Open it first (mac_open_app).`);
  if (/ADT_NO_WINDOW/.test(text)) return new Error(`${name} has no open window.`);
  if (/JavaScript.*(turned off|Apple ?Events)|Allow JavaScript from Apple Events/i.test(text)) {
    return Object.assign(
      new Error(
        kind === "safari"
          ? `Safari doesn't let apps read pages until it's allowed: Safari → Settings → Advanced → turn on "Show features for web developers", then Develop menu → "Allow JavaScript from Apple Events". Ask the user to do this (or do it with mac_press, menus:true, after they agree), then try again.`
          : `${name} doesn't let apps read pages until it's allowed: in ${name}'s menu bar, View → Developer → "Allow JavaScript from Apple Events". Ask the user to switch it on (or press it with mac_press after they agree: mac_ui with app "${name}" and menus:true), then try again.`,
      ),
      { code: "browser-js-off" },
    );
  }
  return error;
}

/** Which browser: the one asked for, the one in front, or the first one running. */
async function pickBrowser(name) {
  if (name) {
    const want = String(name).toLowerCase();
    const known = Object.keys(BROWSERS).find((b) => b.toLowerCase() === want) ?? Object.keys(BROWSERS).find((b) => b.toLowerCase().includes(want));
    if (!known) throw new Error(`"${name}" isn't a browser ADT Bot can use. Supported: ${Object.keys(BROWSERS).join(", ")}. (Firefox can't be scripted.)`);
    return known;
  }
  const apps = await listApps();
  const running = apps.filter((a) => BROWSERS[a.name]);
  const front = running.find((a) => a.active);
  if (front) return front.name;
  if (running.length) return running[0].name;
  throw new Error("No supported browser is open (Safari, Chrome, Brave, Edge, Arc, Vivaldi). Open one first.");
}

async function browserRun(name, op, value) {
  const kind = BROWSERS[name];
  try {
    return await jxa(BROWSER_JXA, [name, op, value ?? "", kind], `Using ${name}`, 30_000);
  } catch (error) {
    throw browserError(name, kind, error);
  }
}

async function page(name, req) {
  const raw = await browserRun(name, "js", pageScript(req));
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} returned nothing from the page (it may still be loading, or it's a built-in page like the new tab page). Try again in a moment.`);
  }
  if (parsed.error === "ADT_STALE") throw Object.assign(new Error("That element is gone (the page changed). Read the page again (action read)."), { code: "stale" });
  if (parsed.error === "ADT_NOT_EDITABLE") throw new Error("That element isn't a text field. Read the page again and pick a field.");
  if (parsed.error) throw new Error(`The page refused: ${parsed.error}`);
  return parsed.result;
}

/** Web addresses only: a file:// page would let the browser read this Mac's files to the bot. */
const URL_OK = /^https?:\/\/[^\s]/i;

/** One browser action; every call says which browser it used. */
async function browser({ browser: wanted, action = "read", id, text, submit, append, query, content, offset, url, tab, dy, max } = {}) {
  ensureMac();
  const address = String(url ?? "").trim();
  if ((action === "open" || action === "go") && (!URL_OK.test(address) || address.length > 4000 || /[\0\r\n]/.test(address))) {
    throw new Error("Give a web address starting with https:// or http://.");
  }
  const name = await pickBrowser(wanted);
  const base = { browser: name };
  switch (action) {
    case "read":
      return { ...base, ...(await page(name, { op: "read", query: query ? String(query).slice(0, 200) : undefined, content: content === true, offset: Number(offset) || 0, max: Number(max) || undefined })) };
    case "click":
      return { ...base, ...(await page(name, { op: "click", id: Number(id) })) };
    case "type": {
      const value = String(text ?? "");
      if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
      return { ...base, ...(await page(name, { op: "type", id: Number(id), text: value, submit: submit === true, append: append === true })) };
    }
    case "scroll":
      return { ...base, ...(await page(name, { op: "scroll", id: id === undefined ? undefined : Number(id), dy: Number(dy) || undefined })) };
    case "back":
    case "forward":
    case "reload":
      return { ...base, ...(await page(name, { op: action })) };
    case "tabs":
      return { ...base, ...JSON.parse(await browserRun(name, "tabs")) };
    case "switch":
      await browserRun(name, "switch", String(Math.max(0, Math.round(Number(tab) || 0))));
      return { ...base, ok: true };
    case "open":
    case "go":
      await browserRun(name, action, address);
      return { ...base, ok: true, url: address };
    default:
      throw new Error("action must be read, click, type, scroll, back, forward, reload, tabs, switch, open or go.");
  }
}

// ---------------------------------------------------------------------------------------------
// Text on screen, by Apple's on-device text recognition: for what accessibility can't describe.

async function findText({ fast } = {}) {
  ensureMac();
  await ensureUnlocked("Reading text on screen");
  if (!hasHelper()) throw new Error("Reading text on screen needs ADT Bot's Mac helper, which this build lacks.");
  const geo = await geometry();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adt-ocr-"));
  const raw = path.join(dir, "raw.png");
  try {
    await exec(SCREENCAPTURE, ["-x", "-t", "png", raw], { what: "Reading text on screen" }).catch((error) => {
      throw /screencapture/.test(error.message) && !detectPermission(error.message) ? permissionError("screen-recording", "Reading text on screen") : error;
    });
    if (!fs.existsSync(raw) || fs.statSync(raw).size < SUSPICIOUS_BYTES) throw permissionError("screen-recording", "Reading text on screen");
    const found = await helperCall("ocr", { path: raw, fast: fast === true }, { what: "Reading text on screen", timeoutMs: 30_000 });
    const frame = await currentFrame();
    const lines = (found.lines ?? []).map((l) => {
      const centre = { x: geo.width * (l.x + l.w / 2), y: geo.height * (l.y + l.h / 2) };
      return { text: l.text, confidence: l.confidence, at: toImagePoint(frame, centre.x, centre.y), screen: { x: Math.round(centre.x), y: Math.round(centre.y) } };
    });
    return { lines, screen: { width: geo.width, height: geo.height } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

exports.register = ({ app, ipcMain, shell, access, onStopAll }) => {
  // On Windows, electron/features/75-win-control.cjs registers the adt:mac:* channels instead.
  if (!SUPPORTED) return;
  // "Stop all bots": a typing or pressing helper stops at once.
  onStopAll?.(stopHelper);
  const handle = (name, fn) => ipcMain.handle(`adt:mac:${name}`, (_e, payload) => fn(payload ?? {}));
  /** Anything that acts on the Mac is off in Sandbox mode (looking and permissions still work). */
  const act = (name, fn) =>
    handle(name, (payload) => {
      if (access?.mode === "sandbox") throw new Error("Computer access is set to Sandbox, so bots can't control this Mac.");
      return fn(payload);
    });
  handle("status", async () => (SUPPORTED ? { ...(await permissions()), screen: await geometry().catch(() => null) } : { supported: false, platform: process.platform }));
  handle("permissions", () => permissions());
  handle("openSettings", async ({ pane }) => {
    const url = PANES[pane];
    if (!url) throw new Error("Unknown settings pane.");
    // Make sure ADT Bot is in the list to switch on (macOS only lists apps that have asked).
    if (SUPPORTED && pane === "accessibility") electronApi()?.systemPreferences?.isTrustedAccessibilityClient?.(true);
    if (SUPPORTED && pane === "screen-recording") await registerScreenRecording();
    return shell.openExternal(url);
  });
  handle("checkAutomation", checkAutomation);
  handle("requestMicrophone", async () => {
    ensureMac();
    const sp = electronApi()?.systemPreferences;
    // macOS asks only once; after a "no", the switch is in System Settings.
    if (sp?.getMediaAccessStatus("microphone") === "not-determined") return sp.askForMediaAccess("microphone");
    await shell.openExternal(PANES.microphone);
    return sp?.getMediaAccessStatus("microphone") === "granted";
  });
  handle("relaunch", () => {
    app?.relaunch();
    app?.exit(0);
  });
  handle("requestAccessibility", () => {
    ensureMac();
    return electronApi()?.systemPreferences?.isTrustedAccessibilityClient?.(true) ?? null;
  });
  handle("screenshot", screenshot);
  handle("cursor", cursor);
  act("move", move);
  act("click", click);
  act("drag", drag);
  act("scroll", scroll);
  act("type", typeText);
  act("key", key);
  handle("apps", listApps);
  handle("frontmost", frontmost);
  act("open", openApp);
  act("quit", quitApp);
  act("openUrl", (payload) => openUrl(shell, payload));
  act("applescript", appleScript);
  act("ui", ui);
  act("press", pressElement);
  act("setText", setText);
  act("browser", browser);
  handle("findText", findText);
  handle("helper", () => ({ available: hasHelper() }));
  handle("idle", () => (hasHelper() ? helperCall("idle", {}, { what: "Checking activity", timeoutMs: 5_000 }) : { idle: null }));
  app?.on?.("will-quit", stopHelper);
};

exports.stopHelper = stopHelper;

exports._test = {
  SUPPORTED,
  PANES,
  osascriptArgs,
  frameFor,
  defaultFrame,
  toScreenPoint,
  toImagePoint,
  parseCombo,
  keyArgs,
  clickArgs,
  detectPermission,
  scripts: { MOVE_JXA, CURSOR_JXA, CLICK_JXA, SCROLL_JXA, DRAG_JXA, TYPE_JXA, KEY_JXA, GEOMETRY_JXA, APPS_JXA, FRONT_JXA, QUIT_JXA, PERMISSIONS_JXA, CLIPBOARD_FNS },
  exec,
  jxa,
  permissions,
  geometry,
  screenshot,
  cursor,
  move,
  listApps,
  frontmost,
  APP_LINK,
  BROWSERS,
  busyError,
  pageScript,
  browserError,
  helperPath,
  helperCall,
  stopHelper,
  ui,
  resetFrame: () => {
    lastFrame = null;
  },
};
