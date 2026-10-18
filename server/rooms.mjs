// LAN chat rooms: people on the same network chat with each other and with the host's bots from
// any browser. Plain Node (no dependencies); used by the desktop app (electron/features/60-rooms.cjs)
// and optionally by the self-hosted server (ROOMS=1).
//
//   GET  /r/<id>               guest page (self-contained, strict CSP)
//   POST /r/<id>/join          { name, pin } → { token, me }
//   GET  /r/<id>/events?token  Server-Sent Events: hello (history + presence), message, update, presence, typing…
//   POST /r/<id>/send          { text }            (Authorization: Bearer <token>)
//   POST /r/<id>/typing        {}                  (Authorization: Bearer <token>)
//   POST /r/<id>/leave         {}                  (Authorization: Bearer <token>)
//
// Security: binds only to private LAN addresses (plus loopback), 6-digit PIN compared in constant
// time with per-address and per-room lockouts, per-guest random tokens, size and rate limits, and
// every piece of content is rendered as text (never HTML) under a script-src 'self' CSP.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { guestCss, guestHtml, guestJs } from "./rooms-page.mjs";
import { qrSvg } from "./qr.mjs";

export const LIMITS = Object.freeze({
  maxGuests: 20,
  history: 200,
  /** Characters per guest message. */
  guestMessage: 2000,
  /** Characters per host / bot message. */
  hostMessage: 20000,
  name: 32,
  body: 16 * 1024,
  /** Wrong PINs per address before a lockout, and how long it lasts. */
  pinFailures: 5,
  pinWindowMs: 10 * 60_000,
  /** Wrong PINs for one room (all addresses) before joining pauses. */
  roomPinFailures: 40,
  /** Guest messages per 10 seconds. */
  messageBurst: 8,
  streamsPerGuest: 3,
  /** A guest whose last connection closed is dropped after this long. */
  idleDropMs: 90_000,
  kickBanMs: 5 * 60_000,
});

const ROOM_ID = /^[A-Za-z0-9_-]{6,40}$/;
const PREFERRED_PORT = 8790;

/** Escape text for HTML (the guest page itself renders everything with textContent). */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Strips control characters (keeps newlines and tabs), trims and caps length. */
export function cleanText(value, max) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, max);
}

function cleanName(value) {
  return cleanText(value, LIMITS.name).replace(/\s+/g, " ");
}

export function generatePin() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newRoomId() {
  return randomBytes(9).toString("base64url");
}

const digest = (value) => createHash("sha256").update(String(value)).digest();

/** Constant-time PIN check (hashing first makes both sides the same length). */
export function pinMatches(expected, given) {
  return timingSafeEqual(digest(expected), digest(given));
}

function isPrivateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Private IPv4 addresses of this machine's network interfaces (Wi-Fi, Ethernet…). */
export function privateIPv4s() {
  const out = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === "IPv4" && !a.internal && isPrivateV4(a.address) && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** Only devices on the local network (or this computer) may talk to the room server. */
function isLocalPeer(address = "") {
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || isPrivateV4(ip) || (a === 169 && b === 254);
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

/** Guards against DNS rebinding: guests reach the server by IP address (or localhost). */
function hostHeaderOk(host = "") {
  return /^(\d{1,3}(\.\d{1,3}){3}|localhost|\[[0-9a-f:.]+\])(:\d+)?$/i.test(host);
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
};

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
const json = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

function readJson(req) {
  return new Promise((resolve) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return resolve({ error: 415 });
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      // Too big: answer 413 and discard the rest (cut off abusive uploads entirely).
      if (size > LIMITS.body) resolve({ error: 413 });
      else chunks.push(chunk);
      if (size > LIMITS.body * 64) req.destroy();
    });
    req.on("end", () => {
      if (size > LIMITS.body) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(value && typeof value === "object" && !Array.isArray(value) ? { value } : { error: 400 });
      } catch {
        resolve({ error: 400 });
      }
    });
    req.on("error", () => resolve({ error: 400 }));
  });
}

/**
 * @typedef {{ id: string, seq: number, kind: "guest"|"host"|"bot"|"system", author: string, authorId?: string, text: string, ts: number, pending?: boolean }} RoomMessage
 * @typedef {{ id: string, name: string }} RoomBot
 * @typedef {{ id?: string, name: string, pin?: string, bots?: RoomBot[], hostName?: string, brand?: string, history?: RoomMessage[] }} RoomConfig
 */

/**
 * One server process can host several rooms. The HTTP listeners start with the first room and
 * close with the last one.
 * @param {{ onEvent?: (event: any) => void, hosts?: string[], port?: number, brand?: string, limits?: Partial<typeof LIMITS> }} [options]
 */
export function createRoomHub(options = {}) {
  const limits = { ...LIMITS, ...options.limits };
  const emit = (event) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken listener must not take the room down.
    }
  };
  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {import("node:http").Server[]} */
  let servers = [];
  let port = 0;
  let boundHosts = [];
  let starting = null;
  /** address → { count, first, lockedUntil } (wrong PINs, all rooms) */
  const failures = new Map();

  function handler(req, res) {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "Something went wrong." });
      else res.end();
    });
  }

  async function handle(req, res) {
    const peer = req.socket.remoteAddress ?? "";
    if (!isLocalPeer(peer) || !hostHeaderOk(req.headers.host)) return json(res, 403, { error: "Only devices on the local network can join." });
    const url = new URL(req.url ?? "/", "http://room.local");
    const path = url.pathname;
    if (req.method === "GET" && path === "/room-assets/room.js") return send(res, 200, "text/javascript; charset=utf-8", guestJs);
    if (req.method === "GET" && path === "/room-assets/room.css") return send(res, 200, "text/css; charset=utf-8", guestCss);
    if (path === "/favicon.ico") return send(res, 204, "text/plain", "");
    const match = /^\/r\/([^/]+)(?:\/(join|events|send|typing|leave))?\/?$/.exec(path);
    const room = match && ROOM_ID.test(match[1]) ? rooms.get(match[1]) : undefined;
    if (!room) return send(res, 404, "text/html; charset=utf-8", guestHtml({ roomName: "Room not found", brand: options.brand ?? "ADT Bot", missing: true }));
    const action = match[2] ?? "";

    if (req.method === "GET" && action === "") {
      return send(res, 200, "text/html; charset=utf-8", guestHtml({ roomName: room.name, brand: room.brand }));
    }
    if (req.method === "GET" && action === "events") return openStream(room, req, res, url.searchParams.get("token") ?? "");
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (action === "join") return join(room, req, res, peer);

    const guest = guestFor(room, bearer(req));
    if (!guest) return json(res, 401, { error: "Please join the room again." });
    const body = await readJson(req);
    if (body.error) return json(res, body.error, { error: "Bad request." });
    if (action === "send") {
      const raw = String(body.value.text ?? "");
      if (raw.length > limits.guestMessage) return json(res, 413, { error: `Messages can be up to ${limits.guestMessage} characters.` });
      const text = cleanText(raw, limits.guestMessage);
      if (!text) return json(res, 400, { error: "Type a message first." });
      const now = Date.now();
      guest.sent = guest.sent.filter((t) => now - t < 10_000);
      if (guest.sent.length >= limits.messageBurst) return json(res, 429, { error: "You're sending messages too fast. Wait a few seconds." });
      guest.sent.push(now);
      const message = addMessage(room, { kind: "guest", author: guest.name, authorId: guest.id, text });
      return json(res, 200, { ok: true, id: message.id });
    }
    if (action === "typing") {
      const now = Date.now();
      if (now - guest.lastTyping > 1500) {
        guest.lastTyping = now;
        broadcast(room, "typing", { id: guest.id, name: guest.name }, guest.id);
        emit({ type: "typing", roomId: room.id, who: { id: guest.id, name: guest.name } });
      }
      return json(res, 200, { ok: true });
    }
    if (action === "leave") {
      removeGuest(room, guest, "left");
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found." });
  }

  function bearer(req) {
    const value = req.headers.authorization ?? "";
    return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  }

  function guestFor(room, token) {
    if (!token || token.length > 100) return undefined;
    return room.guests.get(digest(token).toString("hex"));
  }

  async function join(room, req, res, peer) {
    const now = Date.now();
    const key = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
    const record = failures.get(key);
    if (record && record.lockedUntil > now) {
      return json(res, 429, { error: "Too many wrong PINs. Try again in a few minutes.", retryAfter: Math.ceil((record.lockedUntil - now) / 1000) });
    }
    if (room.lockedUntil > now) return json(res, 429, { error: "Joining is paused for this room after many wrong PINs. Ask the host." });
    const banned = room.bans.get(key);
    if (banned && banned > now) return json(res, 403, { error: "The host removed you from this room." });
    const body = await readJson(req);
    if (body.error) return json(res, body.error, { error: "Bad request." });
    const pin = String(body.value.pin ?? "").replace(/\s+/g, "").slice(0, 12);
    if (!pinMatches(room.pin, pin)) {
      const r = record && now - record.first < limits.pinWindowMs ? record : { count: 0, first: now, lockedUntil: 0 };
      r.count++;
      if (r.count >= limits.pinFailures) {
        r.lockedUntil = now + limits.pinWindowMs;
        emit({ type: "notice", roomId: room.id, text: `Blocked ${key} for 10 minutes after ${r.count} wrong PINs.` });
      }
      failures.set(key, r);
      room.pinFailures = room.pinFailures.filter((t) => now - t < limits.pinWindowMs);
      room.pinFailures.push(now);
      if (room.pinFailures.length >= limits.roomPinFailures) {
        room.lockedUntil = now + limits.pinWindowMs;
        emit({ type: "notice", roomId: room.id, text: "Joining paused for 10 minutes: too many wrong PINs." });
      }
      return json(res, 403, { error: "Wrong PIN.", attemptsLeft: Math.max(0, limits.pinFailures - r.count) });
    }
    failures.delete(key);
    let name = cleanName(body.value.name);
    if (!name) return json(res, 400, { error: "Enter your name." });
    if (room.guests.size >= limits.maxGuests) return json(res, 403, { error: "This room is full." });
    name = uniqueName(room, name);
    const token = randomBytes(24).toString("base64url");
    const guest = { id: randomBytes(6).toString("base64url"), name, ip: key, joinedAt: now, streams: new Set(), sent: [], lastTyping: 0, dropTimer: null };
    room.guests.set(digest(token).toString("hex"), guest);
    // Dropped if they never open the event stream.
    scheduleDrop(room, guest);
    emitPresence(room);
    return json(res, 200, { token, me: { id: guest.id, name: guest.name } });
  }

  /** Guests can't take the host's, a bot's or another guest's name. */
  function uniqueName(room, wanted) {
    const taken = new Set([room.hostName, ...room.bots.map((b) => b.name), ...[...room.guests.values()].map((g) => g.name)].map((n) => n.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let i = 2; ; i++) {
      const candidate = `${wanted.slice(0, limits.name - 4)} (${i})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  function scheduleDrop(room, guest) {
    clearTimeout(guest.dropTimer);
    guest.dropTimer = setTimeout(() => {
      if (!guest.streams.size) removeGuest(room, guest, "timeout");
    }, limits.idleDropMs);
    guest.dropTimer.unref?.();
  }

  function openStream(room, req, res, token) {
    const guest = guestFor(room, token);
    if (!guest) return json(res, 401, { error: "Please join the room again." });
    if (guest.streams.size >= limits.streamsPerGuest) return json(res, 429, { error: "Too many open windows." });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    const wasOnline = guest.streams.size > 0;
    guest.streams.add(res);
    clearTimeout(guest.dropTimer);
    write(res, "hello", { me: { id: guest.id, name: guest.name }, room: roomInfo(room), history: room.messages, guests: presence(room) });
    if (!wasOnline) emitPresence(room);
    req.on("close", () => {
      guest.streams.delete(res);
      if (!guest.streams.size && room.guests.has(tokenKeyOf(room, guest))) {
        scheduleDrop(room, guest);
        emitPresence(room);
      }
    });
  }

  function tokenKeyOf(room, guest) {
    for (const [key, g] of room.guests) if (g === guest) return key;
    return "";
  }

  function write(res, event, data) {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(room, event, data, exceptGuestId) {
    for (const guest of room.guests.values()) {
      if (guest.id === exceptGuestId) continue;
      for (const res of guest.streams) write(res, event, data);
    }
  }

  function roomInfo(room) {
    return { id: room.id, name: room.name, brand: room.brand, hostName: room.hostName, bots: room.bots, limits: { message: limits.guestMessage } };
  }

  function presence(room) {
    return [...room.guests.values()].map((g) => ({ id: g.id, name: g.name, online: g.streams.size > 0, joinedAt: g.joinedAt }));
  }

  function emitPresence(room) {
    const guests = presence(room);
    broadcast(room, "presence", { guests });
    emit({ type: "presence", roomId: room.id, guests });
  }

  function removeGuest(room, guest, reason) {
    const key = tokenKeyOf(room, guest);
    if (!key) return;
    room.guests.delete(key);
    clearTimeout(guest.dropTimer);
    for (const res of guest.streams) {
      write(res, reason === "kicked" ? "kicked" : "bye", { reason });
      res.end();
    }
    guest.streams.clear();
    emitPresence(room);
  }

  /** @returns {RoomMessage} */
  function addMessage(room, { kind, author, authorId, text, pending }) {
    const message = { id: randomBytes(8).toString("base64url"), seq: ++room.seq, kind, author, authorId, text, ts: Date.now(), ...(pending ? { pending: true } : {}) };
    room.messages.push(message);
    if (room.messages.length > limits.history) room.messages.splice(0, room.messages.length - limits.history);
    broadcast(room, "message", message);
    emit({ type: "message", roomId: room.id, message });
    return message;
  }

  async function listen() {
    if (servers.length) return;
    const hosts = options.hosts ?? [...privateIPv4s(), "127.0.0.1"];
    const listenOn = (host, wantedPort) =>
      new Promise((resolve, reject) => {
        const server = createServer(handler);
        server.headersTimeout = 15_000;
        server.requestTimeout = 0; // event streams stay open
        server.once("error", reject);
        server.listen(wantedPort, host, () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    const opened = [];
    let chosen = options.port ?? PREFERRED_PORT;
    for (const host of hosts) {
      try {
        const server = await listenOn(host, chosen);
        opened.push({ host, server });
        chosen = server.address().port;
      } catch (error) {
        // The preferred port is busy: let the OS pick one, then use it everywhere.
        if (!opened.length && error.code === "EADDRINUSE" && chosen !== 0) {
          try {
            const server = await listenOn(host, 0);
            opened.push({ host, server });
            chosen = server.address().port;
          } catch {
            // skip this address
          }
        }
      }
    }
    if (!opened.length) throw new Error("Could not start the room server on this network.");
    servers = opened.map((o) => o.server);
    boundHosts = opened.map((o) => o.host);
    port = chosen;
  }

  async function closeServers() {
    const closing = servers;
    servers = [];
    boundHosts = [];
    port = 0;
    await Promise.all(
      closing.map(
        (server) =>
          new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          }),
      ),
    );
  }

  function urlsFor(room) {
    const lan = boundHosts.filter((h) => h !== "127.0.0.1" && h !== "localhost");
    const list = (lan.length ? lan : boundHosts).map((h) => `http://${h}:${port}/r/${room.id}`);
    return list;
  }

  function describe(room) {
    const urls = urlsFor(room);
    return {
      id: room.id,
      name: room.name,
      pin: room.pin,
      bots: room.bots,
      hostName: room.hostName,
      running: true,
      port,
      urls,
      localUrl: boundHosts.includes("127.0.0.1") ? `http://127.0.0.1:${port}/r/${room.id}` : null,
      lanAvailable: urls.some((u) => !u.includes("127.0.0.1")),
      qr: urls[0] ? qrSvg(urls[0], { scale: 5 }) : "",
      guests: presence(room),
      messages: room.messages,
    };
  }

  function requireRoom(id) {
    const room = rooms.get(String(id));
    if (!room) throw new Error("That room isn't running.");
    return room;
  }

  return {
    /** @param {RoomConfig} config */
    async startRoom(config) {
      const id = config.id && ROOM_ID.test(config.id) ? config.id : newRoomId();
      if (rooms.has(id)) return describe(rooms.get(id));
      const pin = /^\d{6}$/.test(config.pin ?? "") ? config.pin : generatePin();
      starting ??= listen().finally(() => {
        starting = null;
      });
      await starting;
      const room = {
        id,
        name: cleanText(config.name, 60) || "Chat room",
        brand: cleanText(config.brand ?? options.brand, 40) || "ADT Bot",
        hostName: cleanName(config.hostName) || "Host",
        pin,
        bots: (config.bots ?? []).slice(0, 8).map((b) => ({ id: cleanText(b.id, 80), name: cleanName(b.name) || "Bot" })),
        guests: new Map(),
        messages: Array.isArray(config.history) ? config.history.slice(-limits.history) : [],
        seq: 0,
        pinFailures: [],
        lockedUntil: 0,
        bans: new Map(),
      };
      room.seq = room.messages.reduce((max, m) => Math.max(max, m.seq ?? 0), 0);
      rooms.set(id, room);
      emit({ type: "state", roomId: id, running: true });
      return describe(room);
    },

    async stopRoom(id) {
      const room = rooms.get(String(id));
      if (!room) return { ok: true };
      const guests = [...room.guests.values()];
      room.guests.clear();
      for (const guest of guests) {
        clearTimeout(guest.dropTimer);
        for (const res of guest.streams) {
          write(res, "closed", { reason: "The host closed the room." });
          res.end();
        }
      }
      rooms.delete(room.id);
      emit({ type: "state", roomId: room.id, running: false });
      if (!rooms.size) await closeServers();
      return { ok: true };
    },

    list() {
      return [...rooms.values()].map(describe);
    },

    get(id) {
      const room = rooms.get(String(id));
      return room ? describe(room) : null;
    },

    /** Host or bot message. Bot replies start with pending: true and stream in through update(). */
    post(id, { kind = "host", author, text = "", pending = false, botId } = {}) {
      const room = requireRoom(id);
      const k = kind === "bot" ? "bot" : kind === "system" ? "system" : "host";
      const name = k === "host" ? room.hostName : k === "bot" ? cleanName(author) || "Bot" : "Room";
      return addMessage(room, { kind: k, author: name, authorId: k === "bot" ? cleanText(botId, 80) : undefined, text: cleanText(text, limits.hostMessage), pending });
    },

    update(id, messageId, { text, done = false } = {}) {
      const room = requireRoom(id);
      const message = room.messages.find((m) => m.id === messageId);
      if (!message || message.kind !== "bot") return { ok: false };
      if (typeof text === "string") message.text = cleanText(text, limits.hostMessage);
      if (done) delete message.pending;
      const data = { id: message.id, text: message.text, done: !message.pending };
      broadcast(room, "update", data);
      emit({ type: "update", roomId: room.id, ...data });
      return { ok: true };
    },

    kick(id, guestId) {
      const room = requireRoom(id);
      const guest = [...room.guests.values()].find((g) => g.id === guestId);
      if (!guest) return { ok: false };
      room.bans.set(guest.ip, Date.now() + limits.kickBanMs);
      removeGuest(room, guest, "kicked");
      return { ok: true };
    },

    clear(id) {
      const room = requireRoom(id);
      room.messages = [];
      broadcast(room, "cleared", {});
      emit({ type: "cleared", roomId: room.id });
      return { ok: true };
    },

    /** Host typing / a bot thinking, shown to guests. */
    typing(id, name) {
      const room = requireRoom(id);
      broadcast(room, "typing", { id: "host", name: cleanName(name) || room.hostName });
      return { ok: true };
    },

    async close() {
      for (const id of [...rooms.keys()]) await this.stopRoom(id);
      await closeServers();
    },

    /** For tests and diagnostics. */
    info() {
      return { port, hosts: [...boundHosts], rooms: rooms.size };
    },
  };
}
