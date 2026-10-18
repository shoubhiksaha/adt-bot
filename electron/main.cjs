// Desktop shell for macOS, Windows and Linux.
// The UI is served from a private app:// origin (so saved chats survive restarts), and
// app://adtbot/api/proxy relays provider calls outside the page, which avoids CORS for every
// cloud provider, local LLM server and private model server.
const { app, BrowserWindow, ipcMain, Menu, net, protocol, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEV = process.argv.includes("--dev");
const DIST = path.join(__dirname, "..", "dist");
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

async function serveFile(pathname) {
  let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST) || pathname === "/" || !path.extname(file)) file = path.join(DIST, "index.html");
  const response = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  if (file.endsWith(".wasm")) headers.set("Content-Type", "application/wasm");
  if (file.endsWith(".mjs") || file.endsWith(".js")) headers.set("Content-Type", "text/javascript");
  return new Response(response.body, { status: response.status, headers });
}

let mainWindow = null;

/**
 * Desktop-only features (local commands, Docker computers, Mac control, CLI agents, LAN rooms…)
 * live in electron/features/*.cjs. Each exports register(ctx) and handles "adt:<feature>:*" IPC.
 */
function loadFeatures() {
  const dir = path.join(__dirname, "features");
  if (!fs.existsSync(dir)) return;
  const ctx = {
    app,
    ipcMain,
    shell,
    BrowserWindow,
    getWindow: () => mainWindow,
    /** Push an event to the app UI (channel must start with "adt:"). */
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    userData: app.getPath("userData"),
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
    if (!url.startsWith("app://") && !url.startsWith("http://localhost:5173")) {
      event.preventDefault();
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(DEV ? "http://localhost:5173" : "app://adtbot/");
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Voice input needs the microphone; clipboard is used by copy buttons. Nothing else is granted.
  const trusted = (url) => url.startsWith("app://adtbot") || (DEV && url.startsWith("http://localhost:5173"));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(trusted(webContents.getURL()) && ["media", "clipboard-sanitized-write", "clipboard-read"].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return Boolean(webContents && trusted(webContents.getURL()) && ["media", "clipboard-sanitized-write", "clipboard-read"].includes(permission));
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
