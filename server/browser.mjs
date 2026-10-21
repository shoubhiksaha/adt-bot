// A real browser on your always-on server: headless Chromium driven over its DevTools pipe (no npm
// packages). Routines use it for pages that need JavaScript, clicking and forms; you can open it
// from the app (Settings → Sync & server → Server browser) to sign in to sites once, and routines
// stay signed in. Cookies and logins live in ADT_DATA_DIR/agent/browser.
//
// It only reaches the public internet. Every connection goes through a small proxy here that looks
// the name up itself, refuses private, loopback and link-local addresses (this server's network,
// cloud metadata), and connects to the very address it checked, so a page can't trick Chromium
// into the server's own network (nor can DNS rebinding).
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isPrivateAddress } from "./proxy.mjs";

const CANDIDATES = {
  linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/snap/bin/chromium", "/usr/lib/chromium/chromium"],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
};

/** The browser to use: ADT_BROWSER (a path, or "off"), else a Chromium-family browser in the usual places. */
export function findChromium(env = process.env, exists = existsSync, platform = process.platform) {
  const chosen = String(env.ADT_BROWSER ?? "").trim();
  if (chosen === "off") return "";
  if (chosen) return exists(chosen) ? chosen : "";
  return (CANDIDATES[platform] ?? []).find((p) => exists(p)) ?? "";
}

// The public-only proxy ----------------------------------------------------------------------

/** Web ports only: the browser isn't a port scanner for the internet either. */
const PORTS = new Set([80, 443, 8080, 8443]);

/** One public address for a host (all of its addresses must be public), or an error. */
export async function publicAddress(host, { allowPrivate = false, resolve = (name) => lookup(name, { all: true, verbatim: true }) } = {}) {
  const name = String(host).replace(/^\[|\]$/g, "");
  const addresses = net.isIP(name) ? [{ address: name }] : await resolve(name);
  if (!addresses?.length) throw new Error(`${host} has no address`);
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} is on a private network`);
  return addresses[0].address;
}

const splitHostPort = (value) => {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  return m ? [m[1], Number(m[2])] : [value, 443];
};

/**
 * The proxy Chromium is pointed at: public web addresses only, each connection to the address it
 * checked. `allowPrivate` and `anyPort` are for tests (a test site on this machine).
 */
export function createPublicProxy({ allowPrivate = false, resolve, anyPort = false } = {}) {
  const portOk = (port) => anyPort || PORTS.has(port);
  const deny = (socket, reason) => {
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}`);
  };
  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    // A refusal drops the connection: Chromium then reports a network error rather than showing a
    // reply from us as if the site had sent it.
    if (target.protocol !== "http:" || !portOk(port)) return req.socket.destroy();
    let address;
    try {
      address = await publicAddress(target.hostname, { allowPrivate, resolve });
    } catch {
      return req.socket.destroy();
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request({ host: address, port, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("connect", async (req, socket, head) => {
    socket.on("error", () => undefined);
    const [host, port] = splitHostPort(String(req.url ?? ""));
    if (!portOk(port)) return deny(socket, "Not a web port.");
    let address;
    try {
      address = await publicAddress(host, { allowPrivate, resolve });
    } catch (error) {
      return deny(socket, String(error.message));
    }
    const upstream = net.connect(port, address, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  return {
    server,
    listen: () => new Promise((resolve_) => server.listen(0, "127.0.0.1", () => resolve_(server.address().port))),
    close: () => new Promise((resolve_) => server.close(() => resolve_())),
  };
}

// Talking to Chromium -------------------------------------------------------------------------

/** DevTools protocol over --remote-debugging-pipe: JSON messages ending in a NUL byte, fd 3 in, fd 4 out. */
function cdpPipe(child) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  const decoder = new StringDecoder("utf8");
  const pending = new Map();
  const listeners = new Set();
  let buffer = "";
  let nextId = 1;
  let closed = null;
  fromBrowser.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? "browser error"));
        else resolve(message.result ?? {});
      } else for (const listener of listeners) listener(message);
    }
  });
  const fail = (error) => {
    closed = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on("exit", () => fail(new Error("The browser closed.")));
  toBrowser.on("error", (error) => fail(error));
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What a page shows, with its controls numbered (data-adt-id) so the bot can say which one it means. */
function readPageScript() {
  for (const el of document.querySelectorAll("[data-adt-id]")) el.removeAttribute("data-adt-id");
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const selector =
    'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [role=switch], [contenteditable=""], [contenteditable=true]';
  const controls = [];
  for (const el of document.querySelectorAll(selector)) {
    if (controls.length >= 150) break;
    if (el.disabled || !visible(el)) continue;
    const id = controls.length + 1;
    el.setAttribute("data-adt-id", String(id));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const textish = tag === "textarea" || el.isContentEditable || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "image", "file", "range", "color"].includes(type));
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "select" ? "select" : textish ? "textbox" : type === "checkbox" || type === "radio" ? type : "button");
    const label = (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || (type !== "password" && el.value) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const item = { id, role, label };
    if (tag === "a" && /^https?:/.test(el.href)) item.href = el.href;
    if (type === "password") item.password = true;
    const value = el.isContentEditable ? el.innerText : el.value;
    if (textish && type !== "password" && value && value.trim()) item.value = String(value).trim().slice(0, 60);
    if (tag === "select") item.options = [...el.options].slice(0, 20).map((o) => o.text.trim()).filter(Boolean);
    controls.push(item);
  }
  const main = document.querySelector("main, article, [role=main]") || document.body;
  const text = (main ? main.innerText : "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000);
  return { title: document.title, url: location.href, text, controls };
}

/**
 * Where control `id` is on screen (scrolled into view), what it is, its label as the bot was shown
 * it, and whether it's really what a click there would hit (not covered by something else, such as
 * a see-through frame from another site).
 */
function boxScript(id) {
  const el = document.querySelector(`[data-adt-id="${id}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const label = (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || (type !== "password" && el.value) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return { x, y, tag, type, label, href: tag === "a" && /^https?:/.test(el.href) ? el.href : "", onTop: Boolean(hit && (hit === el || el.contains(hit))) };
}

function focusScript(id) {
  const el = document.querySelector(`[data-adt-id="${id}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (typeof el.select === "function") el.select();
  else if (el.isContentEditable) document.execCommand("selectAll");
  return true;
}

function selectScript(id, option) {
  const el = document.querySelector(`[data-adt-id="${id}"]`);
  if (!el || el.tagName.toLowerCase() !== "select") return "";
  const wanted = String(option).toLowerCase();
  const match = [...el.options].find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted) ?? [...el.options].find((o) => o.text.toLowerCase().includes(wanted));
  if (!match) return "";
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return match.text.trim();
}

const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORT = { width: 1280, height: 900 };
const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
};

/**
 * The server's browser. Starts Chromium on first use and closes it after a few idle minutes (small
 * servers need the memory back). Each routine run gets its own tab; you get one of your own.
 * @param {{ dir: string, executable?: string, allowPrivate?: boolean, anyPort?: boolean, resolve?: any, idleMs?: number }} options
 */
export function createServerBrowser({ dir, executable = findChromium(), allowPrivate = false, anyPort = false, resolve, idleMs = 5 * 60_000 }) {
  /** @type {null | Promise<{ child: any, cdp: ReturnType<typeof cdpPipe>, proxy: ReturnType<typeof createPublicProxy> }>} */
  let starting = null;
  let pages = 0;
  let lastUse = Date.now();
  let idleTimer = null;
  /** Your own tab (sign-ins), made when you first open it. */
  let userPage = null;

  async function launch() {
    mkdirSync(join(dir, "profile"), { recursive: true, mode: 0o700 });
    const proxy = createPublicProxy({ allowPrivate, resolve, anyPort });
    const port = await proxy.listen();
    const args = [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${join(dir, "profile")}`,
      `--proxy-server=http://127.0.0.1:${port}`,
      // Without this, Chromium skips the proxy for localhost; with it, localhost is refused like any private address.
      "--proxy-bypass-list=<-loopback>",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-dev-shm-usage",
      "--mute-audio",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : ["--password-store=basic"]),
      // Root in a container has no sandbox to give it.
      ...(process.getuid?.() === 0 || process.env.ADT_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      "about:blank",
    ];
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    child.on("error", () => undefined);
    const cdp = cdpPipe(child);
    child.on("exit", () => {
      starting = null;
      userPage = null;
      void proxy.close();
    });
    try {
      await cdp.send("Browser.getVersion");
    } catch {
      child.kill();
      throw new Error(
        process.platform === "linux" && !args.includes("--no-sandbox")
          ? "The browser couldn't start. In a container, Chromium's sandbox needs user namespaces; allow them, or set ADT_BROWSER_NO_SANDBOX=1 to run it without (the container is then its only sandbox)."
          : "The browser couldn't start.",
      );
    }
    // Files never land on the server.
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
    return { child, cdp, proxy };
  }

  const ensure = () => {
    if (!executable) return Promise.reject(new Error("There's no browser on this server. Install Chromium (or set ADT_BROWSER to its path)."));
    starting ??= launch().catch((error) => {
      starting = null;
      throw error;
    });
    return starting;
  };

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pages > 0 && Date.now() - lastUse < idleMs) return armIdle();
      void close();
    }, idleMs);
    idleTimer.unref?.();
  }

  async function close() {
    clearTimeout(idleTimer);
    const running = starting;
    starting = null;
    userPage = null;
    pages = 0;
    if (!running) return;
    try {
      const { child, cdp } = await running;
      await Promise.race([cdp.send("Browser.close").catch(() => undefined), sleep(2000)]);
      child.kill();
    } catch {}
  }

  /** A new tab. Its methods act on that tab only. */
  async function newPage() {
    const { cdp } = await ensure();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    pages++;
    lastUse = Date.now();
    armIdle();
    let open = true;
    const touch = () => {
      if (!open) throw new Error("This browser tab was closed.");
      lastUse = Date.now();
    };
    /**
     * Runs one of our scripts in a world of its own: the page's scripts share the DOM but can't
     * replace the functions ours use, and what they throw never reaches the bot.
     */
    const evaluate = async (expression) => {
      const { frameTree } = await send("Page.getFrameTree");
      const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "adt-bot" });
      const out = await send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error("The page couldn't be read just now. Read it again, or open it again.");
      return out.result?.value;
    };
    /** The labels the bot was last shown, by control number: a control must still be that one when used. */
    let shown = new Map();
    const remember = (view) => {
      shown = new Map((view?.controls ?? []).map((c) => [c.id, c.label]));
      return view;
    };
    /** Control `id`, checked: still the one the bot was shown, and (to click it) really what's on top there. */
    const control = async (id, { click = false } = {}) => {
      const box = await evaluate(call(boxScript, Number(id)));
      if (!box) throw new Error(`There's no control [${id}] on the page now. Read the page again.`);
      if (shown.has(Number(id)) && shown.get(Number(id)) !== box.label) throw new Error(`Control [${id}] isn't the one you were shown any more (the page changed). Read the page again.`);
      if (click && !box.onTop) throw new Error(`Something else is covering [${id}], so clicking it could hit that instead. Read the page again or scroll.`);
      return box;
    };
    /** Waits for the page to settle after something that may navigate. */
    const settle = async (maxMs = 15_000) => {
      const start = Date.now();
      await sleep(400);
      while (Date.now() - start < maxMs) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") break;
        await sleep(300);
      }
      await sleep(300);
    };
    const key = async (name) => {
      const k = KEYS[name];
      if (!k) throw new Error(`Unknown key ${name}.`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...k, text: undefined });
    };
    const clickAt = async (x, y) => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    };
    const page = {
      targetId,
      async read() {
        touch();
        return remember(await evaluate(call(readPageScript)));
      },
      async open(url) {
        touch();
        const out = await send("Page.navigate", { url });
        if (out.errorText) {
          // Leave the tab usable (Chromium's error page can't even be pictured).
          await send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
          await settle(3000);
          throw new Error(/TUNNEL|PROXY|CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|ERR_ACCESS/.test(out.errorText) ? `${new URL(url).host} can't be reached from here (private addresses are refused).` : out.errorText);
        }
        await settle(20_000);
        return page.read();
      },
      /** Control `id`: where it is, what it is, its label (checked against what the bot was shown). */
      async box(id) {
        touch();
        return control(id);
      },
      async clickControl(id) {
        touch();
        const box = await control(id, { click: true });
        await clickAt(box.x, box.y);
        await settle();
        return page.read();
      },
      async typeInto(id, text, submit = false) {
        touch();
        await control(id);
        if (!(await evaluate(call(focusScript, Number(id))))) throw new Error(`There's no control [${id}] on the page now. Read the page again.`);
        await send("Input.insertText", { text: String(text) });
        if (submit) {
          await key("Enter");
          await settle();
        }
        return page.read();
      },
      async selectOption(id, option) {
        touch();
        await control(id);
        const chosen = await evaluate(call(selectScript, Number(id), String(option)));
        if (!chosen) throw new Error(`[${id}] isn't a list with an option "${option}".`);
        await settle(3000);
        return page.read();
      },
      async back() {
        touch();
        await evaluate("history.back()");
        await settle();
        return page.read();
      },
      async scroll(dy) {
        touch();
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX: 0, deltaY: Number(dy) || 600 });
        await sleep(400);
        return page.read();
      },
      // For you, in the takeover view: raw input at a spot, keys, and a picture of the tab.
      async clickAt(x, y) {
        touch();
        await clickAt(Number(x), Number(y));
        await settle(8000);
      },
      async insertText(text) {
        touch();
        await send("Input.insertText", { text: String(text).slice(0, 2000) });
      },
      async press(name) {
        touch();
        await key(name);
        if (name === "Enter") await settle(8000);
      },
      async screenshot() {
        touch();
        // A tab between two pages can't be pictured for a moment.
        const shoot = () => send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
        const { data } = await shoot().catch(async () => {
          await sleep(500);
          return shoot();
        });
        return Buffer.from(data, "base64");
      },
      async location() {
        touch();
        return evaluate("({ url: location.href, title: document.title })");
      },
      async close() {
        if (!open) return;
        open = false;
        pages = Math.max(0, pages - 1);
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      },
    };
    return page;
  }

  return {
    available: () => Boolean(executable),
    executable,
    newPage,
    /** Your own tab, kept between visits (until the browser closes when idle). */
    async userPage() {
      if (userPage) {
        lastUse = Date.now();
        return userPage;
      }
      userPage = await newPage();
      const page = userPage;
      // Your tab doesn't keep the browser running by itself: it closes with the idle timer.
      pages = Math.max(0, pages - 1);
      return page;
    },
    close,
  };
}

// The rules for a routine's own browsing ---------------------------------------------------------

const DOMAINS = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const bareHost = (host) => String(host).toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/**
 * Sites the instruction names (as links or bare names like "amazon.in"): the only ones a run may act
 * on. The domain of an email address ("me@google.com") doesn't count.
 */
export function actSites(...texts) {
  const sites = new Set();
  for (const text of texts) {
    const value = String(text ?? "");
    for (const m of value.matchAll(DOMAINS)) if (value[m.index - 1] !== "@") sites.add(bareHost(m[0]));
  }
  return sites;
}

/** Exactly a named site (with or without www.): naming google.com doesn't open mail.google.com. */
export function mayActOn(url, sites) {
  try {
    return sites.has(bareHost(new URL(url).hostname));
  } catch {
    return false;
  }
}

/**
 * A page that came from a link the run found (not from its instruction), whose address carries data
 * (?text=…, #…) and which opened with a text field already filled in with words that aren't in the
 * instruction: a "post this" or "compose" link someone wrote. Pressing buttons there would send their
 * words, so it isn't allowed. (Short values like a quantity don't count.)
 */
export function prefilledFromOutside(view, trustedUrls, trusted) {
  let fromOutside = true;
  try {
    const u = new URL(view.url);
    fromOutside = Boolean(u.search || u.hash) && !trustedUrls.has(view.url) && !trustedUrls.has(`${u.origin}${u.pathname}${u.search}`);
  } catch {}
  if (!fromOutside) return false;
  return (view.controls ?? []).some((c) => c.role === "textbox" && c.value && c.value.trim().length > 3 && !mayType(c.value, trusted));
}

const squash = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/** Text a run may type: it has to be in the instruction (or a skill), so nothing the run read can leave in a form. */
export function mayType(text, trusted) {
  const wanted = squash(text);
  return wanted.length > 0 && squash(trusted).includes(wanted);
}

/** A page as the bot reads it: the text, then the numbered controls. */
export function pageText(view) {
  const controls = (view.controls ?? []).map((c) => {
    const extra = [c.href ? `→ ${c.href}` : "", c.value ? `(now: "${c.value}")` : "", c.options?.length ? `options: ${c.options.join(" | ")}` : "", c.password ? "(password: you can't type here)" : ""].filter(Boolean).join(" ");
    return `[${c.id}] ${c.role} "${c.label}"${extra ? ` ${extra}` : ""}`;
  });
  return [`Page: ${view.title || "(no title)"}`, `Address: ${view.url}`, "", view.text || "(no text)", "", controls.length ? `Controls (use the [number] with click, type or select):\n${controls.join("\n")}` : "No controls."].join("\n");
}
