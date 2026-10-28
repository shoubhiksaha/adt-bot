// @vitest-environment node
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// The feature is a .cjs module; its _test surface is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const linux: any = require("../../../electron/features/76-linux-control.cjs")._test;
const HELPER = join(__dirname, "..", "..", "..", "electron", "native", "linux-helper.py");

/** A stand-in for the Python child: it auto-answers each request from a map of cmd -> result. */
function fakeHelper(replies: Record<string, unknown>) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stdout.setEncoding = () => undefined;
  const sent: Record<string, unknown>[] = [];
  const child = {
    stdout,
    stdin: {
      on: () => undefined,
      write: (line: string) => {
        const req = JSON.parse(line.trim());
        sent.push(req);
        const reply = typeof replies[req.cmd] === "function" ? (replies[req.cmd] as (r: unknown) => unknown)(req) : replies[req.cmd];
        const message =
          reply instanceof Error
            ? { id: req.id, error: reply.message, code: (reply as Error & { code?: string }).code }
            : reply === undefined
              ? { id: req.id, error: `no reply for ${req.cmd}` }
              : { id: req.id, result: reply };
        setImmediate(() => stdout.emit("data", `${JSON.stringify(message)}\n`));
      },
    },
    on: () => undefined,
    kill: () => undefined,
  };
  return { child, sent };
}

const refusal = (message: string, code: string) => Object.assign(new Error(message), { code });

afterEach(() => {
  linux.setBrowserWindow(null);
  linux.setHelper(null);
  linux.setSupported(process.platform === "linux");
  linux.resetFrame();
});

describe("key combos (X keysym names)", () => {
  it("maps Mac habits onto Linux keys", () => {
    expect(linux.parseCombo("cmd+c")).toEqual({ modifiers: ["control"], character: "c", label: "control+c" });
    expect(linux.parseCombo("ctrl+shift+t")).toEqual({ modifiers: ["control", "shift"], character: "t", label: "control+shift+t" });
    expect(linux.parseCombo("enter")).toEqual({ modifiers: [], keysym: "Return", label: "enter" });
    expect(linux.parseCombo("alt-left")).toMatchObject({ modifiers: ["alt"], keysym: "Left" });
    expect(linux.parseCombo("super+e")).toMatchObject({ modifiers: ["super"], character: "e" });
    expect(linux.parseCombo("ctrl++")).toMatchObject({ modifiers: ["control"], character: "+" });
    expect(linux.parseCombo("pagedown")).toMatchObject({ keysym: "Next" });
    expect(linux.parseCombo("f12")).toMatchObject({ keysym: "F12" });
  });

  it("rejects unknown keys, lone modifiers and junk", () => {
    expect(() => linux.parseCombo("")).toThrow(/Give a key/);
    expect(() => linux.parseCombo("shift")).toThrow(/on its own/);
    expect(() => linux.parseCombo("hyper+x")).toThrow(/Unknown modifier/);
    expect(() => linux.parseCombo("ctrl+banana")).toThrow(/Unknown key/);
    expect(() => linux.parseCombo("a".repeat(61))).toThrow(/too long/);
  });

  it("builds the helper's key payload", () => {
    expect(linux.keyPayload(linux.parseCombo("ctrl+s"), "Text Editor")).toEqual({ modifiers: ["control"], char: "s", app: "Text Editor" });
    expect(linux.keyPayload(linux.parseCombo("escape"))).toEqual({ modifiers: [], keysym: "Escape" });
  });
});

describe("app names (no code execution)", () => {
  it("accepts launcher names and commands, rejects paths and newlines", () => {
    expect(linux.appName(" Text Editor ")).toBe("Text Editor");
    expect(linux.appName("gnome-calculator")).toBe("gnome-calculator");
    expect(() => linux.appName("/usr/bin/xterm")).toThrow(/not a path/);
    expect(() => linux.appName("..\\x")).toThrow(/not a path/);
    expect(() => linux.appName("calc\nrm -rf")).toThrow(/Give the app/);
    expect(() => linux.appName("")).toThrow(/Give the app/);
  });
});

describe("the helper process", () => {
  it("runs Python isolated, without writing .pyc files", () => {
    expect(linux.helperArgs("/opt/ADT Bot/resources/linux-helper.py")).toEqual(["-I", "-B", "/opt/ADT Bot/resources/linux-helper.py"]);
  });

  it("keeps injected libraries and Python paths out of the system Python", () => {
    const env = { PATH: "/usr/bin", DISPLAY: ":0", LD_PRELOAD: "/tmp/evil.so", PYTHONPATH: "/tmp", PYTHONHOME: "/x", GI_TYPELIB_PATH: "/y", LD_LIBRARY_PATH: "/usr/local/lib", NO_AT_BRIDGE: "1" };
    const out = linux.helperEnv(env, { ADT_PARENT_PID: "7" });
    expect(out).toMatchObject({ PATH: "/usr/bin", DISPLAY: ":0", ADT_PARENT_PID: "7", LD_LIBRARY_PATH: "/usr/local/lib" });
    for (const name of ["LD_PRELOAD", "PYTHONPATH", "PYTHONHOME", "GI_TYPELIB_PATH"]) expect(out).not.toHaveProperty(name);
    // Chromium's NO_AT_BRIDGE=1 would make apps the helper opens hide their controls.
    expect(out).not.toHaveProperty("NO_AT_BRIDGE");
    // Inside an AppImage its bundled library path must not reach the system Python either.
    expect(linux.helperEnv({ ...env, APPDIR: "/tmp/.mount_adt" }, {})).not.toHaveProperty("LD_LIBRARY_PATH");
  });

  it("is a valid Python 3 script", () => {
    let python: string | null = null;
    try {
      execFileSync("python3", ["--version"], { stdio: "pipe" });
      python = "python3";
    } catch {
      // not installed
    }
    if (!python) return;
    execFileSync(python, ["-I", "-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", HELPER], { stdio: "pipe" });
  });

  it("refuses ADT Bot's own windows and waits for the person (in the helper's source)", () => {
    const source = readFileSync(HELPER, "utf8");
    expect(source).toContain('PARENT_PID = int(os.environ.get("ADT_PARENT_PID") or 0)');
    for (const fn of ["def refuse_self_at", "def require_other_app_in_front", "def require_user_pause"]) expect(source).toContain(fn);
  });
});

describe("screenshot cropping (Wayland's whole-desktop image)", () => {
  it("cuts the wanted rectangle out of a desktop image at its scale", () => {
    // Two displays side by side (3840x1080 points), captured at 2x.
    const crop = linux.cropFor({ x: 1920, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 3840, height: 1080 }, { width: 7680, height: 2160 });
    expect(crop).toEqual({ x: 3840, y: 0, width: 3840, height: 2160 });
  });

  it("clamps to the image", () => {
    const crop = linux.cropFor({ x: -10, y: 900, width: 400, height: 400 }, { x: 0, y: 0, width: 1280, height: 1000 }, { width: 1280, height: 1000 });
    expect(crop).toEqual({ x: 0, y: 900, width: 400, height: 100 });
  });
});

describe("requests through a scripted helper", () => {
  it("snapshots an app and places each element's centre in screenshot pixels", async () => {
    linux.setSupported(true);
    const { child, sent } = fakeHelper({
      ping: { locked: false, idle: 9 },
      geometry: { x: 0, y: 0, width: 2560, height: 1440, backing: 1 },
      snapshot: {
        name: "gnome-calculator",
        pid: 42,
        window: "Calculator",
        windows: ["Calculator"],
        elements: [{ id: 3, role: "button", label: "7", frame: { x: 100, y: 200, w: 60, h: 40 } }],
        matched: 1,
        truncated: false,
        frontmost: true,
      },
    });
    linux.setHelper(child);
    const snap = await linux.ui({ app: "Calculator", max: 50 });
    expect(sent.find((r) => r.cmd === "snapshot")).toMatchObject({ app: "Calculator", max: 50 });
    // scale = 1280/2560; centre (130, 220) -> (65, 110).
    expect(snap.elements[0].at).toEqual({ x: 65, y: 110 });
  });

  it("sends a key to the named app and reports where it went", async () => {
    linux.setSupported(true);
    const { child, sent } = fakeHelper({ ping: { locked: false, idle: 9 }, key: { ok: true, to: "app" } });
    linux.setHelper(child);
    expect(await linux.key({ combo: "cmd+s", app: "Text Editor" })).toEqual({ ok: true, label: "control+s", to: "app" });
    expect(sent.find((r) => r.cmd === "key")).toMatchObject({ char: "s", modifiers: ["control"], app: "Text Editor" });
  });

  it("clicks at screenshot pixels turned into screen pixels", async () => {
    linux.setSupported(true);
    const { child, sent } = fakeHelper({ ping: { locked: false, idle: 9 }, geometry: { x: 0, y: 0, width: 2560, height: 1440, backing: 1 }, click: { ok: true } });
    linux.setHelper(child);
    await linux.click({ x: 640, y: 360 });
    expect(sent.find((r) => r.cmd === "click")).toMatchObject({ x: 1280, y: 720, button: "left", clicks: 1 });
  });

  it("passes the helper's refusals on (ADT Bot's own window, the person busy, a locked screen)", async () => {
    linux.setSupported(true);
    const { child } = fakeHelper({
      ping: { locked: false, idle: 0 },
      geometry: { x: 0, y: 0, width: 1280, height: 800, backing: 1 },
      click: refusal("That's ADT Bot itself: bots can't operate its window.", "self"),
      key: refusal("Pressing the key: the user is using this PC right now.", "busy"),
    });
    linux.setHelper(child);
    await expect(linux.click({ x: 10, y: 10 })).rejects.toMatchObject({ code: "self" });
    await expect(linux.key({ combo: "enter" })).rejects.toMatchObject({ code: "busy" });
    linux.setHelper(fakeHelper({ ping: { locked: true, idle: 9 } }).child);
    await expect(linux.key({ combo: "enter" })).rejects.toThrow(/locked/);
  });

  it("quits the app the helper matched, and never ADT Bot itself", async () => {
    linux.setSupported(true);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { child, sent } = fakeHelper({ find: { name: "gnome-calculator", pid: 4242 } });
    linux.setHelper(child);
    expect(await linux.quitApp({ name: "Calculator" })).toEqual({ ok: true, quit: ["gnome-calculator"] });
    expect(sent.find((r) => r.cmd === "find")).toMatchObject({ name: "Calculator" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    kill.mockClear();
    linux.setHelper(fakeHelper({ find: { name: "electron", pid: process.pid } }).child);
    await expect(linux.quitApp({ name: "ADT Bot" })).rejects.toThrow(/isn't running/);
    linux.setHelper(fakeHelper({ find: refusal('"Nope" isn\'t running.', "not-running") }).child);
    await expect(linux.quitApp({ name: "Nope" })).rejects.toThrow(/"Nope" isn't running/);
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it("reports what works on this desktop", async () => {
    linux.setSupported(true);
    linux.setHelper(fakeHelper({ ping: { locked: false, idle: 3, session: "wayland", atspi: true, input: "portal", screenshot: "portal", missing: [] } }).child);
    const perms = await linux.permissions();
    expect(perms).toMatchObject({ supported: true, platform: "linux", accessibility: true, screenRecording: "granted" });
    expect(perms.linux).toEqual({ session: "wayland", atspi: true, input: "portal", screenshot: "portal", missing: [], error: undefined });
  });
});

describe("ADT Bot's own windows", () => {
  type Listener = (event: unknown, input?: unknown) => void;
  /** A stand-in Electron window: whether it has the keyboard, its page's shield, and its input events. */
  function fakeWindow(focused: boolean, { answers = true } = {}) {
    const shield: boolean[] = [];
    const listeners: Record<string, Listener[]> = {};
    const contents = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, on: boolean) => {
        if (channel !== "adt-shield") return;
        shield.push(on);
        if (answers) queueMicrotask(() => linux.shieldAck(7));
      },
      on: (name: string, fn: Listener) => (listeners[name] ??= []).push(fn),
      off: (name: string, fn: Listener) => (listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn)),
    };
    const win = { isDestroyed: () => false, webContents: contents };
    linux.setBrowserWindow({ getFocusedWindow: () => (focused ? win : null), getAllWindows: () => [win] });
    const emit = (name: string, event: unknown, input?: unknown) => (listeners[name] ?? []).forEach((fn) => fn(event, input));
    return { shield, emit, listening: () => Object.values(listeners).flat().length };
  }
  const screen = { x: 0, y: 0, width: 1280, height: 800, backing: 1 };

  it("keeps keys for the app in front out of ADT Bot while it has the keyboard", async () => {
    linux.setSupported(true);
    fakeWindow(true);
    const { child, sent } = fakeHelper({ ping: { locked: false, idle: 9, session: "x11" }, type: { typed: 2, to: "app" }, key: { ok: true, to: "app" } });
    linux.setHelper(child);
    await expect(linux.key({ combo: "enter" })).rejects.toMatchObject({ code: "self" });
    await expect(linux.typeText({ text: "hi" })).rejects.toThrow(/would go to ADT Bot/);
    expect(sent.some((r) => r.cmd === "key" || r.cmd === "type")).toBe(false);
    // On X11 the helper brings a named app forward first, so naming it is fine.
    expect(await linux.typeText({ text: "hi", app: "Text Editor" })).toMatchObject({ to: "app" });
  });

  it("on Wayland refuses keys while ADT Bot has the keyboard, even with an app named", async () => {
    linux.setSupported(true);
    fakeWindow(true);
    linux.setHelper(fakeHelper({ ping: { locked: false, idle: 9, session: "wayland" }, key: { ok: true, to: "app" } }).child);
    await expect(linux.key({ combo: "enter", app: "Text Editor" })).rejects.toThrow(/Click the app's window first/);
  });

  it("drops a bot's click that lands on ADT Bot, and tells the bot", async () => {
    linux.setSupported(true);
    const win = fakeWindow(false);
    let shieldDuringClick: boolean | undefined;
    const { child, sent } = fakeHelper({
      ping: { locked: false, idle: 9, session: "wayland" },
      geometry: screen,
      click: () => {
        shieldDuringClick = win.shield.at(-1);
        win.emit("input-event", {}, { type: "mouseMove" });
        win.emit("input-event", {}, { type: "mouseDown" });
        return { ok: true };
      },
    });
    linux.setHelper(child);
    await expect(linux.click({ x: 100, y: 100 })).rejects.toMatchObject({ code: "self", message: expect.stringMatching(/on ADT Bot's own window/) });
    expect(shieldDuringClick).toBe(true);
    expect(win.shield).toEqual([true, false]);
    expect(win.listening()).toBe(0);
    expect(sent.find((r) => r.cmd === "click")).toMatchObject({ shielded: true });
  });

  it("lets a click elsewhere through as usual (passing over ADT Bot is fine)", async () => {
    linux.setSupported(true);
    const win = fakeWindow(false);
    const { child } = fakeHelper({
      ping: { locked: false, idle: 9, session: "wayland" },
      geometry: screen,
      click: () => {
        win.emit("input-event", {}, { type: "mouseMove" });
        return { ok: true };
      },
    });
    linux.setHelper(child);
    expect(await linux.click({ x: 300, y: 300 })).toMatchObject({ ok: true });
    expect(win.shield).toEqual([true, false]);
  });

  it("stops keys that reach ADT Bot before its page or menus see them, even when Electron can't tell it has focus", async () => {
    linux.setSupported(true);
    const win = fakeWindow(false);
    let prevented = 0;
    const { child } = fakeHelper({
      ping: { locked: false, idle: 9, session: "wayland" },
      type: () => {
        win.emit("before-input-event", { preventDefault: () => prevented++ }, { type: "keyDown", key: "h" });
        return { typed: 2, to: "front" };
      },
    });
    linux.setHelper(child);
    await expect(linux.typeText({ text: "hi" })).rejects.toThrow(/went to ADT Bot/);
    expect(prevented).toBe(1);
  });

  it("when its page doesn't answer, leaves the helper's own check on", async () => {
    linux.setSupported(true);
    fakeWindow(false, { answers: false });
    const { child, sent } = fakeHelper({ ping: { locked: false, idle: 9, session: "wayland" }, geometry: screen, click: { ok: true } });
    linux.setHelper(child);
    await linux.click({ x: 100, y: 100 });
    expect(sent.find((r) => r.cmd === "click")).toMatchObject({ shielded: false });
  });
});

describe("feature registration", () => {
  const register = (platform: "darwin" | "linux", mode = "restricted") => {
    linux.setSupported(platform === "linux");
    const handlers: Record<string, (e: unknown, payload?: unknown) => unknown> = {};
    const ipcMain = { handle: (ch: string, fn: (e: unknown, payload?: unknown) => unknown) => (handlers[ch] = fn) };
    require("../../../electron/features/76-linux-control.cjs").register({ app: undefined, ipcMain, shell: {}, access: { mode }, onStopAll: () => undefined });
    return handlers;
  };

  it("registers the adt:mac:* channels only on Linux", () => {
    expect(Object.keys(register("darwin"))).toEqual([]);
    const channels = Object.keys(register("linux"));
    for (const ch of ["ui", "press", "click", "key", "screenshot", "status", "connect", "applescript"]) expect(channels).toContain(`adt:mac:${ch}`);
  });

  it("acts on nothing in Sandbox mode, and keeps macOS-only tools clearly unavailable", async () => {
    const handlers = register("linux", "sandbox");
    expect(() => handlers["adt:mac:click"]({}, { x: 1, y: 1 })).toThrow(/Sandbox/);
    const open = register("linux");
    expect(() => open["adt:mac:applescript"]({}, {})).toThrow(/isn't available on Linux/);
  });
});

describe("renderer tools on Linux", () => {
  it("exposes the cross-platform tools and hides the macOS-only ones", async () => {
    vi.stubGlobal("window", { adtbotDesktop: { platform: "linux", proxyToken: "", version: "44", invoke: vi.fn() } });
    const { macTools } = await import("./tools");
    const { setMacControlEnabled, isLinuxDesktop, platformComputerNoun } = await import("./store");
    setMacControlEnabled(true);
    const ctx = { settings: { agent: { access: "restricted" } } } as never;
    const by = Object.fromEntries(macTools.map((t) => [t.name, t]));
    expect(isLinuxDesktop()).toBe(true);
    expect(platformComputerNoun()).toBe("PC");
    for (const name of ["mac_click", "mac_ui", "mac_screenshot", "mac_type", "mac_key", "mac_open_app"]) expect(by[name].available?.(ctx)).toBe(true);
    for (const name of ["mac_applescript", "mac_browser", "mac_find_text"]) expect(by[name].available?.(ctx)).toBe(false);
    expect(by.mac_click.available?.({ settings: { agent: { access: "sandbox" } } } as never)).toBe(false);
    setMacControlEnabled(false);
    vi.unstubAllGlobals();
  });
});
