// Desktop shell for macOS, Windows and Linux.
// The UI is served from a private app:// origin (so saved chats survive restarts), and
// app://adtbot/api/proxy relays provider calls outside the page, which avoids CORS for every
// cloud provider, local LLM server and private model server.
const { app, BrowserWindow, ipcMain, Menu, net, protocol, session, shell, systemPreferences } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEV = process.argv.includes("--dev");
const DIST = path.join(__dirname, "..", "dist");
const DEV_ORIGIN = "http://localhost:5173";
const DROP_HEADERS = new Set(["host", "origin", "referer", "cookie", "content-length", "x-adtbot-target", "x-adtbot-token", "anthropic-dangerous-direct-browser-access"]);

// Present as plain Chrome: search engines and some sites block "Electron" user agents.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|adt-?bot|ADT ?Bot)\/[^ ]+/gi, "");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

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
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src * data: blob:",
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
    /**
     * Settings → Tools & safety → Computer access, pushed by the app (adt:system:access). Until it
     * arrives, assume the strictest mode.
     */
    access: { mode: "sandbox" },
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
    if (types.includes("video")) return callback(false);
    // macOS: ask for the system permission too; without it the app gets a silent microphone.
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
      return callback(await systemPreferences.askForMediaAccess("microphone").catch(() => false));
    }
    callback(true);
  });
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

  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]),
    );
  } else {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }]));
  }

  loadFeatures();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
