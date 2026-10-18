// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const mac = require("../../../electron/features/70-mac-control.cjs")._test;

describe("coordinate scaling", () => {
  it("maps screenshot pixels back to display points (Retina, downscaled to 1280)", () => {
    const frame = mac.defaultFrame({ width: 1440, height: 900, backing: 2 });
    expect(frame.scale).toBeCloseTo(1280 / 1440);
    expect(mac.toScreenPoint(frame, 640, 400)).toEqual({ x: 720, y: 450 });
    expect(mac.toScreenPoint(frame, 1280, 800)).toEqual({ x: 1440, y: 900 });
    expect(mac.toImagePoint(frame, 720, 450)).toEqual({ x: 640, y: 400 });
  });

  it("keeps small non-Retina screens at native size", () => {
    const frame = mac.defaultFrame({ width: 1024, height: 768, backing: 1 });
    expect(frame.scale).toBe(1);
    expect(mac.toScreenPoint(frame, 100, 50)).toEqual({ x: 100, y: 50 });
  });

  it("offsets region and window captures by their origin", () => {
    const frame = mac.frameFor({ x: 74, y: 30, width: 1314, height: 835 }, 1280);
    const p = mac.toScreenPoint(frame, 0, 0);
    expect(p).toEqual({ x: 74, y: 30 });
    expect(mac.toScreenPoint(frame, 1280, 0).x).toBe(74 + 1314);
  });

  it("rejects non-numeric coordinates", () => {
    expect(() => mac.toScreenPoint({ originX: 0, originY: 0, scale: 1 }, "abc", 1)).toThrow(/numbers/);
    expect(() => mac.toScreenPoint({ originX: 0, originY: 0, scale: 1 }, NaN, 1)).toThrow();
  });
});

describe("key combos", () => {
  it("parses modifiers and named keys", () => {
    expect(mac.parseCombo("cmd+shift+4")).toEqual({ modifiers: ["command", "shift"], character: "4", label: "command+shift+4" });
    expect(mac.parseCombo("enter")).toMatchObject({ modifiers: [], keyCode: 36 });
    expect(mac.parseCombo("ctrl-alt-left")).toMatchObject({ modifiers: ["control", "option"], keyCode: 123 });
    expect(mac.parseCombo("Cmd+S")).toMatchObject({ modifiers: ["command"], character: "S" });
    expect(mac.parseCombo("cmd++")).toMatchObject({ modifiers: ["command"], character: "+" });
    expect(mac.parseCombo("esc").keyCode).toBe(53);
    expect(mac.parseCombo("f5").keyCode).toBe(96);
  });

  it("rejects unknown keys, lone modifiers and junk", () => {
    expect(() => mac.parseCombo("")).toThrow();
    expect(() => mac.parseCombo("shift")).toThrow(/on its own/);
    expect(() => mac.parseCombo("hyper+a")).toThrow(/modifier/);
    expect(() => mac.parseCombo("notakey")).toThrow(/Unknown key/);
  });

  it("builds argv for the key script", () => {
    expect(mac.keyArgs(mac.parseCombo("cmd+shift+t"))).toEqual(["char", "t", "command,shift"]);
    expect(mac.keyArgs(mac.parseCombo("down"))).toEqual(["code", "125", ""]);
  });

  it("builds argv for clicks", () => {
    expect(mac.clickArgs({ x: 10, y: 20 }, "right", 1)).toEqual(["10", "20", "1", "1"]);
    expect(mac.clickArgs({ x: 10, y: 20 }, "left", 9)).toEqual(["10", "20", "0", "3"]);
    expect(() => mac.clickArgs({ x: 1, y: 1 }, "evil")).toThrow();
  });
});

describe("osascript argv (no injection)", () => {
  const evil = ['"; do shell script "touch /tmp/pwned"; "', "-e", "') + run('x", "--", "${HOME}"];

  it("keeps the script fixed and passes user values verbatim after --", () => {
    const args = mac.osascriptArgs(mac.scripts.TYPE_JXA, evil);
    expect(args.slice(0, 5)).toEqual(["-l", "JavaScript", "-e", mac.scripts.TYPE_JXA, "--"]);
    expect(args.slice(5)).toEqual(evil);
  });

  it("scripts read their inputs from argv only", () => {
    for (const [name, source] of Object.entries(mac.scripts) as [string, string][]) {
      if (name === "CLIPBOARD_FNS") continue;
      expect(source, name).toMatch(/function run\((argv)?\)/);
      expect(source, name).not.toContain("${");
    }
    expect(mac.scripts.TYPE_JXA).toContain("argv[0]");
    expect(mac.scripts.KEY_JXA).toContain("argv[2]");
    expect(mac.scripts.QUIT_JXA).toContain("argv[0]");
  });

  it("detects missing permissions from stderr", () => {
    expect(mac.detectPermission("execution error: System Events got an error: osascript is not allowed assistive access. (-1719)")).toBe("accessibility");
    expect(mac.detectPermission("Not authorized to send Apple events to System Events. (-1743)")).toBe("automation");
    expect(mac.detectPermission("could not create image from display")).toBe("screen-recording");
    expect(mac.detectPermission("syntax error")).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")("every script compiles, and hostile argv comes back as plain data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adt-mac-test-"));
    try {
      for (const [name, source] of Object.entries(mac.scripts) as [string, string][]) {
        if (name === "CLIPBOARD_FNS") continue;
        expect(() => execFileSync("/usr/bin/osacompile", ["-l", "JavaScript", "-o", join(dir, "s.scpt"), "-e", source], { stdio: "pipe" }), name).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const echoed = await mac.jxa("function run(argv) { return JSON.stringify(argv); }", evil, "echo");
    expect(JSON.parse(echoed)).toEqual(evil);
  });
});

describe("renderer tools", () => {
  const invoke = vi.fn();
  vi.stubGlobal("window", { adtbotDesktop: { platform: "darwin", proxyToken: "", version: "44", invoke } });
  afterAll(() => vi.unstubAllGlobals());

  it("are unavailable until the user allows Mac control", async () => {
    const { macTools } = await import("./tools");
    const { setMacControlEnabled } = await import("./store");
    const ctx = {} as never;
    expect(macTools.every((t) => t.available?.(ctx) === false)).toBe(true);
    setMacControlEnabled(true);
    expect(macTools.every((t) => t.available?.(ctx) === true)).toBe(true);
    setMacControlEnabled(false);
  });

  it("declares risks: looking is read-only, acting asks, AppleScript and quitting always ask", async () => {
    const { macTools } = await import("./tools");
    const risk = Object.fromEntries(macTools.map((t) => [t.name, t.risk]));
    expect(risk).toMatchObject({ mac_screenshot: "read", mac_list_apps: "read", mac_click: "write", mac_type: "write", mac_key: "write", mac_scroll: "write", mac_drag: "write", mac_open_app: "write", mac_applescript: "destructive" });
    const open = macTools.find((t) => t.name === "mac_open_app")!;
    expect(open.riskFor?.({ action: "quit", app: "Notes" })).toBe("destructive");
    expect(macTools.every((t) => t.group === "mac" && t.platforms?.includes("desktop"))).toBe(true);
  });

  it("mac_screenshot returns the image for the model and for the chat, and drives the banner", async () => {
    const { macTools } = await import("./tools");
    const { useMacControl } = await import("./store");
    let activeDuring = 0;
    invoke.mockImplementation(async (channel: string) => {
      activeDuring = useMacControl.getState().active;
      if (channel === "adt:mac:screenshot") return { mediaType: "image/jpeg", data: "QUJD", width: 1280, height: 800, scale: 0.89, origin: { x: 0, y: 0 }, screen: { width: 1440, height: 900, backing: 2 } };
      throw new Error("unexpected");
    });
    const result = (await macTools.find((t) => t.name === "mac_screenshot")!.run({}, {} as never)) as Exclude<Awaited<ReturnType<AgentTool["run"]>>, string>;
    expect(result.image).toEqual({ mediaType: "image/jpeg", data: "QUJD" });
    expect(result.display).toEqual({ kind: "image", src: "data:image/jpeg;base64,QUJD", caption: "Screenshot 1280×800" });
    expect(result.content).toContain("1280×800");
    expect(activeDuring).toBe(1);
    expect(useMacControl.getState().active).toBe(0);
  });

  it("passes clean errors through from the main process", async () => {
    const { macTools } = await import("./tools");
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'adt:mac:key': Error: Unknown key \"zz\"."));
    await expect(macTools.find((t) => t.name === "mac_key")!.run({ combo: "zz" }, {} as never)).rejects.toThrow(/^Unknown key "zz"\.$/);
  });
});

type AgentTool = import("../../lib/agent/tools").AgentTool;
