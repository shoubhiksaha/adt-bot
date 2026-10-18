import { createStore, get, set } from "idb-keyval";

/** Audit trail of every tool a bot ran (or was refused), newest first. Kept on this device. */
export type ActivityEntry = {
  id: string;
  at: number;
  bot: string;
  tool: string;
  summary: string;
  outcome: "done" | "error" | "denied" | "approved" | "auto";
  ms?: number;
  conversationId?: string;
};

const store = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-activity", "log");
const KEY = "entries";
const LIMIT = 1000;
let memory: ActivityEntry[] = [];
let loaded = false;

async function load() {
  if (loaded) return;
  loaded = true;
  memory = (store ? await get<ActivityEntry[]>(KEY, store) : undefined) ?? [];
}

export async function logActivity(entry: Omit<ActivityEntry, "id" | "at">) {
  await load();
  memory = [{ ...entry, id: crypto.randomUUID(), at: Date.now() }, ...memory].slice(0, LIMIT);
  if (store) await set(KEY, memory, store);
}

export async function listActivity(): Promise<ActivityEntry[]> {
  await load();
  return memory;
}

export async function clearActivity() {
  memory = [];
  loaded = true;
  if (store) await set(KEY, [], store);
}
