// Sync storage for ADT Bot's devices (src/lib/sync.ts). It only ever holds ciphertext: each vault is
// one encrypted blob that devices replace in turn (If-Match on its ETag, so no update is lost), and
// a vault belongs to whoever created it (a token derived from their sync code, stored hashed).
//
// Off unless ADT_SYNC=1. Quotas keep a server on the internet from being used as free storage:
// ADT_SYNC_MAX_MB per vault (default 32) and ADT_SYNC_MAX_VAULTS (default 50).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VAULT = /^\/api\/sync\/([0-9a-f]{32})$/;
const TOKEN = /^[0-9a-f]{64}$/;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, if-match, if-none-match, x-adtbot-sync-token",
  "access-control-expose-headers": "etag",
};

const sha = (value) => createHash("sha256").update(value).digest("hex");

/**
 * @param {{ dir: string, maxBytes?: number, maxVaults?: number, perMinute?: number }} options
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => void}
 */
export function createSyncHandler({ dir, maxBytes = 32 * 1024 * 1024, maxVaults = 50, perMinute = 120 }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const calls = new Map();
  const meta = (vault) => {
    try {
      return JSON.parse(readFileSync(join(dir, `${vault}.json`), "utf8"));
    } catch {
      return null;
    }
  };
  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...CORS, "cache-control": "no-store", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  return (req, res, next) => {
    const match = VAULT.exec((req.url ?? "").split("?")[0]);
    if (!match) return next();
    if (req.method === "OPTIONS") return reply(res, 204);
    const vault = match[1];
    const ip = req.socket.remoteAddress ?? "";
    const now = Date.now();
    const recent = (calls.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) return reply(res, 429, { error: "Too many requests; try again in a minute." });
    calls.set(ip, [...recent, now]);
    if (calls.size > 10_000) calls.clear();

    const token = String(req.headers["x-adtbot-sync-token"] ?? "");
    if (!TOKEN.test(token)) return reply(res, 401, { error: "Missing sync token." });
    const saved = meta(vault);
    if (saved) {
      const a = Buffer.from(saved.tokenHash, "hex");
      const b = Buffer.from(sha(token), "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return reply(res, 403, { error: "This sync code doesn't match the vault." });
    }

    if (req.method === "GET") {
      if (!saved) return reply(res, 404, { error: "Nothing synced yet." });
      if (req.headers["if-none-match"] === saved.etag) return reply(res, 304, undefined, { etag: saved.etag });
      const body = readFileSync(join(dir, `${vault}.blob`));
      res.writeHead(200, { ...CORS, "content-type": "application/json", "cache-control": "no-store", etag: saved.etag });
      return res.end(body);
    }

    if (req.method === "DELETE") {
      if (!saved) return reply(res, 404, { error: "Nothing synced yet." });
      rmSync(join(dir, `${vault}.blob`), { force: true });
      rmSync(join(dir, `${vault}.json`), { force: true });
      return reply(res, 204);
    }

    if (req.method !== "PUT") return reply(res, 405, { error: "Use GET, PUT or DELETE." });
    const ifMatch = String(req.headers["if-match"] ?? "");
    // Someone else's copy landed since this device last looked: it must merge first.
    if (saved ? ifMatch !== saved.etag : ifMatch && ifMatch !== "none") return reply(res, 412, { error: "The synced copy changed; sync again." });
    if (!saved && readdirSync(dir).filter((f) => f.endsWith(".json")).length >= maxVaults) return reply(res, 507, { error: "This server has no room for another sync vault." });
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        reply(res, 413, { error: `Too large (over ${Math.round(maxBytes / 1048576)} MB).` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return;
      const body = Buffer.concat(chunks);
      try {
        const box = JSON.parse(body.toString("utf8"));
        if (box?.v !== 1 || typeof box.iv !== "string" || typeof box.data !== "string") throw new Error();
      } catch {
        return reply(res, 400, { error: "Not an encrypted sync copy." });
      }
      // Two devices racing: the second finds the ETag moved on.
      const current = meta(vault);
      if ((current?.etag ?? "") !== (saved?.etag ?? "")) return reply(res, 412, { error: "The synced copy changed; sync again." });
      const etag = `"${sha(body).slice(0, 20)}-${randomBytes(3).toString("hex")}"`;
      const tmp = join(dir, `${vault}.${process.pid}.tmp`);
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, join(dir, `${vault}.blob`));
      writeFileSync(join(dir, `${vault}.json`), JSON.stringify({ tokenHash: saved?.tokenHash ?? sha(token), etag, updatedAt: Date.now(), size }), { mode: 0o600 });
      reply(res, 200, { ok: true }, { etag });
    });
  };
}

/** Where the server keeps its data: ADT_DATA_DIR, or ~/.adt-bot-server. */
export function dataDir(env = process.env) {
  if (env.ADT_DATA_DIR) return env.ADT_DATA_DIR;
  const home = env.HOME || env.USERPROFILE || ".";
  const dir = join(home, ".adt-bot-server");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
