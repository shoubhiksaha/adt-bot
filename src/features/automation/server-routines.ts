/**
 * Routines that run on your always-on server (server/agent.mjs): this keeps the server's copy in step
 * with the routine, its bot (instructions, memory, skills, model) and your search settings, and brings
 * the server's results back into the routine's chat, history and notifications.
 */
import { createStore, get, set } from "idb-keyval";
import { buildSystemPrompt } from "../../lib/chat";
import { withSharedMemory } from "../../lib/memory-recall";
import { useStore } from "../../lib/store";
import { providerFetch } from "../../lib/transport";
import type { Message } from "../../lib/types";
import { skillsFor, skillsPrompt } from "../skills/skills";
import { addBackgroundConversation } from "./conversations";
import { notify } from "./notify";
import { getRoutine, loadRoutines, patchRoutine, useRoutines } from "./routines-store";
import { finishRun, type Routine, type RoutineRun } from "./schedule";

type ServerResult = { id: string; jobId: string; name: string; at: number; finishedAt: number; trigger: string; status: "ok" | "quiet" | "error"; text: string; events?: number };

export function serverConfigured(): boolean {
  const { url, token } = useStore.getState().settings.server;
  return Boolean(url && token);
}

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { settings } = useStore.getState();
  const { url, token } = settings.server;
  if (!url || !token) throw new Error("Set up your always-on server in Settings → Sync first.");
  return providerFetch(
    `${url.replace(/\/+$/, "")}${path}`,
    {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    },
    settings.useProxy,
  );
}

async function problem(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  let reason = text.slice(0, 200);
  try {
    reason = JSON.parse(text).error ?? reason;
  } catch {}
  return new Error(res.status === 401 ? "The server refused the token (check Settings → Sync)." : `The server said ${res.status}: ${reason}`);
}

/** Checks the address and token; resolves with how many routines the server has. */
export async function testServer(): Promise<number> {
  const res = await call("/api/agent");
  if (res.status === 404) throw new Error("That server doesn't run routines (start it with ADT_AGENT_TOKEN set).");
  if (!res.ok) throw await problem(res);
  return ((await res.json()) as { jobs: unknown[] }).jobs.length;
}

/** What the server needs to run a routine: its bot's whole setup, with the provider key. */
export function serverJob(routine: Routine) {
  const { bots, providers, settings, skills } = useStore.getState();
  const bot = bots.find((b) => b.id === routine.botId);
  if (!bot) throw new Error("The routine's bot was deleted.");
  const provider = providers.find((p) => p.id === bot.providerId);
  if (!provider || provider.kind === "cli") throw new Error(`${bot.name} needs a cloud or private-server model to run on the server.`);
  const mine = skillsFor(bot, skills);
  const system = [
    buildSystemPrompt(withSharedMemory({ ...bot, autoMemory: false }, settings.sharedMemory), {
      userName: settings.userName,
      about: settings.about,
      customInstructions: settings.customInstructions,
      richBlocks: false,
    }).replace(/^Current date: .*$/m, ""),
    mine.length ? skillsPrompt(mine) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const t = routine.trigger;
  if (t && !["feed", "page", "webhook"].includes(t.type)) throw new Error("On the server a routine can run on a schedule, a feed, a page change or a webhook.");
  return {
    name: routine.name,
    instruction: routine.instruction,
    enabled: routine.enabled,
    system,
    provider: { kind: provider.kind, presetId: provider.presetId, name: provider.name, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: bot.model, headers: provider.headers },
    search: { engine: settings.search.engine, url: settings.search.url, apiKey: settings.search.apiKey },
    skills: mine.map(({ name, description, instructions }) => ({ name, description, instructions })),
    ...(t ? { trigger: { type: t.type, ...("url" in t ? { url: t.url } : {}) } } : { schedule: routine.schedule }),
  };
}

/** Sends (or updates) a routine on the server; keeps its webhook secret. */
export async function pushServerRoutine(routine: Routine): Promise<void> {
  const res = await call(`/api/agent/jobs/${routine.id}`, { method: "PUT", body: serverJob(routine) });
  if (!res.ok) throw await problem(res);
  const { job } = (await res.json()) as { job: { hookToken?: string } };
  if (job.hookToken !== routine.serverHook) await patchRoutine(routine.id, (r) => ({ ...r, serverHook: job.hookToken }));
}

export async function removeServerRoutine(id: string): Promise<void> {
  const res = await call(`/api/agent/jobs/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await problem(res);
}

export async function runOnServerNow(id: string): Promise<void> {
  const res = await call(`/api/agent/jobs/${id}/run`, { method: "POST" });
  if (!res.ok) throw await problem(res);
}

/** The webhook address a server routine listens on. */
export function serverHookUrl(routine: Routine): string {
  const { url } = useStore.getState().settings.server;
  return routine.serverHook ? `${url.replace(/\/+$/, "")}/api/agent/hook/${routine.serverHook}` : "";
}

const cursorStore = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-routines", "data");
let memoryCursor = 0;
const readCursor = async () => (cursorStore ? ((await get<number>("server-cursor", cursorStore).catch(() => 0)) ?? 0) : memoryCursor);
const writeCursor = async (value: number) => (cursorStore ? set("server-cursor", value, cursorStore) : void (memoryCursor = value));

/** Brings new results from the server into the routines' chats and histories. Returns how many. */
export async function collectServerResults(): Promise<number> {
  if (!serverConfigured()) return 0;
  await loadRoutines();
  const since = await readCursor();
  const res = await call(`/api/agent/results?since=${since}`);
  if (!res.ok) throw await problem(res);
  const { results } = (await res.json()) as { results: ServerResult[] };
  let newest = since;
  for (const result of results.sort((a, b) => a.finishedAt - b.finishedAt)) {
    newest = Math.max(newest, result.finishedAt);
    const routine = getRoutine(result.jobId);
    if (!routine) continue;
    const { conversations, bots } = useStore.getState();
    const chatId = routine.conversationId && conversations[routine.conversationId] ? routine.conversationId : addBackgroundConversation(routine.botId, `Routine: ${routine.name}`, false, "routine").id;
    const reply: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: result.status === "error" ? "" : result.text,
      ...(result.status === "error" ? { error: result.text } : {}),
      status: `Ran on your server${result.trigger === "event" ? " (something happened)" : ""}, ${new Date(result.at).toLocaleString()}`,
      createdAt: result.finishedAt,
    };
    useStore.setState((s) => {
      const c = s.conversations[chatId];
      return c ? { conversations: { ...s.conversations, [chatId]: { ...c, messages: [...c.messages, reply], updatedAt: Date.now(), rev: Date.now() } } } : {};
    });
    const run: RoutineRun = {
      id: result.id,
      startedAt: result.at,
      finishedAt: result.finishedAt,
      status: result.status,
      trigger: result.trigger === "event" ? "event" : result.trigger === "manual" ? "manual" : "schedule",
      conversationId: chatId,
      summary: result.text.replace(/\s+/g, " ").slice(0, 200),
    };
    await patchRoutine(routine.id, (r) => finishRun({ ...r, conversationId: chatId }, run));
    if (result.status !== "quiet") void notify(result.status === "error" ? `Routine failed: ${routine.name}` : routine.name, run.summary ?? "Done.", chatId);
    void bots;
  }
  if (newest > since) await writeCursor(newest);
  return results.length;
}

let started = false;

/** Keeps server routines in step (when they, their bots or skills change) and collects results every two minutes. */
export function startServerRoutines() {
  if (started || typeof window === "undefined") return;
  started = true;
  const pushed = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!serverConfigured()) return;
      const routines = useRoutines.getState().routines;
      const onServer = routines.filter((r) => r.where === "server");
      for (const r of onServer) {
        let job: unknown;
        try {
          job = serverJob(r);
        } catch {
          continue;
        }
        const key = JSON.stringify(job);
        if (pushed.get(r.id) === key) continue;
        try {
          await pushServerRoutine(r);
          pushed.set(r.id, key);
        } catch (error) {
          await patchRoutine(r.id, (x) => ({ ...x, triggerState: { ...x.triggerState, error: (error as Error).message.slice(0, 200) } }));
        }
      }
      // Routines deleted here, or moved back to this device, leave the server too.
      for (const id of [...pushed.keys()]) {
        if (!onServer.some((r) => r.id === id)) {
          await removeServerRoutine(id).catch(() => undefined);
          pushed.delete(id);
        }
      }
    }, 3000);
  };
  useRoutines.subscribe(sync);
  useStore.subscribe((s, p) => {
    if (s.bots !== p.bots || s.skills !== p.skills || s.settings.server !== p.settings.server || s.providers !== p.providers) sync();
  });
  void loadRoutines().then(() => {
    // Everything on the server already counts as sent; changes from here on are pushed.
    sync();
  });
  const collect = () => void collectServerResults().catch(() => undefined);
  setInterval(collect, 120_000);
  setTimeout(collect, 4000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && collect());
}
