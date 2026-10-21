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
export function createSyncHandler({ dir, maxBytes = 32 * 1024 * 1024, maxVaults = 50, perMinute = 120, maxInFlight = 4 * 32 * 1024 * 1024, trustProxy = false }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const calls = new Map();
  /** Bytes of uploads being received right now, across everyone: many big uploads at once can't exhaust memory. */
  let inFlight = 0;
  const vaultCount = () => readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  const writeAtomic = (name, data) => {
    const tmp = join(dir, `${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  };
  const meta = (vault) => {
    try {
      const m = JSON.parse(readFileSync(join(dir, `${vault}.json`), "utf8"));
      return typeof m?.tokenHash === "string" && typeof m.etag === "string" ? m : null;
    } catch (error) {
      // A file that exists but can't be read stays claimed: nobody can take the vault over.
      if (error?.code !== "ENOENT") return { tokenHash: "", etag: "", broken: true };
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
    // Behind a reverse proxy every client has the proxy's address: its X-Forwarded-For only when trusted.
    const forwarded = trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const ip = forwarded || req.socket.remoteAddress || "";
    const now = Date.now();
    const recent = (calls.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) return reply(res, 429, { error: "Too many requests; try again in a minute." });
    calls.set(ip, [...recent, now]);
    if (calls.size > 10_000) calls.clear();

    const token = String(req.headers["x-adtbot-sync-token"] ?? "");
    if (!TOKEN.test(token)) return reply(res, 401, { error: "Missing sync token." });
    const saved = meta(vault);
    if (saved?.broken) return reply(res, 500, { error: "This vault's record is damaged; delete it on the server to start over." });
    if (saved) {
      const a = Buffer.from(saved.tokenHash, "hex");
      const b = Buffer.from(sha(token), "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return reply(res, 403, { error: "This sync code doesn't match the vault." });
    }

    if (req.method === "GET") {
      if (!saved) return reply(res, 404, { error: "Nothing synced yet." });
      if (req.headers["if-none-match"] === saved.etag) return reply(res, 304, undefined, { etag: saved.etag });
      let body;
      try {
        body = readFileSync(join(dir, `${vault}.blob`));
      } catch {
        return reply(res, 500, { error: "The synced copy is missing on the server." });
      }
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
    if (!saved && vaultCount() >= maxVaults) return reply(res, 507, { error: "This server has no room for another sync vault." });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) return reply(res, 413, { error: `Too large (over ${Math.round(maxBytes / 1048576)} MB).` });
    if (inFlight + Math.max(declared, 1) > maxInFlight) return reply(res, 503, { error: "The server is busy; try again in a moment." });
    const chunks = [];
    let size = 0;
    let tooBig = false;
    let counted = 0;
    const release = () => {
      inFlight -= counted;
      counted = 0;
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes || inFlight + chunk.length > maxInFlight) {
        tooBig = true;
        release();
        reply(res, size > maxBytes ? 413 : 503, { error: size > maxBytes ? `Too large (over ${Math.round(maxBytes / 1048576)} MB).` : "The server is busy; try again in a moment." });
        req.destroy();
        return;
      }
      inFlight += chunk.length;
      counted += chunk.length;
      chunks.push(chunk);
    });
    req.on("close", release);
    req.on("end", () => {
      if (tooBig) return;
      release();
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
      // New vaults uploading at the same time: the limit still holds.
      if (!current && vaultCount() >= maxVaults) return reply(res, 507, { error: "This server has no room for another sync vault." });
      const etag = `"${sha(body).slice(0, 20)}-${randomBytes(3).toString("hex")}"`;
      try {
        writeAtomic(`${vault}.blob`, body);
        writeAtomic(`${vault}.json`, JSON.stringify({ tokenHash: saved?.tokenHash ?? sha(token), etag, updatedAt: Date.now(), size }));
      } catch (error) {
        return reply(res, 507, { error: `Couldn't store it (${error?.code ?? "disk error"}).` });
      }
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
