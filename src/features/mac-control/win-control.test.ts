// @vitest-environment node
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// The feature is a .cjs module; its _test surface is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win: any = require("../../../electron/features/75-win-control.cjs")._test;

/** A stand-in for the PowerShell child: it auto-answers each request from a map of cmd -> result. */
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
        const result = typeof replies[req.cmd] === "function" ? (replies[req.cmd] as (r: unknown) => unknown)(req) : replies[req.cmd];
        setImmediate(() => stdout.emit("data", `${JSON.stringify(result === undefined ? { id: req.id, error: `no reply for ${req.cmd}` } : { id: req.id, result })}\n`));
      },
    },
    on: () => undefined,
    kill: () => undefined,
  };
  return { child, sent };
}

afterEach(() => {
  win.setHelper(null);
  win.setSupported(process.platform === "win32");
  win.resetFrame();
});

describe("coordinate scaling", () => {
  it("maps screenshot pixels back to screen pixels and back", () => {
    const frame = win.defaultFrame({ x: 0, y: 0, width: 1920, height: 1080, backing: 1 }, 1280);
    expect(frame.scale).toBeCloseTo(1280 / 1920);
    expect(win.toScreenPoint(frame, 640, 360)).toEqual({ x: 960, y: 540 });
    expect(win.toImagePoint(frame, 960, 540)).toEqual({ x: 640, y: 360 });
  });

  it("offsets a region/window frame by its origin", () => {
    const frame = win.frameFor({ x: 100, y: 50, width: 800, height: 600 }, 800);
    expect(win.toScreenPoint(frame, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(win.toScreenPoint(frame, 800, 0).x).toBe(900);
  });

  it("rejects non-numeric coordinates", () => {
    expect(() => win.toScreenPoint({ originX: 0, originY: 0, scale: 1 }, "x" as never, 1)).toThrow(/numbers/);
  });
});

describe("key combos (Windows virtual-key codes)", () => {
  it("parses modifiers and named keys", () => {
    expect(win.parseCombo("ctrl+shift+t")).toEqual({ modifiers: ["control", "shift"], character: "t", label: "control+shift+t" });
    expect(win.parseCombo("enter")).toMatchObject({ modifiers: [], keyCode: 13 });
    expect(win.parseCombo("alt-left")).toMatchObject({ modifiers: ["option"], keyCode: 37 });
    expect(win.parseCombo("ctrl++")).toMatchObject({ modifiers: ["control"], character: "+" });
    expect(win.parseCombo("f5").keyCode).toBe(116);
    // "cmd"/"win" fold to Ctrl so cross-platform shortcuts still work on Windows.
    expect(win.parseCombo("cmd+c")).toMatchObject({ modifiers: ["command"], character: "c" });
  });

  it("rejects unknown keys, lone modifiers and junk", () => {
    expect(() => win.parseCombo("")).toThrow();
    expect(() => win.parseCombo("shift")).toThrow(/on its own/);
    expect(() => win.parseCombo("hyper+a")).toThrow(/modifier/);
    expect(() => win.parseCombo("notakey")).toThrow(/Unknown key/);
  });

  it("builds helper payloads for keys and clicks", () => {
    expect(win.keyPayload(win.parseCombo("ctrl+s"), "Notepad")).toEqual({ modifiers: ["control"], char: "s", app: "Notepad" });
    expect(win.keyPayload(win.parseCombo("down"))).toEqual({ modifiers: [], code: 40 });
    expect(win.clickPayload({ x: 10, y: 20 }, "right", 1)).toEqual({ x: 10, y: 20, button: "right", clicks: 1 });
    expect(win.clickPayload({ x: 1, y: 1 }, "left", 9)).toEqual({ x: 1, y: 1, button: "left", clicks: 3 });
    expect(() => win.clickPayload({ x: 1, y: 1 }, "evil")).toThrow();
  });
});

describe("app names and links (no code execution)", () => {
  it("accepts Start-menu names, rejects paths, scripts and newlines", () => {
    expect(win.appName("Notepad")).toBe("Notepad");
    expect(win.appName("  WhatsApp  ")).toBe("WhatsApp");
    for (const bad of ["C:\\Windows\\System32\\cmd.exe", "evil.bat", "x.ps1", "a/b", 'a"b', "a\nb", "run.vbs"]) {
      expect(() => win.appName(bad), bad).toThrow();
    }
  });

  it("opens app and messaging links but nothing that runs code or reads files", () => {
    for (const ok of ["https://x.org", "mailto:a@b.c", "tel:+1555", "whatsapp://send?phone=1&text=hi", "ms-settings:display", "spotify:track:1"]) expect(win.APP_LINK.test(ok), ok).toBe(true);
    for (const bad of ["file:///C:/secret.txt", "javascript:alert(1)", "vbscript:x", "smb://h/s", "C:\\x.exe", "ssh://h"]) expect(win.APP_LINK.test(bad), bad).toBe(false);
  });
});

describe("JSON-lines protocol", () => {
  it("reassembles split chunks and matches replies by id", async () => {
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
    stdout.setEncoding = () => undefined;
    const child = { stdout, stdin: { on: () => undefined, write: () => undefined }, on: () => undefined, kill: () => undefined };
    const h = win.createHelper(child as never);
    const got: unknown[] = [];
    h.pending.set(1, (m: unknown) => got.push(m));
    h.pending.set(2, (m: unknown) => got.push(m));
    // One reply arrives in two chunks; a second reply rides along on the same chunk.
    stdout.emit("data", '{"id":1,"resu');
    stdout.emit("data", 'lt":{"ok":true}}\n{"id":2,');
    stdout.emit("data", '"error":"nope","code":"busy"}\n');
    expect(got).toEqual([
      { id: 1, result: { ok: true } },
      { id: 2, error: "nope", code: "busy" },
    ]);
  });
});

describe("requests through a scripted helper", () => {
  it("snapshots an app and places each element's centre in screenshot pixels", async () => {
    win.setSupported(true);
    const { child, sent } = fakeHelper({
      ping: { locked: false, idle: 9 },
      geometry: { x: 0, y: 0, width: 1920, height: 1080, backing: 1 },
      snapshot: {
        name: "notepad",
        pid: 42,
        window: "Untitled - Notepad",
        windows: ["Untitled - Notepad"],
        elements: [{ id: 1, role: "text area", label: "Text Editor", input: true, frame: { x: 0, y: 40, w: 1920, h: 1000 } }],
        matched: 1,
        truncated: false,
        frontmost: true,
      },
    });
    win.setHelper(child);
    const snap = await win.ui({ app: "Notepad", max: 50 });
    expect(sent.find((r) => r.cmd === "snapshot")).toMatchObject({ app: "Notepad", max: 50 });
    // scale = 1280/1920; element centre (960, 540) -> (640, 360).
    expect(snap.elements[0].at).toEqual({ x: 640, y: 360 });
  });

  it("sends a parsed key combo to the named app and reports where it went", async () => {
    win.setSupported(true);
    const { child, sent } = fakeHelper({ ping: { locked: false, idle: 9 }, key: { ok: true, to: "app" } });
    win.setHelper(child);
    const out = await win.key({ combo: "ctrl+s", app: "Notepad" });
    const req = sent.find((r) => r.cmd === "key");
    expect(req).toMatchObject({ char: "s", modifiers: ["control"], app: "Notepad" });
    expect(req).not.toHaveProperty("code");
    expect(out).toEqual({ ok: true, label: "control+s", to: "app" });
  });

  it("clicks at screenshot pixels turned into screen pixels", async () => {
    win.setSupported(true);
    const { child, sent } = fakeHelper({ ping: { locked: false, idle: 9 }, geometry: { x: 0, y: 0, width: 1920, height: 1080, backing: 1 }, click: { ok: true } });
    win.setHelper(child);
    await win.click({ x: 640, y: 360 });
    expect(sent.find((r) => r.cmd === "click")).toMatchObject({ x: 960, y: 540, button: "left", clicks: 1 });
  });

  it("unwraps the apps list and refuses to open a path as an app", async () => {
    win.setSupported(true);
    const { child } = fakeHelper({ apps: { apps: [{ name: "notepad", pid: 1, active: true, hidden: false }] } });
    win.setHelper(child);
    expect(await win.listApps()).toEqual([{ name: "notepad", pid: 1, active: true, hidden: false }]);
    await expect(win.openApp({ name: "C:\\Windows\\System32\\cmd.exe" })).rejects.toThrow(/Start menu/);
  });

  it("surfaces a helper refusal with its code, and blocks acting while the screen is locked", async () => {
    win.setSupported(true);
    const { child } = fakeHelper({ ping: { locked: true, idle: 9 } });
    win.setHelper(child);
    await expect(win.key({ combo: "enter" })).rejects.toThrow(/locked/);
  });
});

describe("feature registration", () => {
  const register = (platform: "darwin" | "win32") => {
    win.setSupported(platform === "win32");
    const channels: string[] = [];
    const ipcMain = { handle: (ch: string) => channels.push(ch) };
    require("../../../electron/features/75-win-control.cjs").register({ app: undefined, ipcMain, shell: {}, access: { mode: "restricted" }, onStopAll: () => undefined });
    return channels;
  };

  it("registers the adt:mac:* channels only on Windows", () => {
    expect(register("darwin")).toEqual([]);
    const channels = register("win32");
    expect(channels).toContain("adt:mac:ui");
    expect(channels).toContain("adt:mac:press");
    expect(channels).toContain("adt:mac:screenshot");
    expect(channels).toContain("adt:mac:status");
    // Mac-only channels keep a clear error rather than silently doing nothing.
    expect(channels).toContain("adt:mac:applescript");
  });
});

describe("renderer tools on Windows", () => {
  it("exposes the cross-platform tools, hides the macOS-only ones, and reads \"PC\"", async () => {
    vi.stubGlobal("window", { adtbotDesktop: { platform: "win32", proxyToken: "", version: "44", invoke: vi.fn() } });
    const { macTools } = await import("./tools");
    const { setMacControlEnabled } = await import("./store");
    setMacControlEnabled(true);
    const ctx = { settings: { agent: { access: "restricted" } } } as never;
    const by = Object.fromEntries(macTools.map((t) => [t.name, t]));
    expect(by.mac_click.available?.(ctx)).toBe(true);
    expect(by.mac_ui.available?.(ctx)).toBe(true);
    // AppleScript, browser scripting and screen OCR don't exist on Windows.
    expect(by.mac_applescript.available?.(ctx)).toBe(false);
    expect(by.mac_clipboard.available?.(ctx)).toBe(true);
    expect(by.mac_browser.available?.(ctx)).toBe(false);
    expect(by.mac_find_text.available?.(ctx)).toBe(false);
    // Nothing runs in Sandbox mode.
    expect(by.mac_click.available?.({ settings: { agent: { access: "sandbox" } } } as never)).toBe(false);
    const { platformComputerNoun } = await import("./store");
    expect(platformComputerNoun()).toBe("PC");
    expect(by.mac_click.description).toContain("this PC's screen");
    setMacControlEnabled(false);
    vi.unstubAllGlobals();
  });
});

describe("the PowerShell script", () => {
  const pwsh = (() => {
    for (const exe of ["pwsh", "powershell"]) {
      try {
        execFileSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "pipe" });
        return exe;
      } catch {
        // not installed
      }
    }
    return null;
  })();

  it.runIf(pwsh)("parses without syntax errors (both helper files)", () => {
    for (const file of ["win-helper.ps1", "win-helper.native.ps1"]) {
      const script = require("node:path").join(__dirname, "..", "..", "..", "electron", "native", file);
      const check = `$ErrorActionPreference='Stop'; $null=[ScriptBlock]::Create((Get-Content -Raw -LiteralPath '${script}')); 'ok'`;
      expect(() => execFileSync(pwsh as string, ["-NoProfile", "-Command", check], { stdio: "pipe" }), file).not.toThrow();
    }
  });
});
