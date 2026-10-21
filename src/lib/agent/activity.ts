import { createStore, get, set } from "idb-keyval";

/**
 * The agent log: every tool a bot ran (or was refused), newest first, with why it was allowed, what
 * it was given and what came back. Kept on this device; secrets in arguments are hidden.
 */
export type ActivityEntry = {
  id: string;
  at: number;
  /** The bot's name at the time (and its id, for filtering). */
  bot: string;
  botId?: string;
  tool: string;
  summary: string;
  outcome: "done" | "error" | "denied" | "approved" | "auto";
  ms?: number;
  conversationId?: string;
  /** Why it ran or didn't: "read-only", "Full access", "you allowed it", "blocked by your deny rule …". */
  decision?: string;
  /** The arguments, secrets hidden, cut short. */
  args?: string;
  /** What it returned, cut short. */
  result?: string;
  /** Outside content the turn had read before this action. */
  taint?: string;
};

const store = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-activity", "log");
const KEY = "entries";
export const ACTIVITY_LIMIT = 5000;
let memory: ActivityEntry[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  loaded ??= (async () => {
    const saved = store ? await get<ActivityEntry[]>(KEY, store).catch(() => undefined) : undefined;
    // Entries logged before loading finished stay in front.
    memory = [...memory, ...(saved ?? [])].slice(0, ACTIVITY_LIMIT);
  })();
  return loaded;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (!store || saveTimer) return;
  // Several tools can finish in the same moment: one write for all of them.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void set(KEY, memory, store).catch(() => undefined);
  }, 300);
}

export async function logActivity(entry: Omit<ActivityEntry, "id" | "at">) {
  await load();
  memory = [{ ...entry, id: crypto.randomUUID(), at: Date.now() }, ...memory].slice(0, ACTIVITY_LIMIT);
  save();
  listeners.forEach((l) => l());
}

export async function listActivity(): Promise<ActivityEntry[]> {
  await load();
  return memory;
}

export function onActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function clearActivity() {
  await load();
  memory = [];
  if (store) await set(KEY, [], store);
  listeners.forEach((l) => l());
}

const SECRET_KEY = /pass(word|phrase|code)?|secret|token|api[-_]?key|auth|cookie|\bpin\b|otp|credential|private[-_]?key/i;
const SECRET_VALUE = /\b(sk-[\w-]{12,}|xox[abpr]-[\w-]{10,}|gh[pousr]_\w{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*)/g;

/** Tool arguments for the log: secret-looking fields and values hidden, images and long text cut. */
export function redactArgs(args: Record<string, unknown>, max = 600): string {
  const json = JSON.stringify(args ?? {}, (key, value) => {
    if (key && SECRET_KEY.test(key)) return "•••";
    if (typeof value !== "string") return value;
    if (value.startsWith("data:")) return `[${value.slice(5, value.indexOf(";")) || "data"}]`;
    const hidden = value.replace(SECRET_VALUE, "•••");
    return hidden.length > 300 ? `${hidden.slice(0, 300)}…` : hidden;
  });
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** A result for the log: one line, cut short. */
export function resultPreview(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
