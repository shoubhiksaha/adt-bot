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

  it("are unavailable until the user allows Mac control or gives full access, and never in the sandbox", async () => {
    const { macTools } = await import("./tools");
    const { setMacControlEnabled } = await import("./store");
    const ctx = (access: string) => ({ settings: { agent: { access } } }) as never;
    const all = (access: string) => macTools.every((t) => t.available?.(ctx(access)) === true);
    const none = (access: string) => macTools.every((t) => t.available?.(ctx(access)) === false);
    expect(none("restricted")).toBe(true);
    expect(all("full")).toBe(true);
    setMacControlEnabled(true);
    expect(all("restricted")).toBe(true);
    expect(none("sandbox")).toBe(true);
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

  it("mac_open_app says where a page really opened", async () => {
    const { macTools } = await import("./tools");
    const open = macTools.find((t) => t.name === "mac_open_app")!;
    // The main process opens a page in the app asked for on a Mac; elsewhere it can only use the default browser.
    invoke.mockImplementation(async (channel: string, payload: { url: string; app?: string }) =>
      channel === "adt:mac:openUrl" ? { ok: true, url: payload.url, ...(payload.app === "Google Chrome" ? { app: payload.app } : {}) } : null,
    );
    expect(await open.run({ app: "Google Chrome", url: "https://youtube.com" }, {} as never)).toBe("Opened https://youtube.com in Google Chrome.");
    expect(invoke).toHaveBeenLastCalledWith("adt:mac:openUrl", { url: "https://youtube.com", app: "Google Chrome" });
    expect(await open.run({ app: "Chrome", url: "https://youtube.com" }, {} as never)).toBe("Opened https://youtube.com in the default browser (Chrome can't be chosen here).");
    expect(await open.run({ url: "https://youtube.com" }, {} as never)).toBe("Opened https://youtube.com in the default browser.");
  });

  it("passes clean errors through from the main process", async () => {
    const { macTools } = await import("./tools");
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'adt:mac:key': Error: Unknown key \"zz\"."));
    await expect(macTools.find((t) => t.name === "mac_key")!.run({ combo: "zz" }, {} as never)).rejects.toThrow(/^Unknown key "zz"\.$/);
  });
});

describe("accessibility elements", () => {
  const snap = (elements: UiElement[]): UiSnapshot => ({ name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp", pid: 1, window: "WhatsApp", windows: ["WhatsApp"], elements, matched: elements.length, truncated: false, frontmost: false });
  const els: UiElement[] = [
    { id: 1, role: "button", label: "Chats", at: { x: 10, y: 10 } },
    { id: 2, role: "search field", label: "Search", input: true, at: { x: 100, y: 40 } },
    { id: 3, role: "button", label: "Ma", value: "Your message, 5:58 AM", at: { x: 100, y: 90 } },
    { id: 4, role: "button", label: "Mansi", value: "See you", at: { x: 100, y: 130 } },
    { id: 5, role: "text", label: "Chats" },
    { id: 6, role: "button", label: "Send", disabled: true },
    { id: 7, role: "link", label: "Send" },
  ];

  it("picks the element a name means, preferring exact, actionable and enabled matches", async () => {
    const { pickElement } = await import("./ui");
    expect(pickElement(els, "chats")).toMatchObject({ element: { id: 1 } });
    expect(pickElement(els, "\u200eMa")).toMatchObject({ element: { id: 3 } });
    expect(pickElement(els, "mans")).toMatchObject({ element: { id: 4 } });
    expect(pickElement(els, "search", "field")).toMatchObject({ element: { id: 2 } });
    expect(pickElement(els, "send")).toMatchObject({ element: { id: 7 } });
    expect(pickElement(els, "nobody")).toMatchObject({ error: expect.stringMatching(/Nothing called/) });
    // An unnamed field, called by its kind.
    expect(pickElement([...els, { id: 8, role: "text area", input: true }], "text area")).toMatchObject({ element: { id: 8 } });
    expect(pickElement([...els, { id: 8, role: "text area" }, { id: 9, role: "text area" }], "text area")).toMatchObject({ error: expect.stringMatching(/Several/) });
  });

  it("asks the model to choose when different elements match equally", async () => {
    const { pickElement } = await import("./ui");
    const twin: UiElement[] = [
      { id: 1, role: "button", label: "Open", at: { x: 1, y: 1 } },
      { id: 2, role: "link", label: "Open", at: { x: 1, y: 2 } },
    ];
    const pick = pickElement(twin, "open");
    expect("error" in pick && pick.error).toMatch(/Several elements match[\s\S]*\[1\][\s\S]*\[2\]/);
  });

  it("formats a compact list with ids, values and positions", async () => {
    const { formatUi } = await import("./ui");
    const text = formatUi(snap(els.slice(0, 3)));
    expect(text.split("\n")[0]).toBe('WhatsApp — window "WhatsApp" (in the background)');
    expect(text).toContain('[2] search field "Search" = "" @(100,40)');
    expect(text).toContain('[3] button "Ma" — "Your message, 5:58 AM" @(100,90)');
    expect(formatUi({ ...snap(els), matched: 50 }, 2)).toMatch(/48 more not shown/);
  });

  it("presses by text, then shows the window again; risky buttons always ask", async () => {
    const invoke = vi.fn();
    vi.stubGlobal("window", { adtbotDesktop: { platform: "darwin", proxyToken: "", version: "44", invoke } });
    const calls: string[] = [];
    invoke.mockImplementation(async (channel: string, payload: { element?: number }) => {
      calls.push(`${channel.replace("adt:mac:", "")}${payload?.element ? `:${payload.element}` : ""}`);
      if (channel === "adt:mac:ui") return snap([...els, { id: 9, role: "button", label: "Delete chat" }]);
      if (channel === "adt:mac:press") return { method: "AXPress" };
      throw new Error("unexpected " + channel);
    });
    const { macTools } = await import("./tools");
    const press = macTools.find((t) => t.name === "mac_press")!;
    const out = (await press.run({ text: "Mansi", app: "WhatsApp" }, {} as never)) as { content: string };
    expect(calls).toEqual(["ui", "press:4", "ui"]);
    expect(out.content).toMatch(/^Pressed button "Mansi" \[4\]\.\n\nNow:\nWhatsApp/);
    expect(press.riskFor?.({ id: 9 })).toBe("destructive");
    expect(press.riskFor?.({ id: 4 })).toBe("write");
    expect(press.riskFor?.({ text: "Remove member" })).toBe("destructive");
    const setText = macTools.find((t) => t.name === "mac_set_text")!;
    expect(setText.riskFor?.({ app: "Terminal", field: "x", text: "rm -rf ~" })).toBe("destructive");
    vi.unstubAllGlobals();
  });

  it("never claims a send that was skipped, and says why", async () => {
    const invoke = vi.fn();
    vi.stubGlobal("window", { adtbotDesktop: { platform: "darwin", proxyToken: "", version: "44", invoke } });
    const { macTools } = await import("./tools");
    const setText = macTools.find((t) => t.name === "mac_set_text")!;
    const key = macTools.find((t) => t.name === "mac_key")!;
    const results: Record<string, unknown>[] = [
      { typed: 5, background: "value", submitted: "send-button" },
      { typed: 5, submitted: "skipped", value: "dao" },
      { typed: 5, submitted: "skipped", reason: "busy", value: "hello" },
      { typed: 5, background: "value", submitted: "unconfirmed", value: "hello" },
    ];
    invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === "adt:mac:setText") return results.shift();
      if (channel === "adt:mac:ui") return { name: "WhatsApp", bundleId: "", pid: 1, window: "WhatsApp", windows: [], elements: [], matched: 0, truncated: false, frontmost: false };
      if (channel === "adt:mac:key") return { label: "enter", to: payload.app ? "app" : "front" };
      throw new Error("unexpected " + channel);
    });
    const run = async () => ((await setText.run({ id: 8, text: "hello", submit: true }, {} as never)) as { content: string }).content.split("\n")[0];
    expect(await run()).toMatch(/in the background.*and pressed Send\.$/);
    expect(await run()).toMatch(/Return was NOT pressed: the field or app changed/);
    expect(await run()).toMatch(/Return was NOT pressed: the user started using/);
    expect(await run()).toMatch(/still in the field: press the app's Send button/);
    expect(await key.run({ combo: "enter", app: "Notes" }, {} as never)).toBe("Pressed enter in Notes (in the background).");
    expect(await key.run({ combo: "enter" }, {} as never)).toBe("Pressed enter.");
    expect(mac.busyError("Clicking", 0.4).message).toMatch(/using this Mac right now \(keyboard or mouse used 0\.4 s ago\)/);
    vi.unstubAllGlobals();
  });

  it("opens app links (WhatsApp, mail, Maps…) but nothing that runs code or files", () => {
    for (const ok of ["whatsapp://send?phone=919800000000&text=hi", "mailto:a@b.c", "tel:+1555", "spotify:track:1", "https://x.org", "x-apple.systempreferences:com.apple.preference.security"]) expect(mac.APP_LINK.test(ok)).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "vnc://host", "smb://host/share", "/Applications/Terminal.app", "ssh://host"]) expect(mac.APP_LINK.test(bad)).toBe(false);
  });
});

describe("web pages in the browser", () => {
  it("builds a page script where the request can only be data", () => {
    const src: string = mac.pageScript({ op: "type", id: 3, text: "\")});alert(1);//\u2028</script>" });
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain(JSON.stringify("\")});alert(1);//").slice(0, -1));
    expect(src).not.toMatch(/\u2028/);
  });

  it("explains how to allow page access in each browser", () => {
    const off = new Error("Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.");
    // Chromium browsers: the bot switches it on itself with allow_page_access, never AppleScript.
    const brave = mac.browserError("Brave Browser", "chromium", off).message;
    expect(brave).toMatch(/"Allow JavaScript from Apple Events" is on \(View → Developer\)/);
    expect(brave).toMatch(/action "allow_page_access"/);
    expect(brave).toMatch(/Don't use AppleScript/);
    expect(mac.browserError("Safari", "safari", new Error("You must enable 'Allow JavaScript from Apple Events' in the Developer section")).message).toMatch(/Show features for web developers/);
    expect(mac.browserError("Arc", "chromium", new Error("ADT_NOT_RUNNING")).message).toBe("Arc isn't open. Open it first (mac_open_app).");
  });

  it("switches page access on by pressing once, checked by a page script (never toggled back off)", async () => {
    const off = new Error('Executing JavaScript through AppleScript is turned off. To turn it on, go to View > Developer > Allow JavaScript from Apple Events.');
    const setup = (onAfterPress: boolean, startsOn = false) => {
      let on = startsOn;
      const presses: unknown[] = [];
      return {
        presses,
        opts: {
          wait: 1,
          tries: 3,
          helperReady: () => true,
          run: async () => {
            if (!on) throw off;
            return "1";
          },
          helper: async (cmd: string, payload: unknown) => {
            presses.push([cmd, payload]);
            if (onAfterPress) on = true;
            return { found: true, title: "Allow JavaScript from Apple Events" };
          },
        },
      };
    };
    // Already on: nothing pressed.
    let t = setup(true, true);
    expect(await mac.allowPageAccess("Brave Browser", t.opts)).toMatchObject({ already: true });
    expect(t.presses).toEqual([]);
    // Off: pressed once, then confirmed.
    t = setup(true);
    expect(await mac.allowPageAccess("Brave Browser", t.opts)).toMatchObject({ ok: true, browser: "Brave Browser" });
    expect(t.presses).toEqual([["menuSetting", { app: "Brave Browser", words: ["javascript", "apple"], press: true }]]);
    // Still off after the press: not pressed again (that would switch it off); the user is asked.
    t = setup(false);
    await expect(mac.allowPageAccess("Brave Browser", t.opts)).rejects.toThrow(/pressed once \(not pressed again/);
    expect(t.presses).toHaveLength(1);
    // Safari: it lives in Safari's settings, so the user is told where.
    t = setup(true);
    await expect(mac.allowPageAccess("Safari", t.opts)).rejects.toThrow(/Settings → Developer/);
    expect(t.presses).toEqual([]);
  });

  it("opens a page in the browser asked for, starting it when it isn't open", async () => {
    const launched: string[][] = [];
    const launch = async (args: string[]) => void launched.push(args);
    const failing = (error: Error) => async () => {
      throw error;
    };
    // Running: a new tab there, nothing launched.
    expect(await mac.openPage("Google Chrome", "open", "https://youtube.com", { run: async () => "ok", launch })).toEqual({ browser: "Google Chrome", ok: true, url: "https://youtube.com" });
    expect(launched).toEqual([]);
    // Not running, or no window: started with the page (not left for the bot to open some other way).
    for (const code of ["ADT_NOT_RUNNING", "ADT_NO_WINDOW"]) {
      const run = failing(mac.browserError("Google Chrome", "chromium", new Error(code)));
      expect(await mac.openPage("Google Chrome", "open", "https://youtube.com", { run, launch })).toEqual({ browser: "Google Chrome", ok: true, url: "https://youtube.com", started: true });
    }
    expect(launched).toEqual([
      ["-a", "Google Chrome", "https://youtube.com"],
      ["-a", "Google Chrome", "https://youtube.com"],
    ]);
    // Not installed: said plainly. Anything else passes through.
    const notRunning = failing(mac.browserError("Arc", "chromium", new Error("ADT_NOT_RUNNING")));
    await expect(mac.openPage("Arc", "open", "https://a.b", { run: notRunning, launch: failing(new Error("Unable to find application named 'Arc'")) })).rejects.toThrow("Arc isn't installed on this Mac.");
    await expect(mac.openPage("Arc", "open", "https://a.b", { run: failing(new Error("boom")), launch })).rejects.toThrow("boom");
  });

  it("opens a web page in the app asked for; app links open in their own app", async () => {
    const opened: string[] = [];
    const shell = { openExternal: async (url: string) => void opened.push(url) };
    const launched: string[][] = [];
    const launch = async (args: string[]) => void launched.push(args);
    const failing = (error: Error) => async () => {
      throw error;
    };
    expect(await mac.openUrl(shell, { url: "https://youtube.com/x", app: "Google Chrome" }, launch)).toEqual({ ok: true, url: "https://youtube.com/x", app: "Google Chrome" });
    expect(launched).toEqual([["-a", "Google Chrome", "https://youtube.com/x"]]);
    expect(await mac.openUrl(shell, { url: "whatsapp://send?phone=1", app: "Google Chrome" }, launch)).toEqual({ ok: true, url: "whatsapp://send?phone=1" });
    expect(await mac.openUrl(shell, { url: "https://a.b" }, launch)).toEqual({ ok: true, url: "https://a.b" });
    expect(opened).toEqual(["whatsapp://send?phone=1", "https://a.b"]);
    await expect(mac.openUrl(shell, { url: "https://a.b", app: "/Users/x/evil.app" }, launch)).rejects.toThrow(/not a path/);
    await expect(mac.openUrl(shell, { url: "https://a.b", app: "Nope" }, failing(new Error("Unable to find application named 'Nope'")))).rejects.toThrow('No app named "Nope" is installed.');
    expect(launched).toHaveLength(1);
  });

  it("formats pages compactly and pages through long text", async () => {
    const { formatPage } = await import("./ui");
    const text = formatPage(
      {
        browser: "Brave Browser",
        url: "https://mail.example.com/",
        title: "Inbox",
        elements: [
          { id: 1, role: "search field", label: "Search mail", input: true, value: "" },
          { id: 2, role: "link", label: "Next", href: "https://mail.example.com/p2" },
          { id: 3, role: "button", label: "Far", offscreen: true },
        ],
        matched: 5,
        scroll: { y: 0, height: 3000, view: 800 },
        text: "Hello world",
        textLength: 20,
      },
      0,
    );
    expect(text).toContain('Brave Browser — "Inbox" https://mail.example.com/');
    expect(text).toContain('[1] search field "Search mail" = ""');
    expect(text).toContain('[2] link "Next" → https://mail.example.com/p2');
    expect(text).toContain("(scrolled out of view)");
    expect(text).toContain("2 more not shown");
    expect(text).toContain("There's more of the page below.");
    expect(text).toContain("read again with offset 11");
  });

  it("reading is free; clicking and typing ask; payments and passwords always ask", async () => {
    vi.stubGlobal("window", { adtbotDesktop: { platform: "darwin", proxyToken: "", version: "44", invoke: vi.fn() } });
    const { macTools } = await import("./tools");
    const browser = macTools.find((t) => t.name === "mac_browser")!;
    expect(browser.riskFor?.({ action: "read" })).toBe("read");
    expect(browser.riskFor?.({ action: "tabs" })).toBe("read");
    expect(browser.riskFor?.({ action: "click", element: "Next" })).toBe("write");
    expect(browser.riskFor?.({ action: "click", element: "Place order" })).toBe("destructive");
    expect(browser.riskFor?.({ action: "type", element: "Password", text: "x" })).toBe("destructive");
    expect(browser.riskFor?.({ action: "open", url: "https://x.org" })).toBe("write");
    vi.unstubAllGlobals();
  });

  it("switches page access on itself under Full access (no AppleScript), and asks first otherwise", async () => {
    let reads = 0;
    const calls: Record<string, unknown>[] = [];
    const invoke = vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      if (channel !== "adt:mac:browser") return undefined;
      calls.push(payload);
      if (payload.action === "allow_page_access") return { browser: "Brave Browser", ok: true };
      if (payload.action === "read" && reads++ === 0) {
        throw new Error('Brave Browser doesn\'t let apps read pages until "Allow JavaScript from Apple Events" is on (View → Developer).');
      }
      return { browser: "Brave Browser", url: "https://example.com/", title: "Example", elements: [] };
    });
    vi.stubGlobal("window", { adtbotDesktop: { platform: "darwin", proxyToken: "", version: "44", invoke } });
    const { macTools } = await import("./tools");
    const browser = macTools.find((t) => t.name === "mac_browser")!;
    const ctx = (access: "full" | "restricted", extra: Record<string, unknown> = {}) => ({ settings: { agent: { access, denylist: [] } }, ...extra }) as never;
    const out = (await browser.run({ action: "read" }, ctx("full"))) as { content: string };
    expect(out.content).toMatch(/^\(Turned on page access in Brave Browser first/);
    expect(calls.map((c) => c.action)).toEqual(["read", "allow_page_access", "read"]);
    // The browser whose read failed is the one switched, not whichever is in front by then.
    expect(calls[1].browser).toBe("Brave Browser");
    // Restrictive: the error goes back to the bot, which then asks (allow_page_access is a change).
    const refused = async (c: never) => {
      reads = 0;
      calls.length = 0;
      await expect(browser.run({ action: "read" }, c)).rejects.toThrow(/Allow JavaScript from Apple Events/);
      expect(calls.map((x) => x.action)).toEqual(["read"]);
    };
    await refused(ctx("restricted"));
    // Nor in a chat room (Full access doesn't apply there), after outside content, or past a deny rule.
    await refused(ctx("full", { shared: true }));
    await refused(ctx("full", { taint: { sources: new Set(["a web page"]) } }));
    await refused({ settings: { agent: { access: "full", denylist: ["allow_page_access"] } } } as never);
    expect(browser.riskFor?.({ action: "allow_page_access" })).toBe("write");
    expect(browser.summary?.({ action: "allow_page_access", browser: "Brave Browser" })).toMatch(/Turn on page access in Brave Browser/);
    vi.unstubAllGlobals();
  });

  it("finds recognized screen text by words", async () => {
    const { matchLines } = await import("./ui");
    const lines = [{ text: "Play Next Episode" }, { text: "Settings" }, { text: "next\u200e episode" }];
    expect(matchLines(lines, "next episode")).toHaveLength(2);
    expect(matchLines(lines, "")).toHaveLength(3);
  });
});

describe("recipes", () => {
  const steps = [
    { tool: "mac_open_app", args: { app: "WhatsApp" } },
    { tool: "mac_press", args: { text: "{{contact}}", app: "WhatsApp" } },
    { tool: "mac_set_text", args: { field: "Type a message", text: "{{message}}", submit: true } },
  ];

  it("validates: known tools only, names not ids, every placeholder declared", async () => {
    const { validateRecipe } = await import("./recipes");
    expect(validateRecipe({ name: "send whatsapp", params: ["contact", "message"], steps }).steps).toHaveLength(3);
    expect(() => validateRecipe({ name: "x", params: [], steps: [{ tool: "run_command", args: { command: "ls" } }] })).toThrow(/can't be used in a recipe/);
    expect(() => validateRecipe({ name: "x", params: [], steps: [{ tool: "mac_press", args: { id: 4 } }] })).toThrow(/instead of its id/);
    expect(() => validateRecipe({ name: "x", params: ["contact"], steps })).toThrow(/\{\{message\}\}, which isn't in params/);
    expect(() => validateRecipe({ name: "", params: [], steps })).toThrow(/short name/);
  });

  it("fills placeholders and takes the riskiest step's risk", async () => {
    const { fill, highestRisk, missingParams } = await import("./recipes");
    expect(fill(steps[2].args, { message: "on my way 🚗" })).toEqual({ field: "Type a message", text: "on my way 🚗", submit: true });
    expect(fill({ text: "Hi {{ name }}!" }, { name: "Ma" })).toEqual({ text: "Hi Ma!" });
    expect(highestRisk(["read", "write", "read"])).toBe("write");
    expect(highestRisk(["read", "destructive", "write"])).toBe("destructive");
    expect(missingParams({ name: "r", description: "", params: ["a", "b"], steps: [], createdAt: 0, runs: 0 }, { a: "1", b: " " })).toEqual(["b"]);
  });

  it("saves, lists in the tool description, runs step by step and stops at a failure", async () => {
    const invoke = vi.fn();
    vi.stubGlobal("window", { adtbotDesktop: { platform: "darwin", proxyToken: "", version: "44", invoke } });
    const { macTools } = await import("./tools");
    const recipes = macTools.find((t) => t.name === "mac_recipes")!;
    const run = macTools.find((t) => t.name === "mac_recipe_run")!;
    await recipes.run({ action: "save", name: "Send WhatsApp", description: "message someone", params: ["contact", "message"], steps }, {} as never);
    expect(recipes.description).toContain('"Send WhatsApp" (contact, message): "message someone"');
    expect(run.riskFor?.({ name: "send whatsapp", values: { contact: "Ma", message: "hi" } })).toBe("write");

    const calls: string[] = [];
    const els = [
      { id: 4, role: "button", label: "Ma", at: { x: 1, y: 1 } },
      { id: 8, role: "text area", label: "Type a message", input: true, at: { x: 1, y: 2 } },
    ];
    invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      calls.push(`${channel.replace("adt:mac:", "")}${payload?.element ? `:${payload.element}` : ""}${payload?.text ? `=${payload.text}` : ""}`);
      if (channel === "adt:mac:open") return { ok: true };
      if (channel === "adt:mac:ui") return { name: "WhatsApp", bundleId: "", pid: 1, window: "WhatsApp", windows: [], elements: els, matched: 2, truncated: false, frontmost: false };
      if (channel === "adt:mac:press") return { method: "AXPress" };
      if (channel === "adt:mac:setText") return { typed: 2, background: "accessibility" };
      throw new Error("unexpected " + channel);
    });
    const ctx = { signal: new AbortController().signal } as never;
    const out = (await run.run({ name: "send whatsapp", values: { contact: "Ma", message: "hi" } }, ctx)) as { content: string };
    expect(out.content).toMatch(/^Ran "Send WhatsApp" \(3 steps\)/);
    expect(calls).toContain("press:4");
    expect(calls).toContain("setText:8=hi");

    invoke.mockImplementation(async (channel: string) => {
      if (channel === "adt:mac:open") return { ok: true };
      if (channel === "adt:mac:ui") return { name: "WhatsApp", bundleId: "", pid: 1, window: "WhatsApp", windows: [], elements: [], matched: 0, truncated: false, frontmost: false };
      throw new Error("unexpected " + channel);
    });
    const failed = (await run.run({ name: "send whatsapp", values: { contact: "Nobody", message: "hi" } }, ctx)) as { content: string };
    expect(failed.content).toMatch(/stopped at step 2 of 3[\s\S]*Nothing called "Nobody"/);
    await expect(run.run({ name: "send whatsapp", values: { contact: "Ma" } }, ctx)).rejects.toThrow(/needs: message/);
    // A step the deny list blocks stops the recipe there, as the call on its own would be refused.
    const denied = (await run.run({ name: "send whatsapp", values: { contact: "Ma", message: "hi" } }, { ...ctx, settings: { agent: { denylist: ["WhatsApp"] } } } as never)) as { content: string };
    expect(denied.content).toMatch(/stopped at step 1 of 3[\s\S]*deny rule "WhatsApp"/);
    await recipes.run({ action: "delete", name: "Send WhatsApp" }, {} as never);
    expect(recipes.description).toContain("No recipes are saved yet.");
    vi.unstubAllGlobals();
  }, 20_000);
});

type UiElement = import("./ui").UiElement;
type UiSnapshot = import("./ui").UiSnapshot;
type AgentTool = import("../../lib/agent/tools").AgentTool;
