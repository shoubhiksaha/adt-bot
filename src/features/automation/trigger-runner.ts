/**
 * Watches event routines' triggers while the app is open: new mail, Slack messages and X mentions
 * every few minutes, feeds and pages every 15. Webhooks and folders are watched by the desktop app,
 * which pushes their events here. Each check remembers where it left off, so only what's new runs.
 */
import { desktopInvoke, desktopOn, isDesktop } from "../../lib/desktop";
import { fetchPublicText, readPage } from "../../lib/search";
import { useStore } from "../../lib/store";
import { appsCall, refreshApps, useApps } from "../apps/api";
import { loadRoutines, patchRoutine, useRoutines } from "./routines-store";
import { runRoutineForEvents } from "./runner";
import type { Routine } from "./schedule";
import { DESKTOP_TRIGGERS, fingerprint, matchesEmail, pageChange, parseFeed, POLL_MS, type Trigger, type TriggerEvent, type TriggerState } from "./triggers";

type Check = { state: TriggerState; events: TriggerEvent[] };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One check of one trigger: what's new since `state`, and the state to keep. */
export async function checkTrigger(trigger: Trigger, state: TriggerState): Promise<Check> {
  const { useProxy } = useStore.getState().settings;
  switch (trigger.type) {
    case "email": {
      const account = useApps.getState().accounts.find((a) => a.id === trigger.account);
      if (!account) throw new Error("The email account isn't connected any more.");
      const own = account.provider === "imap" ? (account.imap?.address ?? "") : account.label;
      const r = await appsCall<{ cursor: string; messages: { id: string; from: string; to: string[]; subject: string; date: string; snippet?: string }[] }>("mail.arrivals", { account: trigger.account, cursor: state.cursor });
      const events = r.messages
        .filter((m) => matchesEmail(trigger, m, own))
        .map((m) => ({
          title: `Email from ${m.from}: ${m.subject || "(no subject)"}`,
          details: `From: ${m.from}\nTo: ${m.to.join(", ")}\nSubject: ${m.subject}\nDate: ${m.date}\nEmail id (for email_read): ${m.id}${m.snippet ? `\n\n${clip(m.snippet, 600)}` : ""}`,
          source: `an email from ${m.from}`,
        }));
      return { state: { ...state, cursor: r.cursor }, events };
    }
    case "slack": {
      // First check: start from now.
      if (!state.cursor) return { state: { ...state, cursor: (Date.now() / 1000).toFixed(6) }, events: [] };
      const r = await appsCall<{ messages: { ts: string; from: string; text: string; bot?: boolean }[] }>("slack.read", { account: trigger.account, channel: trigger.channel, oldest: state.cursor, limit: 50 });
      const fresh = r.messages.filter((m) => Number(m.ts) > Number(state.cursor) && !m.bot);
      const cursor = fresh.reduce((max, m) => (Number(m.ts) > Number(max) ? m.ts : max), state.cursor);
      const events = fresh
        .filter((m) => !trigger.contains || m.text.toLowerCase().includes(trigger.contains.toLowerCase()))
        .reverse()
        .map((m) => ({ title: `${m.from} in ${trigger.channel}`, details: `${m.text}\n(Slack message ts ${m.ts})`, source: `a Slack message from ${m.from}` }));
      return { state: { ...state, cursor }, events };
    }
    case "x": {
      if (trigger.what === "messages") {
        const r = await appsCall<{ newest: string; messages: { id: string; from: string; mine: boolean; text: string }[] }>("x.messages", { account: trigger.account, since: state.cursor });
        if (!state.cursor) return { state: { ...state, cursor: r.newest }, events: [] };
        return { state: { ...state, cursor: r.newest || state.cursor }, events: r.messages.filter((m) => !m.mine).map((m) => ({ title: `Message on X from ${m.from}`, details: m.text, source: `a message on X from ${m.from}` })) };
      }
      const r = await appsCall<{ newest: string; posts: { id: string; from: string; text: string; link: string }[] }>("x.mentions", { account: trigger.account, since: state.cursor });
      if (!state.cursor) return { state: { ...state, cursor: r.newest }, events: [] };
      return { state: { ...state, cursor: r.newest || state.cursor }, events: r.posts.map((p) => ({ title: `${p.from} mentioned you on X`, details: `${p.text}\n${p.link} (post id ${p.id})`, source: `a post on X by ${p.from}` })) };
    }
    case "feed": {
      const items = parseFeed(await fetchPublicText(trigger.url, useProxy));
      if (!items.length) throw new Error("That address isn't an RSS or Atom feed.");
      const ids = items.map((i) => i.id);
      if (!state.seen) return { state: { ...state, seen: ids.slice(0, 300) }, events: [] };
      const seen = new Set(state.seen);
      const fresh = items.filter((i) => !seen.has(i.id)).slice(0, 10);
      return {
        state: { ...state, seen: [...fresh.map((i) => i.id), ...state.seen].slice(0, 300) },
        events: fresh.reverse().map((i) => ({ title: i.title || "New item", details: `${i.link}${i.date ? ` (${i.date})` : ""}\n${clip(i.summary, 600)}`, source: `the feed ${new URL(trigger.url).host}` })),
      };
    }
    case "page": {
      const text = await readPage(trigger.url, useProxy, undefined, true);
      if (!text) throw new Error("Couldn't read that page.");
      const hash = await fingerprint(text);
      const next = { ...state, hash, text: text.slice(0, 20_000) };
      if (!state.hash || hash === state.hash) return { state: next, events: [] };
      const changed = pageChange(state.text ?? "", text);
      return { state: next, events: changed ? [{ title: `${new URL(trigger.url).host} changed`, details: `${trigger.url}\nNew on the page:\n${changed}`, source: `the page ${new URL(trigger.url).host}` }] : [] };
    }
    default:
      return { state, events: [] };
  }
}

const checking = new Set<string>();

/** Checks every event routine that's due. */
export async function pollTriggers(now = Date.now()): Promise<void> {
  await loadRoutines();
  if (!useStore.getState().hydrated) return;
  const desktop = isDesktop();
  for (const routine of useRoutines.getState().routines) {
    const t = routine.trigger;
    if (!routine.enabled || !t || routine.where === "server" || !POLL_MS[t.type] || checking.has(routine.id)) continue;
    if (DESKTOP_TRIGGERS.has(t.type) && !desktop) continue;
    if (now - (routine.triggerState?.checkedAt ?? 0) < POLL_MS[t.type]) continue;
    checking.add(routine.id);
    void (async () => {
      try {
        const { state, events } = await checkTrigger(t, routine.triggerState ?? {});
        await patchRoutine(routine.id, (r) => ({ ...r, triggerState: { ...r.triggerState, ...state, checkedAt: now, error: undefined } }));
        if (events.length) await runRoutineForEvents(routine.id, events);
      } catch (error) {
        await patchRoutine(routine.id, (r) => ({ ...r, triggerState: { ...r.triggerState, checkedAt: now, error: (error as Error).message.slice(0, 200) } }));
      } finally {
        checking.delete(routine.id);
      }
    })();
  }
}

/** Tells the desktop app which webhooks and folders to watch. */
async function syncDesktop(routines: Routine[]) {
  if (!isDesktop()) return;
  const on = routines.filter((r) => r.enabled && r.trigger && r.where !== "server");
  const webhooks = on.flatMap((r) => (r.trigger?.type === "webhook" ? [{ routineId: r.id, token: r.trigger.token }] : []));
  const folders = on.flatMap((r) => (r.trigger?.type === "folder" ? [{ routineId: r.id, path: r.trigger.path }] : []));
  try {
    await desktopInvoke("adt:triggers:set", { webhooks, folders });
  } catch {
    // Older desktop build.
  }
}

/** Events pushed by the desktop app (a webhook call, files changing). */
function onDesktopEvent(payload: { routineId?: string; kind?: string; body?: string; contentType?: string; path?: string; files?: string[] }) {
  const routine = useRoutines.getState().routines.find((r) => r.id === payload?.routineId);
  if (!routine?.enabled || !routine.trigger) return;
  if (payload.kind === "webhook" && routine.trigger.type === "webhook") {
    void runRoutineForEvents(routine.id, [{ title: "The webhook was called", details: `Content-Type: ${payload.contentType ?? "?"}\n\n${clip(String(payload.body ?? ""), 8000)}`, source: "a webhook call" }]);
  }
  if (payload.kind === "folder" && routine.trigger.type === "folder") {
    const files = (payload.files ?? []).slice(0, 50);
    void runRoutineForEvents(routine.id, [{ title: `${files.length} file${files.length === 1 ? "" : "s"} changed in ${payload.path}`, details: files.map((f) => `- ${f}`).join("\n"), source: `files in ${payload.path}` }]);
  }
}

let started = false;
export function startTriggers() {
  if (started || typeof window === "undefined") return;
  started = true;
  void refreshApps();
  setInterval(() => void pollTriggers(), 60_000);
  setTimeout(() => void pollTriggers(), 5_000);
  desktopOn("adt:triggers:event", onDesktopEvent);
  let last = "";
  const sync = () => {
    const routines = useRoutines.getState().routines;
    const key = JSON.stringify(routines.map((r) => [r.id, r.enabled, r.trigger?.type === "webhook" || r.trigger?.type === "folder" ? r.trigger : null]));
    if (key === last) return;
    last = key;
    void syncDesktop(routines);
  };
  useRoutines.subscribe(sync);
  void loadRoutines().then(sync);
}
