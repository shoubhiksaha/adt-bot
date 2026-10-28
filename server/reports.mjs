// The developer's inbox for voice reports (Settings → Voice → Save a voice report → Send to the
// developer, src/components/settings/VoiceReport.tsx). Off unless ADT_REPORTS=1.
//
// The app has no accounts, so anyone can send a report: that upload is the only public part, and it
// is kept small. A report is the text the person saw (or a stored .zip with it and the bot's voice),
// up to ADT_REPORTS_MAX_MB (default 8); a few an hour from one address and ADT_REPORTS_PER_HOUR from
// everyone; ADT_REPORTS_MAX_TOTAL_MB on disk (default 1024); each deleted after
// ADT_REPORTS_KEEP_DAYS (default 30). Nothing about the sender is stored, not even their address.
// Reading them needs the developer's token (ADT_REPORTS_TOKEN, or ADT_AGENT_TOKEN): the inbox page at
// /reports, or `npm run reports` (scripts/reports.mjs).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxPage } from "./reports-page.mjs";

const UPLOAD = "/api/reports";
const ITEM = /^\/api\/reports\/([0-9a-f]{24})(?:\/(report\.txt|bot-voice\.wav|download))?$/;
const HEADER = "ADT Bot voice report";
/** No 0/O or 1/I/L: a code read out or typed back by someone. */
const CODE_LETTERS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PLATFORMS = ["darwin", "win32", "linux"];

const sha = (value) => createHash("sha256").update(value).digest();

/**
 * The files in a stored (uncompressed) zip, as the app writes them (src/lib/voice-report.ts zipFiles).
 * Anything else, or anything that doesn't add up, is null.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer> | null}
 */
export function readStoredZip(buf) {
  const files = new Map();
  let at = 0;
  while (at + 4 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    if (at + 30 > buf.length) return null;
    const flags = buf.readUInt16LE(at + 6);
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const plain = buf.readUInt32LE(at + 22);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLength + extra;
    if (method !== 0 || flags & 0x8 || size !== plain || start + size > buf.length) return null;
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    if (files.has(name)) return null;
    files.set(name, buf.subarray(start, start + size));
    at = start + size;
  }
  // Then the central directory, and nothing before it that isn't a file.
  return files.size && at + 4 <= buf.length && buf.readUInt32LE(at) === 0x02014b50 ? files : null;
}

/** The report's own text and the bot's voice, if the upload really is a report; otherwise null. */
function parseReport(body, zip) {
  const isText = (b) => b.subarray(0, HEADER.length).toString("utf8") === HEADER && !b.toString("utf8").includes("�");
  if (!zip) return isText(body) ? { text: body, voice: null } : null;
  const files = readStoredZip(body);
  if (!files || ![...files.keys()].every((n) => n === "report.txt" || n === "bot-voice.wav")) return null;
  const text = files.get("report.txt");
  const voice = files.get("bot-voice.wav") ?? null;
  if (!text || !isText(text)) return null;
  if (voice && (voice.subarray(0, 4).toString("latin1") !== "RIFF" || voice.subarray(8, 12).toString("latin1") !== "WAVE")) return null;
  return { text, voice };
}

/** What the app says about the report (x-adtbot-report), kept short and plain. */
function parseAbout(header) {
  let about = {};
  try {
    about = JSON.parse(decodeURIComponent(String(header ?? "")));
  } catch {
    // Missing or unreadable: the report itself still says it all.
  }
  const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
  const version = str(about?.version, 20);
  return {
    version: /^\d+\.\d+\.\d+$/.test(version) ? version : "",
    platform: PLATFORMS.includes(about?.platform) ? about.platform : "",
    arch: /^[a-z0-9_]{1,10}$/.test(about?.arch ?? "") ? about.arch : "",
    note: str(about?.note, 300),
  };
}

/**
 * @param {{ dir: string, token: string, maxBytes?: number, maxTotalBytes?: number, keepDays?: number,
 *   perAddress?: number, perHour?: number, trustProxy?: boolean, now?: () => number }} options
 */
export function createReportInbox({
  dir,
  token,
  maxBytes = 8 * 1024 * 1024,
  maxTotalBytes = 1024 * 1024 * 1024,
  keepDays = 30,
  perAddress = 5,
  perHour = 120,
  trustProxy = false,
  now = Date.now,
}) {
  if (!token || token.length < 16) throw new Error("The report inbox needs a token of 16 or more characters (ADT_REPORTS_TOKEN).");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenHash = sha(token);
  const keepMs = keepDays * 24 * 60 * 60 * 1000;
  /** Upload times, per address and for everyone, for the hourly limits (memory only). */
  const sent = new Map();
  let sentAll = [];
  /** Wrong tokens per address in the last 10 minutes. */
  const wrong = new Map();
  let inFlight = 0;

  const ipOf = (req) => (trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "";
  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const writeAtomic = (name, data) => {
    const tmp = join(dir, `${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  };
  const readMeta = (id) => {
    try {
      const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
      return meta?.id === id ? meta : null;
    } catch {
      return null;
    }
  };
  const remove = (id) => {
    rmSync(join(dir, `${id}.bin`), { force: true });
    rmSync(join(dir, `${id}.json`), { force: true });
  };
  /** Every report, newest first; expired ones and leftovers are deleted on the way. */
  const sweep = () => {
    const reports = [];
    const names = readdirSync(dir);
    for (const name of names) {
      const [id, ext] = name.split(".");
      if (ext === "tmp" || name.endsWith(".tmp")) {
        // A write that never finished (the server stopped mid-upload).
        rmSync(join(dir, name), { force: true });
        continue;
      }
      if (ext !== "json") {
        if (!names.includes(`${id}.json`)) rmSync(join(dir, name), { force: true });
        continue;
      }
      const meta = readMeta(id);
      if (!meta || !names.includes(`${id}.bin`) || now() - meta.at > keepMs) remove(id);
      else reports.push(meta);
    }
    return reports.sort((a, b) => b.at - a.at);
  };
  const authorized = (req, res) => {
    const ip = ipOf(req);
    const recent = (wrong.get(ip) ?? []).filter((t) => now() - t < 10 * 60_000);
    if (recent.length >= 20) {
      reply(res, 429, { error: "Too many wrong tokens; try again in 10 minutes." });
      return false;
    }
    const given = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    if (given && timingSafeEqual(sha(given), tokenHash)) return true;
    wrong.set(ip, [...recent, now()]);
    if (wrong.size > 10_000) wrong.clear();
    reply(res, 401, { error: "The inbox token is missing or wrong." });
    return false;
  };

  /** POST /api/reports: one report, from anyone. */
  const receive = (req, res) => {
    const ip = ipOf(req);
    const t = now();
    const mine = (sent.get(ip) ?? []).filter((at) => t - at < 3_600_000);
    sentAll = sentAll.filter((at) => t - at < 3_600_000);
    if (mine.length >= perAddress) return reply(res, 429, { error: "Too many reports from this address; try again in an hour." });
    if (sentAll.length >= perHour) return reply(res, 429, { error: "The inbox is getting too many reports; try again in an hour." });
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    if (type !== "text/plain" && type !== "application/zip") return reply(res, 415, { error: "Send the report as text/plain or application/zip." });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) return reply(res, 413, { error: `Too large (over ${Math.round(maxBytes / 1048576)} MB).` });
    if (inFlight + Math.max(declared, 1) > 4 * maxBytes) return reply(res, 503, { error: "The inbox is busy; try again in a moment." });
    const chunks = [];
    let size = 0;
    let counted = 0;
    let failed = false;
    const release = () => {
      inFlight -= counted;
      counted = 0;
    };
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes || inFlight + chunk.length > 4 * maxBytes) {
        failed = true;
        release();
        reply(res, size > maxBytes ? 413 : 503, { error: size > maxBytes ? `Too large (over ${Math.round(maxBytes / 1048576)} MB).` : "The inbox is busy; try again in a moment." });
        req.destroy();
        return;
      }
      inFlight += chunk.length;
      counted += chunk.length;
      chunks.push(chunk);
    });
    req.on("close", release);
    req.on("end", () => {
      if (failed) return;
      release();
      const body = Buffer.concat(chunks);
      const report = parseReport(body, type === "application/zip");
      if (!report) return reply(res, 400, { error: "That isn't an ADT Bot voice report." });
      const used = sweep().reduce((sum, r) => sum + r.size, 0);
      if (used + body.length > maxTotalBytes) return reply(res, 507, { error: "The inbox is full; try again later." });
      const id = randomBytes(12).toString("hex");
      const code = Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
      const meta = { id, code, at: now(), size: body.length, zip: type === "application/zip", voice: Boolean(report.voice), ...parseAbout(req.headers["x-adtbot-report"]) };
      try {
        writeAtomic(`${id}.bin`, body);
        writeAtomic(`${id}.json`, JSON.stringify(meta));
      } catch (error) {
        remove(id);
        return reply(res, 507, { error: `Couldn't store it (${error?.code ?? "disk error"}).` });
      }
      sent.set(ip, [...mine, t]);
      if (sent.size > 10_000) sent.clear();
      sentAll.push(t);
      reply(res, 201, { code, keepDays });
    });
  };

  /** The developer's side: the inbox page, the list, each report and its voice, and deleting. */
  const read = (req, res, path) => {
    if (path === "/reports" || path === "/reports/") {
      if (req.method !== "GET") return reply(res, 405, { error: "Use GET." });
      const page = inboxPage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": page.csp });
      return res.end(page.html);
    }
    if (!authorized(req, res)) return;
    if (path === UPLOAD) return req.method === "GET" ? reply(res, 200, { keepDays, reports: sweep() }) : reply(res, 405, { error: "Use GET or POST." });
    const [, id, part] = ITEM.exec(path) ?? [];
    const meta = id ? readMeta(id) : null;
    if (!meta) return reply(res, 404, { error: "No such report (it may have been deleted)." });
    if (req.method === "DELETE") {
      remove(id);
      return reply(res, 204);
    }
    if (req.method !== "GET") return reply(res, 405, { error: "Use GET or DELETE." });
    let body;
    try {
      body = readFileSync(join(dir, `${id}.bin`));
    } catch {
      return reply(res, 404, { error: "That report's file is missing." });
    }
    const send = (data, type, name) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="${name}"` });
      res.end(data);
    };
    if (part === "download" || !part) {
      return send(body, meta.zip ? "application/zip" : "text/plain; charset=utf-8", `ADT Bot voice report ${meta.code}.${meta.zip ? "zip" : "txt"}`);
    }
    const report = parseReport(body, meta.zip);
    const file = part === "report.txt" ? report?.text : report?.voice;
    if (!file) return reply(res, 404, { error: part === "report.txt" ? "That report can't be read." : "This report has no recording." });
    send(file, part === "report.txt" ? "text/plain; charset=utf-8" : "audio/wav", part);
  };

  sweep();
  const hourly = setInterval(sweep, 3_600_000);
  hourly.unref?.();
  return {
    /** Everything: the upload, the inbox page and the developer's API. */
    handle(req, res, next) {
      const path = (req.url ?? "").split("?")[0];
      if (path === UPLOAD && req.method === "POST") return receive(req, res);
      if (path === UPLOAD || path === "/reports" || path === "/reports/" || ITEM.test(path)) return read(req, res, path);
      return next();
    },
    /** Only the upload: for a listener that's open to the internet (ADT_REPORTS_PUBLIC_PORT). */
    receiveOnly(req, res) {
      const path = (req.url ?? "").split("?")[0];
      if (path === UPLOAD && req.method === "POST") return receive(req, res);
      reply(res, 404, { error: "Not found." });
    },
    sweep,
    close() {
      clearInterval(hourly);
    },
  };
}
