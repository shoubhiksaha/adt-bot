// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// The modules are .cjs; their surface is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lb: any = require("../../../electron/linux-browser.cjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const common: any = require("../../../electron/control-common.cjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { WebSocketServer }: any = require("ws");

type Msg = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };

/** A stand-in browser speaking the debugging protocol: two tabs, the second one showing and focused. */
async function fakeBrowser() {
  const calls: Msg[] = [];
  let connections = 0;
  const targets = [
    { targetId: "T1", type: "page", title: "Inbox", url: "https://mail.example.com/" },
    { targetId: "T2", type: "page", title: "Docs", url: "https://docs.example.com/" },
    { targetId: "X", type: "page", title: "ext", url: "chrome-extension://abc/popup.html" },
    { targetId: "W", type: "service_worker", title: "sw", url: "https://docs.example.com/sw.js" },
  ];
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket: { on: (e: string, f: (d: unknown) => void) => void; send: (s: string) => void }) => {
    connections++;
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Msg;
      calls.push(msg);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId }));
      if (msg.method === "Target.getTargets") return reply({ targetInfos: targets });
      if (msg.method === "Target.attachToTarget") return reply({ sessionId: `S-${msg.params.targetId}` });
      if (msg.method === "Runtime.evaluate") {
        const expr = String(msg.params.expression);
        if (expr.startsWith("[document.visibilityState")) return reply({ result: { value: msg.sessionId === "S-T2" ? ["visible", true] : ["hidden", false] } });
        const req = JSON.parse(expr.slice(expr.lastIndexOf(")(") + 2, -1));
        return reply({ result: { value: JSON.stringify({ result: { url: msg.sessionId === "S-T2" ? targets[1].url : targets[0].url, title: "page", elements: [], op: req.op } }) } });
      }
      if (msg.method === "Target.createTarget") {
        targets.push({ targetId: "T3", type: "page", title: "", url: String(msg.params.url) });
        return reply({ targetId: "T3" });
      }
      return reply({});
    });
  });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, calls, connections: () => connections, path: "/devtools/browser/0b5f9c3e-1111-4222-8333-944455556666" };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("finding the browser", () => {
  it("reads DevToolsActivePort: a port and the browser's own connection path, nothing else", () => {
    expect(lb.parseActivePort("9222\n/devtools/browser/0b5f9c3e-1111-4222-8333-944455556666\n")).toEqual({ port: 9222, path: "/devtools/browser/0b5f9c3e-1111-4222-8333-944455556666" });
    expect(lb.parseActivePort("0\n/devtools/browser/abcdefgh")).toBeNull();
    expect(lb.parseActivePort("9222\n/json/version")).toBeNull();
    expect(lb.parseActivePort("9222\n/devtools/browser/../../etc")).toBeNull();
    expect(lb.parseActivePort("")).toBeNull();
  });

  it("names browsers loosely, and refuses Firefox with what to use instead", () => {
    expect(lb.findBrowser("chrome").name).toBe("Google Chrome");
    expect(lb.findBrowser("Brave Browser").name).toBe("Brave");
    expect(lb.findBrowser("Microsoft Edge").name).toBe("Microsoft Edge");
    expect(lb.findBrowser("")).toBeNull();
    expect(() => lb.findBrowser("Firefox")).toThrow(/mac_ui/);
    expect(() => lb.findBrowser("Netscape")).toThrow(/isn't a browser/);
  });

  it("finds the browsers with remote debugging on (a port file and something listening), in normal, snap and Flatpak folders", async () => {
    const home = mkdtempSync(join(tmpdir(), "adt-lb-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    // A running browser keeps SingletonLock -> "host-pid" in its profile; this test's own pid is alive.
    const put = (dir: string, text: string, lock: string | null = `host-${process.pid}`) => {
      mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(join(home, dir, "DevToolsActivePort"), text);
      if (lock) symlinkSync(lock, join(home, dir, "SingletonLock"));
    };
    put(".config/google-chrome", "9222\n/devtools/browser/aaaaaaaa-1");
    put("snap/chromium/common/chromium", "9333\n/devtools/browser/bbbbbbbb-2");
    put(".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser", "9444\n/devtools/browser/cccccccc-3", "host-2"); // Flatpak: its own pids
    put(".config/microsoft-edge", "9555\n/devtools/browser/dddddddd-4"); // left behind: nothing listens
    // Quit (cleanly, or killed): the port file stays, while another browser listens on that port now.
    put(".config/vivaldi", "9222\n/devtools/browser/eeeeeeee-5", null);
    put(".config/opera", "9222\n/devtools/browser/ffffffff-6", "host-999999999");
    const found = await lb.reachableBrowsers({ home, configHome: join(home, ".config"), isListening: async (port: number) => port !== 9555 });
    expect(found.map((b: { name: string; port: number }) => [b.name, b.port])).toEqual([
      ["Google Chrome", 9222],
      ["Chromium", 9333],
      ["Brave", 9444],
    ]);
  });
});

describe("mac_browser on Linux", () => {
  async function setup() {
    const fake = await fakeBrowser();
    cleanup.push(() => fake.server.close());
    const browser = lb.createLinuxBrowser({ reach: async () => [{ name: "Google Chrome", port: fake.port, path: fake.path }] });
    cleanup.push(() => browser.closeAll());
    return { fake, browser };
  }

  it("lists tabs without the browser's own pages, and works in the tab that's showing", async () => {
    const { fake, browser } = await setup();
    const tabs = await browser({ action: "tabs" });
    expect(tabs).toEqual({
      browser: "Google Chrome",
      active: 1,
      tabs: [
        { title: "Inbox", url: "https://mail.example.com/" },
        { title: "Docs", url: "https://docs.example.com/" },
      ],
    });
    const read = await browser({ action: "read", query: "save" });
    expect(read).toMatchObject({ browser: "Google Chrome", url: "https://docs.example.com/", op: "read" });
    const evaluated = fake.calls.filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).startsWith("(function"));
    expect(evaluated.at(-1)?.sessionId).toBe("S-T2");
    expect(evaluated.at(-1)?.params).toMatchObject({ returnByValue: true });
    // The request reaches the page as JSON data.
    expect(String(evaluated.at(-1)?.params.expression)).toContain('({"op":"read","query":"save","content":false,"offset":0})');
    // One connection for everything: the browser asks the user to Allow each new one.
    expect(fake.connections()).toBe(1);
  });

  it("switches by the tab list the bot saw, opens tabs and goes to addresses", async () => {
    const { fake, browser } = await setup();
    await browser({ action: "tabs" });
    await browser({ action: "switch", tab: 0 });
    expect(fake.calls.at(-1)).toMatchObject({ method: "Target.activateTarget", params: { targetId: "T1" } });
    await expect(browser({ action: "switch", tab: 7 })).rejects.toThrow(/no tab 7/);
    expect(await browser({ action: "open", url: "https://example.org/" })).toEqual({ browser: "Google Chrome", ok: true, url: "https://example.org/" });
    expect(fake.calls.some((c) => c.method === "Target.createTarget" && c.params.url === "https://example.org/")).toBe(true);
    await browser({ action: "go", url: "https://example.net/" });
    const nav = fake.calls.find((c) => c.method === "Page.navigate");
    expect(nav).toMatchObject({ params: { url: "https://example.net/" }, sessionId: "S-T2" });
  });

  it("lets go of the browser on Stop all, and connects again (the browser asks again) when next used", async () => {
    const { fake, browser } = await setup();
    await browser({ action: "tabs" });
    browser.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await browser({ action: "tabs" });
    expect(fake.connections()).toBe(2);
  });

  it("only opens web addresses", async () => {
    const { browser } = await setup();
    await expect(browser({ action: "open", url: "file:///etc/passwd" })).rejects.toThrow(/https:\/\//);
    await expect(browser({ action: "go", url: "javascript:alert(1)" })).rejects.toThrow(/https:\/\//);
  });

  it("says how the user lets ADT Bot in when no browser allows it (the steps, not a page: apps can't open chrome:// pages)", async () => {
    const launched: string[][] = [];
    const browser = lb.createLinuxBrowser({ reach: async () => [], which: (c: string) => (c === "chromium" ? "/usr/bin/chromium" : null), launch: (argv: string[]) => launched.push(argv) });
    await expect(browser({ action: "read" })).rejects.toThrow(/type chrome:\/\/inspect\/#remote-debugging into the browser's address bar and tick "Allow remote debugging for this browser instance".*The browser then asks them to Allow ADT Bot/s);
    await expect(browser({ action: "read", browser: "Brave" })).rejects.toThrow(/^Brave isn't open, or it doesn't let ADT Bot/);
    const steps = await browser({ action: "allow_page_access" });
    expect(steps).toMatchObject({ browser: "Chromium", ok: true });
    expect(steps.steps).toMatch(/into Chromium's address bar.*don't do it for them/s);
    expect((await browser({ action: "allow_page_access", browser: "Vivaldi" })).browser).toBe("Vivaldi");
    expect(launched).toEqual([]);
    // A page can still be opened: the browser is started with it.
    expect(await browser({ action: "open", url: "https://example.org/" })).toEqual({ browser: "Chromium", ok: true, url: "https://example.org/", started: true });
    expect(launched).toEqual([["/usr/bin/chromium", "https://example.org/"]]);
    await expect(browser({ action: "open", url: "https://example.org/", browser: "Vivaldi" })).rejects.toThrow(/Vivaldi isn't installed/);
  });

  it("says when nothing is installed to switch on", async () => {
    const browser = lb.createLinuxBrowser({ reach: async () => [], which: () => null });
    await expect(browser({ action: "allow_page_access" })).rejects.toThrow(/None of the browsers/);
    const ready = lb.createLinuxBrowser({ reach: async () => [{ name: "Brave", port: 1, path: "/devtools/browser/abcdefgh" }] });
    expect(await ready({ action: "allow_page_access" })).toEqual({ browser: "Brave", ok: true, already: true });
  });

  it("gives the steps for the browser the user is in, when several are installed", async () => {
    const which = (c: string) => (["google-chrome", "brave-browser"].includes(c) ? `/usr/bin/${c}` : null);
    const inBrave = lb.createLinuxBrowser({ reach: async () => [], which, front: async () => "brave" });
    expect((await inBrave({ action: "allow_page_access" })).browser).toBe("Brave");
    const elsewhere = lb.createLinuxBrowser({ reach: async () => [], which, front: async () => "mousepad" });
    expect((await elsewhere({ action: "allow_page_access" })).browser).toBe("Google Chrome");
  });

  it("falls back to the default browser to open a page when no supported one is installed", async () => {
    const opened: string[] = [];
    const browser = lb.createLinuxBrowser({ reach: async () => [], which: () => null, openExternal: async (u: string) => opened.push(u) });
    expect(await browser({ action: "open", url: "https://example.org/" })).toMatchObject({ browser: "the default browser", started: true });
    expect(opened).toEqual(["https://example.org/"]);
  });

  it("says so when the browser won't let ADT Bot connect, or the user doesn't answer its question", async () => {
    const refused = lb.createLinuxBrowser({ reach: async () => [{ name: "Google Chrome", port: 1, path: "/devtools/browser/abcdefgh" }], connect: async () => Promise.reject(Object.assign(new Error("x"), { code: "refused" })) });
    await expect(refused({ action: "read" })).rejects.toThrow(/didn't let ADT Bot connect: the user clicked Cancel.*Ask the user before trying again/s);
    const unanswered = lb.createLinuxBrowser({ reach: async () => [{ name: "Google Chrome", port: 1, path: "/devtools/browser/abcdefgh" }], connect: async () => Promise.reject(Object.assign(new Error("x"), { code: "timeout" })) });
    await expect(unanswered({ action: "read" })).rejects.toThrow(/click Allow/);
  });

  it("prefers the browser in front when several allow it", async () => {
    const a = await fakeBrowser();
    const b = await fakeBrowser();
    cleanup.push(() => a.server.close(), () => b.server.close());
    const browser = lb.createLinuxBrowser({
      reach: async () => [
        { name: "Google Chrome", port: a.port, path: a.path },
        { name: "Brave", port: b.port, path: b.path },
      ],
      front: async () => "Brave Browser",
    });
    cleanup.push(() => browser.closeAll());
    expect((await browser({ action: "tabs" })).browser).toBe("Brave");
    expect(b.connections()).toBe(1);
    expect(a.connections()).toBe(0);
  });
});

describe("mac_clipboard", () => {
  it("reads and writes text through Electron's clipboard", async () => {
    let held = "hello";
    const clipboard = { readText: async () => held, writeText: async (t: string) => void (held = t), read: async () => (held ? [{ types: ["text/plain"] }] : []) };
    const cb = common.createClipboard({ clipboard });
    expect(await cb({ action: "read" })).toEqual({ text: "hello", length: 5, truncated: false });
    expect(await cb({ action: "write", text: "naïve 日本" })).toEqual({ ok: true, length: 8 });
    expect(held).toBe("naïve 日本");
    held = "";
    expect(await cb({ action: "read" })).toEqual({ text: "", length: 0, truncated: false });
    await expect(cb({ action: "write", text: "x".repeat(common.MAX_TEXT + 1) })).rejects.toThrow(/too long/);
    await expect(cb({ action: "erase" })).rejects.toThrow(/read or write/);
  });

  it("says when what's copied isn't text, and cuts very long text", async () => {
    const image = common.createClipboard({ clipboard: { readText: async () => "", read: async () => [{ types: ["image/png"] }] } });
    expect(await image({ action: "read" })).toEqual({ text: "", length: 0, notText: true });
    // macOS: an empty clipboard still lists Electron's find text.
    const empty = common.createClipboard({ clipboard: { readText: async () => "", read: async () => [{ types: ["electron application/findtext"] }] } });
    expect(await empty({ action: "read" })).toEqual({ text: "", length: 0, truncated: false });
    const long = common.createClipboard({ clipboard: { readText: async () => "y".repeat(common.MAX_CLIPBOARD + 10), read: async () => [] } });
    expect(await long({ action: "read" })).toMatchObject({ length: common.MAX_CLIPBOARD + 10, truncated: true });
  });

  it("goes through wl-copy and wl-paste when given them (Wayland)", async () => {
    const ran: [string, string[], string | undefined][] = [];
    let reply: string | Error = "from wayland";
    const run = async (file: string, args: string[], input?: string) => {
      ran.push([file, args, input]);
      if (reply instanceof Error) throw reply;
      return file.endsWith("wl-paste") ? reply : "";
    };
    const cb = common.createClipboard({ clipboard: null, tools: { copy: "/usr/bin/wl-copy", paste: "/usr/bin/wl-paste" }, run });
    expect(await cb({ action: "read" })).toMatchObject({ text: "from wayland" });
    await cb({ action: "write", text: "to wayland" });
    expect(ran).toEqual([
      ["/usr/bin/wl-paste", ["--no-newline", "--type", "text"], undefined],
      ["/usr/bin/wl-copy", ["--type", "text/plain;charset=utf-8"], "to wayland"],
    ]);
    reply = new Error("Nothing is copied");
    expect(await cb({ action: "read" })).toMatchObject({ text: "", length: 0 });
    reply = new Error("No suitable type of content copied");
    expect(await cb({ action: "read" })).toMatchObject({ notText: true });
    reply = new Error("Failed to connect to a Wayland server");
    await expect(cb({ action: "read" })).rejects.toThrow(/Wayland server/);
  });

  it("falls back to Electron's clipboard when wl-clipboard can't reach the desktop", async () => {
    let held = "electron's";
    const clipboard = { readText: async () => held, writeText: async (t: string) => void (held = t), read: async () => [] };
    const run = async () => {
      throw new Error("This seat has no keyboard");
    };
    const cb = common.createClipboard({ clipboard, tools: { copy: "/usr/bin/wl-copy", paste: "/usr/bin/wl-paste" }, run });
    expect(await cb({ action: "read" })).toMatchObject({ text: "electron's" });
    await cb({ action: "write", text: "fallback" });
    expect(held).toBe("fallback");
  });

  it("runs a real program for wl-clipboard: input on stdin, output from stdout", async () => {
    expect(await common.runClipboardTool("/bin/cat", [], "piped")).toBe("");
    expect(await common.runClipboardTool("/bin/echo", ["-n", "out"])).toBe("out");
    await expect(common.runClipboardTool("/bin/sh", ["-c", "echo nope >&2; exit 3"])).rejects.toThrow(/nope/);
  });
});
