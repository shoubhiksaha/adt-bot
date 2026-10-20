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
  "api.sarvam.ai",
  "texttospeech.googleapis.com",
  "*.tts.speech.microsoft.com",
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

/** Link-local addresses: cloud metadata services (169.254.169.254) live here; never relayed. */
export function isLinkLocal(address) {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) return ip.startsWith("169.254.");
  if (isIP(ip) === 6) {
    const mapped = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    return mapped ? isLinkLocal(mapped[1]) : /^fe[89ab]/.test(ip) || /^(?:::ffff:|64:ff9b::|::)a9fe:/.test(ip);
  }
  return false;
}

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
    if (ip === "::1" || ip === "::") return true;
    // IPv4 inside IPv6 (::ffff:127.0.0.1, which URL() writes as ::ffff:7f00:1; NAT64 64:ff9b::/96).
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

/**
 * For reading pages the bot found on the web: refuse a host that is, or resolves to, anything
 * private (any one record, not all of them) or that can't be resolved.
 */
export async function reachesPrivateNetwork(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (LOOPBACK_NAMES.has(host) || host === "host.docker.internal") return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  try {
    const records = await lookup(host, { all: true });
    return !records.length || records.some((r) => isPrivateAddress(r.address));
  } catch {
    return true;
  }
}

/** Headers safe to send on to another site when a request is redirected there (no keys). */
const CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

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
  "x-adtbot-public-only",
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

  const hostAllowed = async (url, publicOnly) => {
    const host = url.hostname.toLowerCase();
    // Pages the bot found on the web may not lead into this machine or its network.
    if (publicOnly && (await reachesPrivateNetwork(host))) return false;
    if (isLinkLocal(host)) return false;
    if (options.allowAllHosts) return true;
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
    const publicOnly = req.headers["x-adtbot-public-only"] === "1";
    if (publicOnly && (await reachesPrivateNetwork(target.hostname))) {
      return fail(res, 403, `${target.hostname} is on a private network: pages found on the web can't be read from there.`);
    }
    if (!(await hostAllowed(target, publicOnly))) {
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
      let method = req.method;
      let url = target;
      let upstream = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req),
        duplex: "half",
        redirect: "manual",
        signal: controller.signal,
      });
      // Follow redirects by hand so every hop is checked against the allowlist: an open redirect on
      // an allowed host must not lead the relay into the private network.
      for (let hop = 0; hop < 5 && [301, 302, 303, 307, 308].includes(upstream.status); hop++) {
        const location = upstream.headers.get("location");
        // A streamed request body can't be sent twice, so only bodiless requests follow 307/308.
        const asGet = upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === "POST");
        if (!location || (!asGet && method !== "GET" && method !== "HEAD")) break;
        const next = new URL(location, url);
        if (!/^https?:$/.test(next.protocol) || !(await hostAllowed(next, publicOnly))) {
          return fail(res, 403, `The relay won't follow a redirect to ${next.hostname}.`);
        }
        if (asGet) method = "GET";
        // Another site gets no API keys or custom headers.
        if (next.origin !== url.origin) {
          for (const key of Object.keys(headers)) if (!CROSS_ORIGIN_HEADERS.has(key)) delete headers[key];
        }
        url = next;
        upstream = await fetch(url, { method, headers, redirect: "manual", signal: controller.signal });
      }
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
