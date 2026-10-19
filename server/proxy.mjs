// Same-origin relay for provider requests. Browsers block most AI APIs and local LLM servers
// with CORS; sending the request from Node avoids that. Used by `npm start`, the Vite dev
// server, Docker, and the desktop app.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Hosts the public web server may relay to. Desktop mode allows any host behind a token. */
export const DEFAULT_ALLOWED_HOSTS = [
  // Natural voices.
  "api.elevenlabs.io",
  "api.fish.audio",
  "api.cartesia.ai",
  "api.deepgram.com",
  "api.x.ai",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.groq.com",
  "api.deepseek.com",
  "api.mistral.ai",
  "api.together.xyz",
  "api.together.ai",
  "api.fireworks.ai",
  "api.cerebras.ai",
  "api.perplexity.ai",
  "api.moonshot.ai",
  "integrate.api.nvidia.com",
  "router.huggingface.co",
  // Web search engines used by the Search toggle.
  "html.duckduckgo.com",
  "api.duckduckgo.com",
  "*.wikipedia.org",
  "api.search.brave.com",
  "api.tavily.com",
];

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PRIVATE_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".home.arpa", ".ts.net"];

/** Loopback, LAN, link-local, CGNAT/Tailscale and IPv6 unique-local addresses. */
export function isPrivateAddress(address) {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(ip) === 6) {
    if (ip === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  }
  return false;
}

/**
 * True when a hostname points at a machine on a private network: a private IP literal, a
 * single-label or LAN-style name, or a name whose DNS records are all private (VPN/company DNS).
 */
export async function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_NAMES.has(host) || host === "host.docker.internal") return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  try {
    const records = await lookup(host, { all: true });
    return records.length > 0 && records.every((r) => isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "connection",
  "content-length",
  "accept-encoding",
  "x-adtbot-target",
  "x-adtbot-token",
]);

/**
 * @param {{
 *   token?: string,
 *   allowAllHosts?: boolean,
 *   allowPrivate?: boolean,
 *   loopbackOnly?: boolean,
 *   extraHosts?: string[],
 * }} options
 *   allowAllHosts: relay anywhere (used when only this machine can reach the server).
 *   allowPrivate: also relay to local and private-network model servers (LAN, VPN, Tailscale).
 *   loopbackOnly: reject requests whose Host header is not localhost, which blocks DNS-rebinding
 *     attacks from websites open in the same browser.
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next?: () => void) => void}
 */
export function createProxyHandler(options = {}) {
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...(options.extraHosts ?? [])].map((h) => h.toLowerCase()));

  const hostAllowed = async (url) => {
    if (options.allowAllHosts) return true;
    const host = url.hostname.toLowerCase();
    if (allowed.has(host) || [...allowed].some((h) => h.startsWith("*.") && host.endsWith(h.slice(1)))) return true;
    return Boolean(options.allowPrivate) && (await isPrivateHost(host));
  };

  const requestFromLoopback = (req) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    return LOOPBACK_NAMES.has(host);
  };

  return async (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (path.endsWith("/api/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, proxy: true }));
      return;
    }
    if (!path.endsWith("/api/proxy")) {
      next?.();
      return;
    }

    if (options.token && req.headers["x-adtbot-token"] !== options.token) {
      return fail(res, 403, "Invalid proxy token");
    }
    if (options.loopbackOnly && !requestFromLoopback(req)) {
      return fail(res, 403, "This relay only accepts requests from this computer (open the app via localhost).");
    }

    let target;
    try {
      target = new URL(String(req.headers["x-adtbot-target"] ?? ""));
    } catch {
      return fail(res, 400, "Missing or invalid x-adtbot-target header");
    }
    if (!/^https?:$/.test(target.protocol)) return fail(res, 400, "Only http(s) targets are allowed");
    if (!(await hostAllowed(target))) {
      return fail(
        res,
        403,
        `The relay is not allowed to reach ${target.hostname}. On the server, add it to ADTBOT_PROXY_HOSTS ` +
          "(comma separated), or set ADTBOT_PROXY_PRIVATE=1 to allow local and private-network model servers.",
      );
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!DROP_REQUEST_HEADERS.has(key) && typeof value === "string") headers[key] = value;
    }
    // Anthropic rejects requests that claim a browser origin without opting in; the relay is a server.
    delete headers["anthropic-dangerous-direct-browser-access"];

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req),
        duplex: "half",
        signal: controller.signal,
      });
      const responseHeaders = { "cache-control": "no-cache" };
      const type = upstream.headers.get("content-type");
      if (type) responseHeaders["content-type"] = type;
      // MCP connectors (Streamable HTTP) keep their session in this header.
      const mcpSession = upstream.headers.get("mcp-session-id");
      if (mcpSession) responseHeaders["mcp-session-id"] = mcpSession;
      res.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) return res.end();
      // Forward chunks as they arrive so streamed replies stay streamed.
      Readable.fromWeb(upstream.body).on("error", () => res.end()).pipe(res);
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error?.cause?.code;
      const reason =
        code === "ECONNREFUSED"
          ? `nothing is listening on ${target.host}`
          : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code ?? "")
            ? `its TLS certificate is not trusted (${code}). Start the server with NODE_EXTRA_CA_CERTS=/path/to/ca.pem`
            : error?.cause?.message ?? error?.message;
      fail(res, 502, `Could not reach ${target.host}: ${reason}`);
    }
  };
}

function fail(res, status, message) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}
