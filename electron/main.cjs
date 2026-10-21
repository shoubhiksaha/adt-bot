// Desktop shell for macOS, Windows and Linux.
// The UI is served from a private app:// origin (so saved chats survive restarts), and
// app://adtbot/api/proxy relays provider calls outside the page, which avoids CORS for every
// cloud provider, local LLM server and private model server.
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Notification, net, protocol, safeStorage, session, shell, systemPreferences } = require("electron");
const { lookup } = require("node:dns/promises");
const fs = require("node:fs");
const { isIP } = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createVault } = require("./secrets.cjs");

const DEV = process.argv.includes("--dev");
const DIST = path.join(__dirname, "..", "dist");
const DEV_ORIGIN = "http://localhost:5173";
const DROP_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "content-length",
  "x-adtbot-target",
  "x-adtbot-token",
  "x-adtbot-public-only",
  "anthropic-dangerous-direct-browser-access",
]);

// Present as plain Chrome: search engines and some sites block "Electron" user agents.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|adt-?bot|ADT ?Bot)\/[^ ]+/gi, "");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
const PRIVATE_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".home.arpa", ".ts.net"];

/** Loopback, LAN, link-local, CGNAT/Tailscale, unspecified and IPv6 unique-local addresses (as server/proxy.mjs). */
function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::") return true;
    // IPv4 inside IPv6 (::ffff:127.0.0.1, which URL() writes as ::ffff:7f00:1; NAT64 64:ff9b::/96;
    // the deprecated ::a.b.c.d): judge the IPv4 address.
    const embedded = /^(?:::ffff:|64:ff9b::|::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(ip);
    if (embedded) {
      if (embedded[1]) return isPrivateAddress(embedded[1]);
      const high = parseInt(embedded[2], 16);
      const low = parseInt(embedded[3], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  }
  return false;
}

/** A private IP literal, a LAN-style name, or a name whose DNS answers include a private address. */
async function isPrivateHost(hostname) {
  // "localhost." with a trailing dot is the same name.
  const host = String(hostname).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (LOOPBACK_NAMES.has(host)) return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  try {
    const records = await lookup(host, { all: true });
    return !records.length || records.some((r) => isPrivateAddress(r.address));
  } catch {
    // Can't be checked, so it isn't read (the browser engine might still reach it some other way).
    return true;
  }
}

/**
 * GET a public web page for a bot (read_url): every hop of a redirect is checked, so a public link
 * can't bounce the request to the router, a local server or cloud metadata.
 */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

/**
 * Pages are read through their own session, which records the address each response really came
 * from: a name can resolve to a public address when it's checked and a private one when it's
 * fetched (DNS rebinding), so the address actually used is checked too.
 */
let publicSession = null;
const answeredFrom = new Map();
function pageSession() {
  if (publicSession) return publicSession;
  publicSession = session.fromPartition("adt-public-pages", { cache: false });
  publicSession.webRequest.onResponseStarted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
    if (details.ip) answeredFrom.set(details.url, details.ip);
    if (answeredFrom.size > 200) answeredFrom.delete(answeredFrom.keys().next().value);
  });
  return publicSession;
}

async function fetchPublic(url, headers) {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const target = new URL(current);
    if (!/^https?:$/.test(target.protocol)) throw new Error("only http(s) pages can be read");
    if (await isPrivateHost(target.hostname)) throw new Error(`${target.host} is on a private network; the page can only be read with your approval`);
    const result = await new Promise((resolve, reject) => {
      const request = net.request({ url: target.toString(), method: "GET", redirect: "manual", headers, session: pageSession() });
      // A page that never finishes (or never starts) mustn't tie up the app.
      const timer = setTimeout(() => {
        request.abort();
        reject(new Error("the page took too long"));
      }, 20_000);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      request.on("redirect", (_status, _method, location) => {
        request.abort();
        settle(resolve)({ location: new URL(location, target).toString() });
      });
      request.on("response", (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_PAGE_BYTES) return void chunks.push(chunk);
          // Enough of the page: stop downloading.
          request.abort();
          settle(resolve)({ response, body: Buffer.concat(chunks) });
        });
        response.on("end", () => settle(resolve)({ response, body: Buffer.concat(chunks) }));
        response.on("error", settle(reject));
      });
      request.on("error", settle(reject));
      request.end();
    });
    if (result.location) {
      current = result.location;
      continue;
    }
    const ip = answeredFrom.get(target.toString());
    answeredFrom.delete(target.toString());
    if (ip && isPrivateAddress(ip)) throw new Error(`${target.host} answered from a private network address; the page can only be read with your approval`);
    const type = result.response.headers["content-type"];
    const empty = [101, 204, 205, 304].includes(result.response.statusCode);
    return new Response(empty ? null : result.body, {
      status: result.response.statusCode,
      headers: { "cache-control": "no-cache", ...(type ? { "content-type": Array.isArray(type) ? type[0] : type } : {}) },
    });
  }
  throw new Error("too many redirects");
}

async function relay(request) {
  let target;
  try {
    target = new URL(request.headers.get("x-adtbot-target") ?? "");
  } catch {
    return Response.json({ error: { message: "Missing x-adtbot-target header" } }, { status: 400 });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return Response.json({ error: { message: "Only http(s) targets are allowed" } }, { status: 400 });
  }
  const headers = {};
  for (const [key, value] of request.headers) if (!DROP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  if (request.headers.get("x-adtbot-public-only") === "1") {
    try {
      return await fetchPublic(target.toString(), headers);
    } catch (error) {
      return Response.json({ error: { message: `Could not read ${target.host}: ${error?.message ?? error}` } }, { status: 403 });
    }
  }
  try {
    // Chromium's network stack: honours the OS trust store (company CAs), system proxies and VPN DNS.
    const upstream = await net.fetch(target.toString(), {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
    });
    const responseHeaders = { "cache-control": "no-cache" };
    const type = upstream.headers.get("content-type");
    if (type) responseHeaders["content-type"] = type;
    // MCP connectors (Streamable HTTP) keep their session in this header.
    const mcpSession = upstream.headers.get("mcp-session-id");
    if (mcpSession) responseHeaders["mcp-session-id"] = mcpSession;
    // Sync (server/sync.mjs) tells copies apart by this header.
    const etag = upstream.headers.get("etag");
    if (etag) responseHeaders.etag = etag;
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const message = String(error?.message ?? error);
    const reason = /ERR_CONNECTION_REFUSED/.test(message)
      ? `nothing is listening on ${target.host}`
      : /ERR_CERT/.test(message)
        ? "its TLS certificate is not trusted. Add your server's CA certificate to the system keychain/certificate store"
        : /ERR_NAME_NOT_RESOLVED/.test(message)
          ? "the hostname could not be resolved (are you on the right network/VPN?)"
          : message;
    return Response.json({ error: { message: `Could not reach ${target.host}: ${reason}` } }, { status: 502 });
  }
}

// Cross-origin isolation enables multi-threaded WebAssembly, which makes on-device speech
// recognition about 3x faster. "credentialless" still allows images and fetches from other sites.
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// The page itself may only run the app's own scripts: no inline or remote code, so injected
// content can't reach the desktop bridge. Network calls stay open (any provider, local servers).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // https only (no plain http, ws or file); images in replies load only on a click (Markdown.tsx).
  "img-src 'self' data: blob: https:",
  "media-src * data: blob:",
  "connect-src 'self' * data: blob: ws: wss:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

async function serveFile(pathname) {
  let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST + path.sep) || pathname === "/" || !path.extname(file)) file = path.join(DIST, "index.html");
  const response = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  if (file.endsWith(".html")) headers.set("Content-Security-Policy", CSP);
  if (file.endsWith(".wasm")) headers.set("Content-Type", "application/wasm");
  if (file.endsWith(".mjs") || file.endsWith(".js")) headers.set("Content-Type", "text/javascript");
  return new Response(response.body, { status: response.status, headers });
}

let mainWindow = null;

// "Stop all bots" -----------------------------------------------------------------------------
// One shortcut that works from any app (the bot is usually driving another app, with ADT Bot behind
// it): ends every reply in the app (on screen and in the background) and every command, script,
// coding agent and screen action the desktop side is running.

const STOP_SHORTCUT = process.platform === "darwin" ? "Command+Shift+Escape" : "Control+Alt+Shift+Escape";
const STOP_LABEL = process.platform === "darwin" ? "⌘⇧⎋" : "Ctrl+Alt+Shift+Esc";
const stopAllHandlers = new Set();

function stopAllBots(source = "shortcut") {
  for (const handler of stopAllHandlers) {
    try {
      handler();
    } catch (error) {
      console.error("Stop all:", error);
    }
  }
  mainWindow?.webContents.send("adt:stop-all", { source });
  if (source !== "app" && Notification.isSupported()) {
    new Notification({ title: "Stopped all bots", body: "Every running bot, command and screen action was stopped.", silent: true }).show();
  }
}

/** Only the app's own pages may use the window, IPC and permissions; never a page navigated to by mistake. */
function trustedUrl(url) {
  try {
    const { protocol: scheme, host, origin } = new URL(url);
    return (scheme === "app:" && host === "adtbot") || (DEV && origin === DEV_ORIGIN);
  } catch {
    return false;
  }
}

/** ipcMain for features: every handler first checks that the call comes from the app's own page. */
const guardedIpc = {
  handle(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trustedUrl(event.senderFrame?.url ?? "")) throw new Error(`Blocked ${channel} from an untrusted page`);
      return handler(event, ...args);
    });
  },
  removeHandler: (channel) => ipcMain.removeHandler(channel),
};

/**
 * Desktop-only features (local commands, Docker computers, Mac control, CLI agents, LAN rooms…)
 * live in electron/features/*.cjs. Each exports register(ctx) and handles "adt:<feature>:*" IPC.
 */
function loadFeatures() {
  const dir = path.join(__dirname, "features");
  if (!fs.existsSync(dir)) return;
  const ctx = {
    app,
    ipcMain: guardedIpc,
    shell,
    BrowserWindow,
    getWindow: () => mainWindow,
    /** Push an event to the app UI (channel must start with "adt:"). */
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    userData: app.getPath("userData"),
    /** Secrets encrypted with the OS keychain (electron/secrets.cjs). */
    secrets: createVault({ dir: app.getPath("userData"), safeStorage }),
    /**
     * Settings → Tools & safety → Computer access, pushed by the app (adt:system:access). Until it
     * arrives, assume the strictest mode.
     */
    access: { mode: "sandbox" },
    /** Register cleanup for "Stop all bots" (kill commands, helpers, agents). */
    onStopAll: (handler) => stopAllHandlers.add(handler),
  };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".cjs")).sort()) {
    try {
      require(path.join(dir, file)).register(ctx);
    } catch (error) {
      console.error(`Feature ${file} failed to load:`, error);
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: "ADT Bot",
    // Electron remembers this window's size, position and maximized/full-screen state between runs.
    name: "main",
    windowStatePersistence: true,
    backgroundColor: "#0b0c0e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  // Links open in the user's browser (mailto: in the mail app), never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!trustedUrl(url)) {
      event.preventDefault();
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(DEV ? DEV_ORIGIN : "app://adtbot/");
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Voice input needs the microphone; clipboard is used by copy buttons. Nothing else is granted.
  const ALLOWED = ["media", "clipboard-sanitized-write", "clipboard-read"];
  session.defaultSession.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
    if (!trustedUrl(webContents.getURL()) || !ALLOWED.includes(permission)) return callback(false);
    if (permission !== "media") return callback(true);
    const types = details.mediaTypes ?? [];
    // macOS: ask for the system permission too; without it the app gets a silent microphone (or a
    // black camera). The camera is only used when you share it in voice mode.
    if (process.platform === "darwin") {
      for (const [type, device] of [["audio", "microphone"], ["video", "camera"]]) {
        if (!types.includes(type) || systemPreferences.getMediaAccessStatus(device) === "granted") continue;
        if (!(await systemPreferences.askForMediaAccess(device).catch(() => false))) return callback(false);
      }
    }
    callback(true);
  });
  // "Share your screen" in voice mode: the system's own picker where there is one (macOS 15+),
  // otherwise the main screen. Only the app's own page can ask.
  const { desktopCapturer } = require("electron");
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!trustedUrl(request.frame?.url ?? "")) return callback({});
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return Boolean(webContents && trustedUrl(webContents.getURL()) && ALLOWED.includes(permission));
  });
  // Lets voice mode explain a blocked or silent microphone ("granted", "denied", "restricted", "not-determined").
  ipcMain.handle("adt:mic:status", (event) => {
    if (!trustedUrl(event.senderFrame?.url ?? "")) return "unknown";
    return process.platform === "darwin" || process.platform === "win32" ? systemPreferences.getMediaAccessStatus("microphone") : "granted";
  });

  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/proxy") return relay(request);
    if (pathname === "/api/health") return Response.json({ ok: true, proxy: true });
    return serveFile(pathname);
  });

  const botsMenu = {
    label: "Bots",
    submenu: [{ label: `Stop All Bots (${STOP_LABEL} from any app)`, accelerator: STOP_SHORTCUT, click: () => stopAllBots("menu") }],
  };
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, botsMenu, { role: "windowMenu" }]),
    );
  } else {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }, botsMenu]));
  }
  if (!globalShortcut.register(STOP_SHORTCUT, () => stopAllBots("shortcut"))) console.warn(`Couldn't register ${STOP_SHORTCUT} (used by another app).`);
  // Voice mode keeps its timers and audio at full speed while the bot works in other apps.
  ipcMain.handle("adt:voice:active", (event, payload) => {
    if (!trustedUrl(event.senderFrame?.url ?? "")) throw new Error("Blocked adt:voice:active from an untrusted page");
    event.sender.setBackgroundThrottling(!payload?.active);
    return true;
  });
  ipcMain.handle("adt:stop-all", (event) => {
    if (!trustedUrl(event.senderFrame?.url ?? "")) throw new Error("Blocked adt:stop-all from an untrusted page");
    stopAllBots("app");
    return true;
  });

  loadFeatures();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
