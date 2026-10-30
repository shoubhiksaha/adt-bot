// Web pages in the user's own browser on Linux (mac_browser), signed in as them. There's no
// AppleScript here, so ADT Bot talks to Chromium-based browsers over their debugging connection
// (the Chrome DevTools Protocol) and runs the same page script as on macOS (page-script.cjs).
//
// Since Chrome 136 the --remote-debugging-port switch is ignored on the user's own profile. Chrome
// 144+ (and browsers built on it) instead has a switch the user turns on themselves, in
// chrome://inspect/#remote-debugging. The browser then writes its address to DevToolsActivePort in
// its profile folder and asks the user to Allow each new connection, showing a "being controlled"
// bar while one is open. So ADT Bot keeps one connection per browser and closes it when idle.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pageScript, pageResult } = require("./page-script.cjs");

/** Where each browser keeps its profile (under ~/.config, then elsewhere in home), and its commands. */
const BROWSERS = [
  { name: "Google Chrome", config: ["google-chrome"], home: [".var/app/com.google.Chrome/config/google-chrome"], commands: ["google-chrome", "google-chrome-stable"], flatpak: "com.google.Chrome" },
  { name: "Google Chrome Beta", config: ["google-chrome-beta"], home: [], commands: ["google-chrome-beta"] },
  { name: "Google Chrome Dev", config: ["google-chrome-unstable"], home: [], commands: ["google-chrome-unstable"] },
  { name: "Chromium", config: ["chromium"], home: ["snap/chromium/common/chromium", ".var/app/org.chromium.Chromium/config/chromium"], commands: ["chromium", "chromium-browser"], flatpak: "org.chromium.Chromium" },
  { name: "Brave", config: ["BraveSoftware/Brave-Browser"], home: [".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"], commands: ["brave-browser", "brave"], flatpak: "com.brave.Browser" },
  { name: "Microsoft Edge", config: ["microsoft-edge"], home: [".var/app/com.microsoft.Edge/config/microsoft-edge"], commands: ["microsoft-edge", "microsoft-edge-stable"], flatpak: "com.microsoft.Edge" },
  { name: "Vivaldi", config: ["vivaldi"], home: [], commands: ["vivaldi", "vivaldi-stable"] },
  { name: "Opera", config: ["opera"], home: [], commands: ["opera"] },
];

const SWITCH_PAGE = "chrome://inspect/#remote-debugging";
const NAMES = BROWSERS.map((b) => b.name).join(", ");
const IDLE_MS = 15 * 60_000;
const ALLOW_MS = 50_000;
const CALL_MS = 30_000;

const SWITCH_LABEL = "Allow remote debugging for this browser instance";
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the user does once (apps can't open chrome:// pages, and only the user should tick it). */
const howToAllow = (name) =>
  `The user switches this on once: they type ${SWITCH_PAGE} into ${name}'s address bar and tick "${SWITCH_LABEL}" (it stays on after restarts). ` +
  `${capital(name)} then asks them to Allow ADT Bot each time ADT Bot connects. Ask the user to do this; don't do it for them.`;

function noBrowserError(asked) {
  return Object.assign(
    new Error(
      `${asked ? `${asked} isn't open, or it doesn't` : "No open browser"} let${asked ? "" : "s"} ADT Bot use its pages. On Linux this works with ${NAMES} (version 144 or later). ${howToAllow(asked || "the browser")} ` +
        "Firefox can't be used this way: use mac_ui (Firefox shows pages to accessibility) or screenshots.",
    ),
    { code: "browser-off" },
  );
}

/** The browser asked for, by its name or part of it ("chrome", "brave"). */
function findBrowser(asked) {
  const want = String(asked ?? "").trim().toLowerCase();
  if (!want) return null;
  if (/firefox|librewolf|zen|waterfox|safari|epiphany|gnome web|falkon/.test(want)) {
    throw new Error(`${asked} can't be used with mac_browser on Linux; it works with ${NAMES}. Use mac_ui (most browsers show pages to accessibility) or screenshots.`);
  }
  const hit =
    BROWSERS.find((b) => b.name.toLowerCase() === want) ??
    BROWSERS.find((b) => b.name.toLowerCase().includes(want)) ??
    BROWSERS.find((b) => want.includes(b.name.toLowerCase().split(" ").pop()));
  if (!hit) throw new Error(`"${asked}" isn't a browser ADT Bot can use on Linux. Supported: ${NAMES}.`);
  return hit;
}

/** Each browser's profile folders on this PC. */
function profileDirs(browser, { home = os.homedir(), configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config") } = {}) {
  return [...browser.config.map((d) => path.join(configHome, d)), ...browser.home.map((d) => path.join(home, d))];
}

/** The browser's DevToolsActivePort file: the port on line 1, the connection's path on line 2. */
function parseActivePort(text) {
  const [port, wsPath] = String(text ?? "").split(/\r?\n/).map((l) => l.trim());
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  if (!/^\/devtools\/browser\/[\w-]{8,80}$/.test(wsPath ?? "")) return null;
  return { port: n, path: wsPath };
}

/** Whether something is listening on this local port (the file stays behind when the browser quits). */
function listening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether the browser using this profile is running: Chromium keeps a SingletonLock link
 * ("host-pid") there while it is. Its DevToolsActivePort stays behind when it quits, and another
 * browser may be listening on the same port by then (9222 for all of them).
 */
function running(dir) {
  let target;
  try {
    target = fs.readlinkSync(path.join(dir, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  // Flatpak browsers count their processes in their own sandbox.
  if (!pid || dir.includes(`${path.sep}.var${path.sep}app${path.sep}`)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Browsers that let ADT Bot connect right now: [{name, browser, dir, port, path}]. */
async function reachableBrowsers({ only, home, configHome, isListening = listening, isRunning = running } = {}) {
  const found = [];
  for (const browser of only ? [only] : BROWSERS) {
    for (const dir of profileDirs(browser, { home, configHome })) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8");
      } catch {
        continue;
      }
      const at = parseActivePort(text);
      if (at && isRunning(dir) && (await isListening(at.port))) found.push({ name: browser.name, browser, dir, ...at });
    }
  }
  return found;
}

/** A first word of a browser's name that names it in an app or window title. */
const brandOf = (name) => name.toLowerCase().replace(/^(google|microsoft) /, "").split(" ")[0];

/** One debugging connection to a browser. Commands for one tab carry that tab's sessionId. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "The browser refused."));
        else resolve(msg.result ?? {});
      } else if (msg.method === "Target.detachedFromTarget" || msg.method === "Target.targetDestroyed") {
        this.onDetach?.(msg.params ?? {});
      }
    });
    socket.addEventListener("close", () => this.finish());
    socket.addEventListener("error", () => this.finish());
  }

  static connect(url, { timeoutMs = ALLOW_MS, WebSocketImpl = globalThis.WebSocket } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        reject(Object.assign(new Error("timeout"), { code: "timeout" }));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("refused"), { code: "refused" }));
      });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = CALL_MS) {
    if (this.closed) return Promise.reject(new Error("The browser closed the connection."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("The browser closed the connection."));
    }
    this.pending.clear();
    this.onClose?.();
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
    this.finish();
  }
}

/** Tabs the user sees: pages, not the browser's own extension and DevTools pages. */
const isTab = (t) => t.type === "page" && !/^(devtools|chrome-extension|chrome-untrusted|edge-extension):/i.test(t.url ?? "");

/** The page address an id was read from, as on macOS. */
const pageAddress = (value) => (typeof value === "string" && value.length <= 4000 ? value : undefined);
const URL_OK = /^https?:\/\/[^\s]/i;

/**
 * mac_browser on Linux. deps (for tests): reach() lists reachable browsers, front() names the app in
 * front, launch(command, args) starts a program, openExternal(url) opens a page in the default
 * browser, connect(url) opens a connection, which(command) finds a program.
 */
function createLinuxBrowser(deps = {}) {
  const connections = new Map();
  const reach = deps.reach ?? reachableBrowsers;
  const connectTo = deps.connect ?? ((url) => Cdp.connect(url));

  async function pick(asked) {
    const only = findBrowser(asked);
    const open = await reach({ only });
    if (!open.length) throw noBrowserError(only?.name);
    if (open.length === 1) return open[0];
    const front = String((await deps.front?.().catch(() => "")) ?? "").toLowerCase();
    return open.find((b) => front.includes(brandOf(b.name))) ?? open[0];
  }

  async function connection(target) {
    const key = `${target.port}${target.path}`;
    let conn = connections.get(key);
    if (conn && !conn.cdp.closed) {
      conn.touch();
      return conn;
    }
    let cdp;
    try {
      cdp = await connectTo(`ws://127.0.0.1:${target.port}${target.path}`);
    } catch (error) {
      if (error?.code === "timeout") {
        throw new Error(`${target.name} asked the user to Allow ADT Bot, and they didn't answer in time. Ask them to click Allow in ${target.name} when it asks, then try again.`);
      }
      throw new Error(`${target.name} didn't let ADT Bot connect: the user clicked Cancel when it asked, or it stopped allowing remote debugging. Ask the user before trying again; they need to click Allow when ${target.name} asks.`);
    }
    conn = { cdp, name: target.name, sessions: new Map(), tabs: [], current: null, timer: null };
    conn.touch = () => {
      clearTimeout(conn.timer);
      conn.timer = setTimeout(() => cdp.close(), IDLE_MS);
      conn.timer.unref?.();
    };
    cdp.onDetach = ({ sessionId, targetId }) => {
      for (const [id, s] of conn.sessions) if (s === sessionId || id === targetId) conn.sessions.delete(id);
    };
    cdp.onClose = () => {
      clearTimeout(conn.timer);
      if (connections.get(key) === conn) connections.delete(key);
    };
    connections.set(key, conn);
    conn.touch();
    return conn;
  }

  async function tabs(conn) {
    const { targetInfos = [] } = await conn.cdp.send("Target.getTargets");
    return targetInfos.filter(isTab).slice(0, 60);
  }

  async function sessionFor(conn, targetId) {
    let sessionId = conn.sessions.get(targetId);
    if (!sessionId) {
      ({ sessionId } = await conn.cdp.send("Target.attachToTarget", { targetId, flatten: true }));
      conn.sessions.set(targetId, sessionId);
    }
    return sessionId;
  }

  async function evaluate(conn, targetId, expression, timeoutMs) {
    const sessionId = await sessionFor(conn, targetId);
    const r = await conn.cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: true }, sessionId, timeoutMs);
    if (r.exceptionDetails) throw new Error(`The page refused: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "error"}`);
    return r.result?.value;
  }

  /** The tab showing: the one ADT Bot last opened or switched to while it's still showing, else the focused or visible one. */
  async function currentTab(conn, list) {
    if (!list.length) throw new Error(`${conn.name} has no open tab.`);
    // A tab the browser froze to save memory doesn't answer: it isn't the one showing.
    const states = await Promise.all(
      list.slice(0, 30).map((t) =>
        evaluate(conn, t.targetId, "[document.visibilityState, document.hasFocus()]", 2_000).then(
          (v) => ({ t, visible: Array.isArray(v) && v[0] === "visible", focused: Array.isArray(v) && v[1] === true }),
          () => ({ t, visible: false, focused: false }),
        ),
      ),
    );
    const mine = states.find((s) => s.t.targetId === conn.current && s.visible);
    return (mine ?? states.find((s) => s.focused) ?? states.find((s) => s.visible) ?? states[0]).t;
  }

  async function page(conn, req) {
    const tab = await currentTab(conn, await tabs(conn));
    return pageResult(conn.name, await evaluate(conn, tab.targetId, pageScript(req)));
  }

  function which(command) {
    if (deps.which) return deps.which(command);
    for (const dir of (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":").concat(["/usr/bin", "/usr/local/bin", "/snap/bin", "/var/lib/flatpak/exports/bin"])) {
      const file = path.join(dir || ".", command);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // Not here.
      }
    }
    return null;
  }

  /** A browser's program and the arguments before a page to open, if it's installed. */
  function program(browser) {
    for (const command of browser.commands) {
      const file = which(command);
      if (file) return [file];
    }
    if (browser.flatpak && which("flatpak")) return [which("flatpak"), "run", browser.flatpak];
    return null;
  }

  function launch(argv) {
    if (deps.launch) return deps.launch(argv);
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  }

  /** Starts the named (or first installed) browser with a page, when none can be reached. */
  async function start(asked, address) {
    const only = findBrowser(asked);
    for (const browser of only ? [only] : BROWSERS) {
      const argv = program(browser);
      if (argv) {
        launch([...argv, address]);
        return browser.name;
      }
    }
    if (only) throw new Error(`${only.name} isn't installed on this PC.`);
    return null;
  }

  /** Whether pages can be used already; else the steps for the user, for the browser asked for or the first one installed. */
  async function allowPageAccess(asked) {
    const only = findBrowser(asked);
    const open = await reach({ only });
    if (open.length) return { browser: open[0].name, ok: true, already: true };
    // The one the user is using, if it's one of these; else the first installed.
    const installed = BROWSERS.filter((b) => program(b));
    const front = only ? "" : String((await deps.front?.().catch(() => "")) ?? "").toLowerCase();
    const name = only?.name ?? (installed.find((b) => front && front.includes(brandOf(b.name))) ?? installed[0])?.name;
    if (!name) throw new Error(`None of the browsers ADT Bot can use is installed (${NAMES}).`);
    return { browser: name, ok: true, steps: howToAllow(name) };
  }

  const browser = async function browser({ browser: wanted, action = "read", id, text, submit, append, query, content, offset, url, tab, dy, max, expect, maxText = 20_000 } = {}) {
    const address = String(url ?? "").trim();
    if ((action === "open" || action === "go") && (!URL_OK.test(address) || address.length > 4000 || /[\0\r\n]/.test(address))) {
      throw new Error("Give a web address starting with https:// or http://.");
    }
    if (action === "allow_page_access") return allowPageAccess(wanted);
    let target;
    try {
      target = await pick(wanted);
    } catch (error) {
      // Nothing to talk to yet: a page can still be opened, in the browser asked for or the default one.
      if (action !== "open" || error?.code !== "browser-off") throw error;
      const started = await start(wanted, address);
      if (!started) await deps.openExternal?.(address);
      return { browser: started ?? "the default browser", ok: true, url: address, started: true };
    }
    const conn = await connection(target);
    const base = { browser: target.name };
    switch (action) {
      case "read":
        return { ...base, ...(await page(conn, { op: "read", query: query ? String(query).slice(0, 200) : undefined, content: content === true, offset: Number(offset) || 0, max: Number(max) || undefined })) };
      case "click":
        return { ...base, ...(await page(conn, { op: "click", id: Number(id), expect: pageAddress(expect) })) };
      case "type": {
        const value = String(text ?? "");
        if (value.length > maxText) throw new Error(`Text is too long (max ${maxText} characters).`);
        return { ...base, ...(await page(conn, { op: "type", id: Number(id), text: value, submit: submit === true, append: append === true, expect: pageAddress(expect) })) };
      }
      case "scroll":
        return { ...base, ...(await page(conn, { op: "scroll", id: id === undefined ? undefined : Number(id), dy: Number(dy) || undefined })) };
      case "back":
      case "forward":
      case "reload":
        return { ...base, ...(await page(conn, { op: action })) };
      case "tabs": {
        const list = await tabs(conn);
        const showing = list.length ? await currentTab(conn, list) : null;
        conn.tabs = list.map((t) => t.targetId);
        return { ...base, active: list.findIndex((t) => t === showing), tabs: list.map((t) => ({ title: t.title ?? "", url: t.url ?? "" })) };
      }
      case "switch": {
        const n = Math.max(0, Math.round(Number(tab) || 0));
        const list = await tabs(conn);
        // By the last tab list the bot saw, so the numbers mean what it was shown.
        const targetId = conn.tabs[n] && list.some((t) => t.targetId === conn.tabs[n]) ? conn.tabs[n] : list[n]?.targetId;
        if (!targetId) throw new Error(`There's no tab ${n}. List them again (action tabs).`);
        await conn.cdp.send("Target.activateTarget", { targetId });
        conn.current = targetId;
        return { ...base, ok: true };
      }
      case "open": {
        const { targetId } = await conn.cdp.send("Target.createTarget", { url: address });
        await conn.cdp.send("Target.activateTarget", { targetId }).catch(() => undefined);
        conn.current = targetId;
        return { ...base, ok: true, url: address };
      }
      case "go": {
        const showing = await currentTab(conn, await tabs(conn));
        await conn.cdp.send("Page.navigate", { url: address }, await sessionFor(conn, showing.targetId));
        conn.current = showing.targetId;
        return { ...base, ok: true, url: address };
      }
      default:
        throw new Error("action must be read, click, type, scroll, back, forward, reload, tabs, switch, open, go or allow_page_access.");
    }
  };
  /** Closes every browser connection (the browser's "being controlled" bar goes with it). */
  browser.closeAll = () => {
    for (const conn of [...connections.values()]) conn.cdp.close();
  };
  return browser;
}

module.exports = { BROWSERS, SWITCH_PAGE, SWITCH_LABEL, Cdp, createLinuxBrowser, findBrowser, profileDirs, parseActivePort, reachableBrowsers, listening, running, isTab };
