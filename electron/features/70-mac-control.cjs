// "Control your Mac": screenshots, pointer, keyboard and apps for bots (computer use).
// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors
// (CoreGraphics JXA scripts, key map, permission detection), reworked so that every user value
// travels as an argv entry to osascript/JXA: nothing the model sends is ever spliced into script
// source. Every call is approved in the app first (src/lib/agent/approvals.ts); this side executes.
const { execFile } = require("node:child_process");
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
};
const PANE_LABEL = {
  accessibility: "Privacy & Security → Accessibility",
  "screen-recording": "Privacy & Security → Screen & System Audio Recording",
  automation: "Privacy & Security → Automation",
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

const GEOMETRY_JXA = `ObjC.import('AppKit');
function run() {
  var s = $.NSScreen.mainScreen;
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

async function permissions() {
  if (!SUPPORTED) return { supported: false, platform: process.platform };
  const sp = electronApi()?.systemPreferences;
  let accessibility = null;
  let screen = "unknown";
  if (sp?.isTrustedAccessibilityClient) {
    accessibility = sp.isTrustedAccessibilityClient(false);
    screen = sp.getMediaAccessStatus("screen");
  } else {
    const r = JSON.parse(await jxa(PERMISSIONS_JXA, [], "Checking permissions"));
    accessibility = r.accessibility;
    screen = r.screen === true ? "granted" : r.screen === false ? "denied" : "unknown";
  }
  return { supported: true, platform: "darwin", accessibility, screenRecording: screen, app: hostAppLabel() };
}

async function requireAccessibility(what) {
  const p = await permissions();
  if (p.accessibility === false) throw permissionError("accessibility", what);
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
    const captured = await sipsSize(raw);
    const convert = [];
    if (captured.width > width) convert.push("--resampleWidth", String(width));
    if (!png) convert.push("-s", "format", "jpeg", "-s", "formatOptions", "70");
    if (convert.length) await exec(SIPS, [...convert, raw, "--out", out], { what: "Resizing the screenshot" });
    else fs.copyFileSync(raw, out);
    const size = await sipsSize(out);
    const frame = frameFor(rect, size.width);
    lastFrame = frame;
    const perms = await permissions().catch(() => null);
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
  const p = await pointFor(x, y, space);
  await jxa(MOVE_JXA, [p.x, p.y], "Moving the pointer");
  return { ok: true, screen: p };
}

async function click({ x, y, button = "left", clicks = 1, space } = {}) {
  ensureMac();
  await requireAccessibility("Clicking");
  const p = await pointFor(x, y, space);
  await jxa(CLICK_JXA, clickArgs(p, button, clicks), "Clicking");
  return { ok: true, screen: p };
}

async function drag({ x, y, toX, toY, space } = {}) {
  ensureMac();
  await requireAccessibility("Dragging");
  const a = await pointFor(x, y, space);
  const b = await pointFor(toX, toY, space);
  await jxa(DRAG_JXA, [a.x, a.y, b.x, b.y], "Dragging", 30_000);
  return { ok: true, from: a, to: b };
}

async function scroll({ x, y, dx = 0, dy = 0, space } = {}) {
  ensureMac();
  await requireAccessibility("Scrolling");
  const p = x === undefined || y === undefined ? (await cursor()).screen : await pointFor(x, y, space);
  const sx = Math.max(-5000, Math.min(5000, Math.round(Number(dx) || 0)));
  const sy = Math.max(-5000, Math.min(5000, Math.round(Number(dy) || 0)));
  await jxa(SCROLL_JXA, [p.x, p.y, sx, sy], "Scrolling");
  return { ok: true, screen: p };
}

async function typeText({ text } = {}) {
  ensureMac();
  const value = String(text ?? "");
  if (!value) return { ok: true, typed: 0 };
  if (value.length > MAX_TEXT) throw new Error(`Text is too long (max ${MAX_TEXT} characters).`);
  await requireAccessibility("Typing");
  await jxa(TYPE_JXA, [value], "Typing", Math.min(180_000, 20_000 + value.length * 60));
  return { ok: true, typed: value.length };
}

async function key({ combo } = {}) {
  ensureMac();
  const parsed = parseCombo(combo);
  await requireAccessibility(`Pressing ${parsed.label}`);
  await jxa(KEY_JXA, keyArgs(parsed), `Pressing ${parsed.label}`);
  return { ok: true, label: parsed.label };
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

async function openUrl(shell, { url } = {}) {
  const value = String(url ?? "").trim();
  if (!/^(https?:\/\/|mailto:)/i.test(value)) throw new Error("Only http(s) and mailto links can be opened.");
  await shell.openExternal(value);
  return { ok: true, url: value };
}

async function appleScript({ source, language = "applescript" } = {}) {
  ensureMac();
  const code = String(source ?? "");
  if (!code.trim()) throw new Error("Give the script to run.");
  if (code.length > MAX_SCRIPT) throw new Error("The script is too long.");
  // The script itself is the user's (approved) input here; it's the only thing in the source position.
  const lang = language === "javascript" ? "JavaScript" : "AppleScript";
  const output = await exec(OSASCRIPT, ["-l", lang, "-e", code], { what: "Running the script", timeoutMs: 60_000 });
  return { ok: true, output };
}

exports.register = ({ ipcMain, shell }) => {
  const handle = (name, fn) => ipcMain.handle(`adt:mac:${name}`, (_e, payload) => fn(payload ?? {}));
  handle("status", async () => (SUPPORTED ? { ...(await permissions()), screen: await geometry().catch(() => null) } : { supported: false, platform: process.platform }));
  handle("permissions", permissions);
  handle("openSettings", ({ pane }) => {
    const url = PANES[pane];
    if (!url) throw new Error("Unknown settings pane.");
    return shell.openExternal(url);
  });
  handle("requestAccessibility", () => {
    ensureMac();
    return electronApi()?.systemPreferences?.isTrustedAccessibilityClient?.(true) ?? null;
  });
  handle("screenshot", screenshot);
  handle("cursor", cursor);
  handle("move", move);
  handle("click", click);
  handle("drag", drag);
  handle("scroll", scroll);
  handle("type", typeText);
  handle("key", key);
  handle("apps", listApps);
  handle("frontmost", frontmost);
  handle("open", openApp);
  handle("quit", quitApp);
  handle("openUrl", (payload) => openUrl(shell, payload));
  handle("applescript", appleScript);
};

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
  resetFrame: () => {
    lastFrame = null;
  },
};
