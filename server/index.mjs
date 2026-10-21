// Serves the built web app plus the provider proxy.
//   npm run build && npm start              → http://127.0.0.1:8787
//   HOST=0.0.0.0 PORT=8080 npm start        → reachable from your LAN / phone
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createProxyHandler } from "./proxy.mjs";
import { createSyncHandler, dataDir } from "./sync.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
};

// Cross-origin isolation enables multi-threaded WebAssembly (faster on-device speech recognition).
const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "credentialless",
};

/**
 * @param {{ port?: number, host?: string, distDir?: string, proxy?: Parameters<typeof createProxyHandler>[0], sync?: Parameters<typeof createSyncHandler>[0] | false, agent?: { handle: (req: any, res: any, next: () => void) => void } }} options
 * @returns {Promise<{ server: import("node:http").Server, url: string }>}
 */
export function startServer(options = {}) {
  const distDir = resolve(options.distDir ?? fileURLToPath(new URL("../dist", import.meta.url)));
  const proxy = createProxyHandler(options.proxy);

  const serveStatic = (req, res) => {
    let path;
    try {
      path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      // "/%": a malformed escape must not throw (and take the server down).
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(distDir, path));
    if (file !== distDir && !file.startsWith(distDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    if (!existsSync(file)) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("The app is not built yet. Run `npm run build` first.");
      return;
    }
    const immutable = file.includes(`${distDir}/assets/`);
    res.writeHead(200, {
      ...ISOLATION_HEADERS,
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(res);
  };

  const sync = options.sync ? createSyncHandler(options.sync) : (_req, _res, next) => next();
  const agent = options.agent ? options.agent.handle : (_req, _res, next) => next();
  const server = createServer((req, res) => {
    const fail = () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    };
    // A handler that throws (synchronously or not) answers 500 instead of taking the server down.
    try {
      Promise.resolve(sync(req, res, () => agent(req, res, () => proxy(req, res, () => serveStatic(req, res))))).catch(fail);
    } catch {
      fail();
    }
  });
  const host = options.host ?? "127.0.0.1";
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolvePromise({ server, url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}` });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.HOST ?? "127.0.0.1";
  // ADT_AGENT_TOKEN: run routines here while your computers are off (server/agent.mjs).
  let agent;
  if (process.env.ADT_AGENT_TOKEN) {
    const { createAgentHost, ntfyNotifier } = await import("./agent.mjs");
    const { createServerBrowser, findChromium } = await import("./browser.mjs");
    // A real browser for routines and for signing in to sites, when the server has Chromium (ADT_BROWSER=off to leave it out).
    const executable = findChromium();
    const browser = executable ? createServerBrowser({ dir: join(dataDir(), "agent", "browser"), executable }) : undefined;
    agent = createAgentHost({ dir: join(dataDir(), "agent"), token: process.env.ADT_AGENT_TOKEN, notify: ntfyNotifier(process.env.ADT_NTFY_URL), browser });
    if (browser) console.log(`Always-on routines can use a browser (${executable}).`);
    agent.start();
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const { url } = await startServer({
    host,
    port: Number(process.env.PORT ?? 8787),
    proxy: {
      // Bound to this machine only: any provider, local server or private server is fine,
      // as long as the request really comes from a localhost page.
      allowAllHosts: loopback || process.env.ADTBOT_PROXY_ALLOW_ALL === "1",
      loopbackOnly: loopback,
      allowPrivate: process.env.ADTBOT_PROXY_PRIVATE === "1" || process.env.ADTBOT_PROXY_LOCAL === "1",
      extraHosts: (process.env.ADTBOT_PROXY_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    },
    // ADT_SYNC=1: devices sync through this server (encrypted; the server never sees the content).
    sync:
      process.env.ADT_SYNC === "1"
        ? {
            dir: join(dataDir(), "sync"),
            maxBytes: Number(process.env.ADT_SYNC_MAX_MB || 32) * 1024 * 1024,
            maxVaults: Number(process.env.ADT_SYNC_MAX_VAULTS || 50),
            // Behind a reverse proxy (nginx, Caddy): rate-limit by the client's address it passes on.
            trustProxy: process.env.ADT_TRUST_PROXY === "1",
          }
        : false,
    agent,
  });
  console.log(`ADT Bot running at ${url}`);
  if (process.env.ADT_SYNC === "1") console.log(`Sync is on (data in ${join(dataDir(), "sync")}).`);
  if (agent) console.log(`Always-on routines are on (data in ${join(dataDir(), "agent")}).`);
  // ROOMS=1: also open a LAN chat room (people only; bots in rooms need the desktop app).
  if (process.env.ROOMS === "1") {
    const { createRoomHub } = await import("./rooms.mjs");
    const room = await createRoomHub({ brand: process.env.ROOM_BRAND }).startRoom({
      name: process.env.ROOM_NAME ?? "Chat room",
      pin: process.env.ROOM_PIN,
      hostName: process.env.ROOM_HOST ?? "Host",
    });
    console.log(`Room "${room.name}" is open on your network, PIN ${room.pin}:\n  ${room.urls.join("\n  ")}`);
  }
}
