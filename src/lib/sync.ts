/**
 * Sync between your devices, end-to-end encrypted, through your own ADT Bot server.
 *
 * Every device keeps its own copy. A sync pulls the server's copy, merges it with this device's
 * (newest change wins, per bot, chat, skill and provider; deletions are remembered), and pushes the
 * result back. The server only ever holds ciphertext: a sync code (16+ random characters, the same on
 * every device) derives both the encryption key and the vault's address, and never leaves the device.
 * API keys stay on each device unless you choose to sync them (still encrypted).
 */
import { providerFetch } from "./transport";
import type { Bot, Conversation, ProviderConfig, Skill } from "./types";

export type SyncProfile = { userName: string; about: string; customInstructions: string; sharedMemory: string[]; updatedAt: number };

export type SyncSnapshot = {
  v: 1;
  at: number;
  device: string;
  providers: ProviderConfig[];
  bots: Bot[];
  conversations: Conversation[];
  skills: Skill[];
  profile: SyncProfile;
  /** id → when it was deleted (kept 90 days). */
  tombstones: Record<string, number>;
};

export const TOMBSTONE_DAYS = 90;
/** Pictures in chats bigger than this stay on the device that has them. */
export const SYNC_IMAGE_BYTES = 400_000;
export const MAX_SYNC_BYTES = 30 * 1024 * 1024;

/** When a record last changed. */
export function stamp(record: { rev?: number; updatedAt?: number; createdAt?: number }): number {
  return Math.max(record.rev ?? 0, record.updatedAt ?? 0, record.createdAt ?? 0);
}

/** Two copies of a collection as one: the newest of each record, minus what was deleted after its last change. */
export function mergeRecords<T extends { id: string; rev?: number; updatedAt?: number; createdAt?: number }>(a: T[], b: T[], tombstones: Record<string, number>): T[] {
  const byId = new Map<string, T>();
  for (const record of [...a, ...b]) {
    const existing = byId.get(record.id);
    if (!existing || stamp(record) > stamp(existing)) byId.set(record.id, record);
  }
  return [...byId.values()].filter((r) => !(tombstones[r.id] && tombstones[r.id] >= stamp(r)));
}

export function mergeTombstones(a: Record<string, number>, b: Record<string, number>, now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  const cutoff = now - TOMBSTONE_DAYS * 86_400_000;
  for (const [id, at] of [...Object.entries(a), ...Object.entries(b)]) if (at > cutoff && at > (out[id] ?? 0)) out[id] = at;
  return out;
}

/** This device's copy and the server's as one. Local API keys win over blanks from the other copy. */
export function mergeSnapshots(local: SyncSnapshot, remote: SyncSnapshot, now = Date.now()): SyncSnapshot {
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones, now);
  const providers = mergeRecords(local.providers, remote.providers, tombstones).map((p) => {
    const mine = local.providers.find((x) => x.id === p.id);
    return mine?.apiKey && !p.apiKey ? { ...p, apiKey: mine.apiKey, headers: mine.headers ?? p.headers } : p;
  });
  return {
    v: 1,
    at: now,
    device: local.device,
    providers,
    bots: mergeRecords(local.bots, remote.bots, tombstones),
    conversations: mergeRecords(local.conversations, remote.conversations, tombstones),
    skills: mergeRecords(local.skills, remote.skills, tombstones),
    profile: remote.profile.updatedAt > local.profile.updatedAt ? remote.profile : local.profile,
    tombstones,
  };
}

/** A chat for syncing: big pictures stay behind (a note says so). */
export function slimConversation(c: Conversation): Conversation {
  if (!c.messages.some((m) => m.attachments?.some((a) => a.kind === "image" && a.dataUrl.length > SYNC_IMAGE_BYTES * 1.37))) return c;
  return {
    ...c,
    messages: c.messages.map((m) =>
      m.attachments?.some((a) => a.kind === "image" && a.dataUrl.length > SYNC_IMAGE_BYTES * 1.37)
        ? {
            ...m,
            attachments: m.attachments.map((a) =>
              a.kind === "image" && a.dataUrl.length > SYNC_IMAGE_BYTES * 1.37 ? { kind: "file" as const, name: a.name, text: "(A large picture: it's on the device it was added on.)", size: 0 } : a,
            ),
          }
        : m,
    ),
  };
}

/** A content fingerprint, to tell whether anything changed since the last sync. */
export async function digest(snapshot: SyncSnapshot): Promise<string> {
  const { at: _at, device: _device, ...content } = snapshot;
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sync codes and encryption --------------------------------------------------------------------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A new sync code: 20 random characters in groups of five (100 bits), e.g. K7QPM-2XRTA-…. */
export function newSyncCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{5}/g)!.join("-");
}

/** The code as typed on another device: spaces, dashes and case don't matter. */
export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function syncCodeProblem(code: string): string {
  const clean = normaliseCode(code);
  if (!clean) return "Enter or create a sync code.";
  if (clean.length < 16) return "That code is too short: use the 20-character code from your other device, or create one.";
  return "";
}

export type SyncKeys = { key: CryptoKey; vault: string; token: string };

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The encryption key, the vault's address and its write token, all from the sync code. */
export async function syncKeys(code: string, iterations = 600_000): Promise<SyncKeys> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(normaliseCode(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("adt-bot-sync-v1"), iterations }, base, 512));
  const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const auth = bits.slice(32);
  const vault = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", auth))).slice(0, 32);
  return { key, vault, token: toHex(auth) };
}

const AAD = new TextEncoder().encode("adt-bot sync v1");

async function gzip(bytes: Uint8Array, mode: "compress" | "decompress"): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(mode === "compress" ? new CompressionStream("gzip") : new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function seal(snapshot: SyncSnapshot, keys: SyncKeys): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await gzip(new TextEncoder().encode(JSON.stringify(snapshot)), "compress");
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, keys.key, packed as BufferSource));
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data) });
}

export async function unseal(body: string, keys: SyncKeys): Promise<SyncSnapshot> {
  const box = JSON.parse(body) as { v: number; iv: string; data: string };
  if (box?.v !== 1) throw new Error("The synced copy was made by a newer version. Update this app.");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.iv), additionalData: AAD }, keys.key, fromBase64(box.data)));
  } catch {
    throw new Error("The synced copy can't be opened with this code.");
  }
  const snapshot = JSON.parse(new TextDecoder().decode(await gzip(plain, "decompress"))) as SyncSnapshot;
  if (snapshot?.v !== 1 || !Array.isArray(snapshot.bots)) throw new Error("The synced copy isn't readable.");
  return snapshot;
}

// The server ------------------------------------------------------------------------------------

export type Remote = { body: string; etag: string } | null;

/** The page is served by the sync server itself: talk to it directly. Otherwise through the app's usual path. */
function request(url: string, init: RequestInit & { headers: Record<string, string> }, useProxy: boolean): Promise<Response> {
  const sameOrigin = typeof location !== "undefined" && /^https?:$/.test(location.protocol) && new URL(url).origin === location.origin;
  return sameOrigin ? fetch(url, init) : providerFetch(url, init, useProxy);
}

/** The server's copy (null if there is none yet). `etag` skips the download when nothing changed. */
export async function pull(server: string, keys: SyncKeys, useProxy: boolean, etag = ""): Promise<Remote | "unchanged"> {
  const res = await request(`${server.replace(/\/+$/, "")}/api/sync/${keys.vault}`, { method: "GET", headers: { "x-adtbot-sync-token": keys.token, ...(etag ? { "if-none-match": etag } : {}) } }, useProxy);
  if (res.status === 304) return "unchanged";
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await problem(res));
  return { body: await res.text(), etag: res.headers.get("etag") ?? "" };
}

/** Stores a new copy; fails with "conflict" when someone else pushed since `etag`. */
export async function push(server: string, keys: SyncKeys, body: string, useProxy: boolean, etag: string): Promise<string | "conflict"> {
  if (body.length > MAX_SYNC_BYTES) throw new Error("There's too much to sync (over 30 MB). Delete some old chats with big files.");
  const res = await request(
    `${server.replace(/\/+$/, "")}/api/sync/${keys.vault}`,
    { method: "PUT", headers: { "content-type": "application/json", "x-adtbot-sync-token": keys.token, "if-match": etag || "none" }, body },
    useProxy,
  );
  if (res.status === 412) return "conflict";
  if (!res.ok) throw new Error(await problem(res));
  return res.headers.get("etag") ?? "";
}

async function problem(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return `The sync server said ${res.status}: ${JSON.parse(text).error ?? text}`;
  } catch {
    return `The sync server said ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
  }
}
