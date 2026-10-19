// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIRING_FRAME, readFiring } from "../../lib/agent/vendor/copilotkit/routine-firing";
import { getTool, type ToolContext } from "../../lib/agent/tools";
import { useStore, defaultSettings } from "../../lib/store";
import type { Bot, Message } from "../../lib/types";
import { checkDelegation, delegate, MAX_DELEGATION_DEPTH, normaliseReport, registerChain, resolveBot } from "./delegation";
import { useRoutines } from "./routines-store";
import { firingMessage, markNoUpdate, tick } from "./runner";
import {
  describeSchedule,
  finishRun,
  isQuietReply,
  MAX_CONSECUTIVE_FAILURES,
  MISSED_GRACE_MS,
  nextRunAfter,
  planDue,
  type Routine,
  type Schedule,
  stripQuietMarker,
  validateSchedule,
} from "./schedule";
import { parseDays, scheduleFromArgs } from "./tools";

vi.mock("idb-keyval", () => {
  const data = new Map<string, unknown>();
  return {
    createStore: () => ({}),
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => void data.set(key, value),
    del: async (key: string) => void data.delete(key),
  };
});
vi.mock("../../lib/transport",() => ({ providerFetch: vi.fn(), detectEnv: async () => ({ platform: "web", proxy: false }) }));
const send = vi.hoisted(() => vi.fn());
vi.mock("../../lib/chat", () => ({ sendInBackground: send }));
const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./notify", () => ({ notify, notificationsSupported: () => false }));

const Z = (iso: string) => Date.parse(iso);
const NY = "America/New_York";

const bot = (id: string, name: string, nickname = ""): Bot => ({
  id, name, nickname, avatar: "*", description: `${name} bot`, systemPrompt: "", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0,
});
const adt = bot("a", "ADT", "Jarvis");
const researcher = bot("r", "Researcher", "Scout");
const writer = bot("w", "Writer");

const routine = (patch: Partial<Routine> = {}): Routine => ({
  id: crypto.randomUUID(), botId: "a", name: "News", instruction: "Summarise AI news",
  schedule: { type: "daily", time: "08:00", timezone: NY }, enabled: true, missedRunPolicy: "run-once",
  nextRun: Z("2026-10-19T12:00:00Z"), consecutiveFailures: 0, history: [], createdAt: 0, ...patch,
});

describe("next run", () => {
  it("daily, in the routine's timezone", () => {
    const s: Schedule = { type: "daily", time: "08:00", timezone: NY };
    expect(nextRunAfter(s, Z("2026-10-19T11:00:00Z"))).toBe(Z("2026-10-19T12:00:00Z"));
    expect(nextRunAfter(s, Z("2026-10-19T12:00:00Z"))).toBe(Z("2026-10-20T12:00:00Z"));
    expect(nextRunAfter({ ...s, timezone: "Asia/Tokyo" }, Z("2026-10-19T00:00:00Z"))).toBe(Z("2026-10-19T23:00:00Z"));
  });

  it("weekly skips the weekend", () => {
    const s: Schedule = { type: "weekly", time: "08:00", days: [1, 2, 3, 4, 5], timezone: NY };
    // Friday 09:00 EDT → Monday 08:00 EDT
    expect(nextRunAfter(s, Z("2026-10-23T13:00:00Z"))).toBe(Z("2026-10-26T12:00:00Z"));
    expect(nextRunAfter({ ...s, days: [0] }, Z("2026-10-23T13:00:00Z"))).toBe(Z("2026-10-25T12:00:00Z"));
  });

  it("once: the moment itself, or nothing when it has passed", () => {
    const s: Schedule = { type: "once", date: "2026-10-20", time: "09:30", timezone: "Europe/London" };
    expect(nextRunAfter(s, Z("2026-10-18T00:00:00Z"))).toBe(Z("2026-10-20T08:30:00Z"));
    expect(nextRunAfter(s, Z("2026-10-21T00:00:00Z"))).toBeNull();
  });

  it("interval counts from its anchor", () => {
    const anchor = Z("2026-10-18T10:00:00Z");
    const s: Schedule = { type: "interval", everyMinutes: 30, anchor, timezone: "UTC" };
    expect(nextRunAfter(s, anchor)).toBe(anchor + 30 * 60_000);
    expect(nextRunAfter(s, anchor + 95 * 60_000)).toBe(anchor + 120 * 60_000);
  });

  it("cron in a timezone, with day-of-month/weekday rules", () => {
    const s: Schedule = { type: "cron", cron: "0 8 * * 1-5", timezone: "Asia/Tokyo" };
    // Saturday in Tokyo → Monday 08:00 JST (Sunday 23:00 UTC)
    expect(nextRunAfter(s, Z("2026-10-24T00:00:00Z"))).toBe(Z("2026-10-25T23:00:00Z"));
    const monthly: Schedule = { type: "cron", cron: "30 9 1 * *", timezone: "UTC" };
    expect(nextRunAfter(monthly, Z("2026-10-18T00:00:00Z"))).toBe(Z("2026-11-01T09:30:00Z"));
    expect(nextRunAfter({ type: "cron", cron: "0 12 29 2 *", timezone: "UTC" }, Z("2026-10-18T00:00:00Z"))).toBe(Z("2028-02-29T12:00:00Z"));
  });

  it("handles daylight saving: spring forward, gaps and the repeated hour", () => {
    const eight: Schedule = { type: "daily", time: "08:00", timezone: NY };
    expect(nextRunAfter(eight, Z("2026-03-07T00:00:00Z"))).toBe(Z("2026-03-07T13:00:00Z")); // EST
    expect(nextRunAfter(eight, Z("2026-03-07T14:00:00Z"))).toBe(Z("2026-03-08T12:00:00Z")); // EDT
    // 02:30 doesn't exist on 8 March: runs at 03:30 EDT instead of being skipped.
    expect(nextRunAfter({ ...eight, time: "02:30" }, Z("2026-03-08T05:00:00Z"))).toBe(Z("2026-03-08T07:30:00Z"));
    // 01:30 happens twice on 1 November: run only the first time.
    const half = { ...eight, time: "01:30" };
    expect(nextRunAfter(half, Z("2026-11-01T04:00:00Z"))).toBe(Z("2026-11-01T05:30:00Z"));
    expect(nextRunAfter(half, Z("2026-11-01T05:30:00Z"))).toBe(Z("2026-11-02T06:30:00Z"));
    // Cron across the end of British Summer Time.
    const london: Schedule = { type: "cron", cron: "0 9 * * *", timezone: "Europe/London" };
    expect(nextRunAfter(london, Z("2026-10-24T07:30:00Z"))).toBe(Z("2026-10-24T08:00:00Z"));
    expect(nextRunAfter(london, Z("2026-10-24T08:30:00Z"))).toBe(Z("2026-10-25T09:00:00Z"));
  });
});

describe("schedule validation", () => {
  it("enforces the 15-minute floor", () => {
    expect(validateSchedule({ type: "interval", everyMinutes: 10, anchor: 0, timezone: "UTC" })).toMatch(/15 minutes/);
    expect(validateSchedule({ type: "interval", everyMinutes: 15, anchor: 0, timezone: "UTC" })).toBeNull();
    expect(validateSchedule({ type: "cron", cron: "*/5 * * * *", timezone: "UTC" })).toMatch(/15 minutes/);
    expect(validateSchedule({ type: "cron", cron: "0,10 9 * * *", timezone: "UTC" })).toMatch(/15 minutes/);
    // 23:55 and 00:00 the next day are only 5 minutes apart.
    expect(validateSchedule({ type: "cron", cron: "0,55 0,23 * * *", timezone: "UTC" })).toMatch(/15 minutes/);
    expect(validateSchedule({ type: "cron", cron: "*/15 * * * *", timezone: "UTC" })).toBeNull();
  });

  it("wants five cron fields, a real timezone and well-formed times", () => {
    expect(validateSchedule({ type: "cron", cron: "0 8 * *", timezone: "UTC" })).toMatch(/five fields/);
    expect(validateSchedule({ type: "cron", cron: "0 8 * * * *", timezone: "UTC" })).toMatch(/five fields/);
    expect(validateSchedule({ type: "cron", cron: "0 25 * * *", timezone: "UTC" })).toMatch(/could not be read/);
    expect(validateSchedule({ type: "daily", time: "08:00", timezone: "Mars/Olympus" })).toMatch(/timezone/);
    expect(validateSchedule({ type: "daily", time: "8am", timezone: "UTC" })).toMatch(/HH:MM/);
    expect(validateSchedule({ type: "once", date: "2026-02-30", time: "08:00", timezone: "UTC" })).toMatch(/YYYY-MM-DD/);
    expect(validateSchedule({ type: "weekly", time: "08:00", days: [], timezone: "UTC" })).toMatch(/day/);
  });

  it("describes schedules in words", () => {
    expect(describeSchedule({ type: "weekly", time: "08:00", days: [1, 2, 3, 4, 5], timezone: NY }, false)).toBe("Every weekday at 08:00");
    expect(describeSchedule({ type: "cron", cron: "0 8 * * 1-5", timezone: NY }, true)).toBe(`Every weekday at 08:00 (${NY})`);
    expect(describeSchedule({ type: "interval", everyMinutes: 120, anchor: 0, timezone: "UTC" }, false)).toBe("Every 2 hours");
  });
});

describe("due runs and missed-run policy", () => {
  const due = Z("2026-10-19T12:00:00Z");
  it("runs on time and moves to the next occurrence", () => {
    const plan = planDue(routine(), due + 20_000);
    expect(plan).toEqual({ action: "run", scheduledFor: due, next: Z("2026-10-20T12:00:00Z"), late: false });
    expect(planDue(routine(), due - 1)).toEqual({ action: "none" });
    expect(planDue(routine({ enabled: false }), due + 1)).toEqual({ action: "none" });
  });

  it("skips or runs once when the app was closed", () => {
    const later = due + MISSED_GRACE_MS + 3 * 86400_000;
    expect(planDue(routine({ missedRunPolicy: "skip" }), later)).toMatchObject({ action: "skip", scheduledFor: due });
    const once = planDue(routine({ missedRunPolicy: "run-once" }), later);
    expect(once).toMatchObject({ action: "run", late: true });
    // Only one catch-up run, then back on schedule after now.
    expect((once as { next: number }).next).toBeGreaterThan(later);
  });

  it("doesn't run an occurrence twice (crash between recording the run and advancing)", () => {
    const r = routine({ history: [{ id: "x", scheduledFor: due, startedAt: due, status: "interrupted", trigger: "schedule" }] });
    expect(planDue(r, due + 1000)).toMatchObject({ action: "advance" });
  });
});

describe("failures", () => {
  it("switches a routine off after 10 failures in a row, and resets on success", () => {
    let r = routine();
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      r = finishRun(r, { id: `e${i}`, startedAt: i, status: "error", trigger: "schedule" });
    }
    expect(r.enabled).toBe(true);
    expect(r.consecutiveFailures).toBe(9);
    const recovered = finishRun(r, { id: "ok", startedAt: 99, status: "quiet", trigger: "schedule" });
    expect(recovered.consecutiveFailures).toBe(0);
    r = finishRun(r, { id: "e9", startedAt: 100, status: "error", trigger: "schedule" });
    expect(r.enabled).toBe(false);
    expect(r.disabledReason).toMatch(/10 failed runs/);
    expect(r.history).toHaveLength(10);
  });

  it("keeps only the last 20 runs", () => {
    let r = routine();
    for (let i = 0; i < 25; i++) r = finishRun(r, { id: `r${i}`, startedAt: i, status: "ok", trigger: "manual" });
    expect(r.history).toHaveLength(20);
    expect(r.history[0].id).toBe("r24");
  });
});

describe("firing frame and quiet runs", () => {
  it("frames the instruction so the model does the work", () => {
    const text = firingMessage("Every weekday, summarise the AI news");
    expect(text.startsWith(FIRING_FRAME.join("\n"))).toBe(true);
    expect(readFiring(text)).toMatch(/^Every weekday, summarise the AI news\n\n\(.*\[\[no-update\]\]/s);
  });

  it("recognises the no-update marker", () => {
    expect(isQuietReply("[[no-update]] Nothing changed since yesterday.")).toBe(true);
    expect(isQuietReply("Nothing new. [[ No_Update ]]")).toBe(true);
    expect(isQuietReply("Here are 5 stories")).toBe(false);
    expect(stripQuietMarker("[[no-update]] Nothing changed.")).toBe("Nothing changed.");
  });

  it("routine_no_update only works inside a routine run", () => {
    expect(markNoUpdate("not-a-routine-chat")).toBe(false);
  });
});

const reply = (content: string, extra: Partial<Message> = {}): Message => ({ id: crypto.randomUUID(), role: "assistant", content, createdAt: 0, ...extra });

describe("scheduler", () => {
  beforeEach(() => {
    send.mockReset();
    notify.mockClear();
    useStore.setState({ hydrated: true, bots: [adt, researcher, writer], conversations: {} });
    useRoutines.setState({ routines: [], loaded: true, running: [] });
  });

  it("runs each due routine once, records it before advancing, and notifies", async () => {
    const now = Z("2026-10-19T12:00:20Z");
    const r = routine();
    useRoutines.setState({ routines: [r] });
    send.mockResolvedValueOnce(reply("Top story: models got better."));
    const runs = await tick(now);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "ok", scheduledFor: r.nextRun, trigger: "schedule" });
    const [conversationId, text] = send.mock.calls[0];
    expect(readFiring(text)).toContain("Summarise AI news");
    expect(useStore.getState().conversations[conversationId].title).toBe("Routine: News");
    const saved = useRoutines.getState().routines[0];
    expect(saved.nextRun).toBe(Z("2026-10-20T12:00:00Z"));
    expect(saved.history[0]).toMatchObject({ status: "ok", conversationId });
    expect(notify).toHaveBeenCalledWith("News", expect.stringContaining("Top story"), conversationId);
    // Next tick, same minute: nothing to do.
    expect(await tick(now + 30_000)).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("quiet runs don't notify; failures count up", async () => {
    const now = Z("2026-10-19T12:00:20Z");
    useRoutines.setState({ routines: [routine({ id: "quiet" }), routine({ id: "broken", consecutiveFailures: 9 })] });
    send.mockImplementation(async (conversationId: string) => {
      const owner = useRoutines.getState().routines.find((x) => x.conversationId === conversationId);
      return owner?.id === "quiet" ? reply("[[no-update]] Nothing new today.") : reply("", { error: "Model unavailable" });
    });
    await tick(now);
    const [quiet, broken] = useRoutines.getState().routines;
    expect(quiet.history[0].status).toBe("quiet");
    expect(broken.history[0]).toMatchObject({ status: "error", summary: "Model unavailable" });
    expect(broken.enabled).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/failed: News/);
  });

  it("skips a missed run when the policy says so", async () => {
    const r = routine({ missedRunPolicy: "skip" });
    useRoutines.setState({ routines: [r] });
    await tick(r.nextRun! + 2 * 3600_000);
    expect(send).not.toHaveBeenCalled();
    const saved = useRoutines.getState().routines[0];
    expect(saved.history[0].status).toBe("skipped");
    expect(saved.nextRun).toBe(Z("2026-10-20T12:00:00Z"));
  });
});

describe("delegation", () => {
  const bots = [adt, researcher, writer];

  it("finds bots by name or nickname", () => {
    expect(resolveBot(bots, "scout")).toBe(researcher);
    expect(resolveBot(bots, "@Jarvis")).toBe(adt);
    expect(resolveBot(bots, "writ")).toBe(writer);
    expect(resolveBot(bots, "nobody")).toMatchObject({ error: expect.stringContaining("no bot") });
  });

  it("refuses self-delegation, handing work back, and going too deep", () => {
    expect(checkDelegation(adt, adt, "c0")).toMatchObject({ ok: false, reason: expect.stringContaining("yourself") });
    registerChain("c1", { depth: 1, bots: ["a", "r"] });
    expect(checkDelegation(researcher, adt, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("back") });
    expect(checkDelegation(researcher, writer, "c1")).toMatchObject({ ok: true, chain: { depth: 2, bots: ["a", "r", "w"] } });
    registerChain("c2", { depth: MAX_DELEGATION_DEPTH, bots: ["a", "r", "w"] });
    const fourth = bot("x", "Extra");
    expect(checkDelegation(writer, fourth, "c2")).toMatchObject({ ok: false, reason: expect.stringContaining("deep") });
  });

  it("runs the other bot in a linked chat and returns a Status/Result report", async () => {
    useStore.setState({ bots, conversations: {} });
    send.mockReset();
    send.mockResolvedValueOnce(reply("Found three papers on X."));
    const result = await delegate({ caller: adt, target: researcher, task: "Find papers on X", conversationId: "user-chat", signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.report).toBe("Status: done\nResult: Found three papers on X.\nEvidence: none");
    const [chatId, prompt] = send.mock.calls[0];
    expect(chatId).toBe(result.conversationId);
    expect(useStore.getState().conversations[chatId].botId).toBe("r");
    expect(prompt).toContain("Task from ADT");
    expect(prompt).toContain("Status: done | partial | blocked");
    // Inside that chat, the researcher can't hand the work back to ADT.
    await expect(delegate({ caller: researcher, target: adt, task: "do it", conversationId: chatId, signal: new AbortController().signal })).rejects.toThrow(/back/);
  });

  it("reports failures as blocked", async () => {
    send.mockReset();
    send.mockResolvedValueOnce(reply("", { error: "No provider" }));
    const result = await delegate({ caller: adt, target: writer, task: "Write", conversationId: "u2", signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/^Status: blocked\nResult: No answer\.\nEvidence: none\nUnblock: No provider$/);
    expect(normaliseReport("Status: partial\nResult: half")).toBe("Status: partial\nResult: half");
  });

  it("times out", async () => {
    send.mockReset();
    send.mockImplementationOnce((_id: string, _text: string, { signal }: { signal: AbortSignal }) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(reply("partial work")))),
    );
    const result = await delegate({ caller: adt, target: writer, task: "Slow", conversationId: "u3", signal: new AbortController().signal, timeoutMs: 50 });
    expect(result.report).toMatch(/Status: partial[\s\S]*ran out of time/);
  });
});

describe("tool arguments", () => {
  const ctx = (b: Bot = adt): ToolContext => ({
    bot: b, conversationId: "chat", settings: defaultSettings, providers: [], platform: "web", signal: new AbortController().signal, progress: () => undefined,
  });

  beforeEach(() => {
    useStore.setState({ hydrated: true, bots: [adt, researcher, writer], conversations: {} });
    useRoutines.setState({ routines: [], loaded: true, running: [] });
  });

  it("parses days and schedules", () => {
    expect(parseDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(["Mon", "wednesday", 0])).toEqual([0, 1, 3]);
    expect(parseDays("[\"mon\",\"tue\"]")).toEqual([1, 2]);
    expect(parseDays(["funday"])).toBeNull();
    expect(scheduleFromArgs({ schedule_type: "daily", cron: "0 9 * * *" })).toMatchObject({ type: "daily", time: "09:00" });
    expect(scheduleFromArgs({ schedule_type: "daily", cron: "30 8 * * 1-5" })).toMatchObject({ type: "cron", cron: "30 8 * * 1-5" });
    expect(scheduleFromArgs({ schedule_type: "weekly", time: "08:00" })).toMatchObject({ error: expect.stringContaining("days") });
    expect(scheduleFromArgs({ schedule_type: "hourly" })).toMatchObject({ error: expect.stringContaining("schedule_type") });
    expect(scheduleFromArgs({ schedule_type: "daily", time: "07:15", timezone: NY })).toEqual({ type: "daily", time: "07:15", timezone: NY });
  });

  it("create_routine validates and creates; update/delete find it by name", async () => {
    const create = getTool("create_routine")!;
    expect(create.risk).toBe("write");
    await expect(create.run({ name: "Fast", instruction: "x", schedule_type: "interval", every_minutes: 5 }, ctx())).rejects.toThrow(/15 minutes/);
    await expect(create.run({ name: "Bad", instruction: "x", schedule_type: "cron", cron: "0 8 * *" }, ctx())).rejects.toThrow(/five fields/);
    await expect(create.run({ name: "", instruction: "", schedule_type: "daily", time: "08:00" }, ctx())).rejects.toThrow(/name|instruction/);
    // Small models leave out the name or call the bot "you": take the instruction's first words and the caller.
    expect(String(await create.run({ instruction: "Check the server status now", schedule_type: "daily", time: "08:00", bot: "you" }, ctx()))).toContain("Check the server status now");
    await useRoutines.getState().routines.reduce((p, r) => p.then(() => getTool("delete_routine")!.run({ routine: r.id }, ctx())), Promise.resolve<unknown>(undefined));
    const out = await create.run(
      { name: "Morning news", instruction: "Summarise AI news and save it to a file", schedule_type: "weekly", days: "weekdays", time: "08:00", timezone: NY, bot: "Scout" },
      ctx(),
    );
    expect(String(out)).toContain("Every weekday at 08:00");
    const [created] = useRoutines.getState().routines;
    expect(created).toMatchObject({ botId: "r", enabled: true, missedRunPolicy: "run-once" });

    await getTool("update_routine")!.run({ routine: "morning NEWS", enabled: false }, ctx());
    expect(useRoutines.getState().routines[0].enabled).toBe(false);
    await expect(getTool("update_routine")!.run({ routine: "nope" }, ctx())).rejects.toThrow(/No routine/);
    expect(getTool("delete_routine")!.risk).toBe("destructive");
    await getTool("delete_routine")!.run({ routine: created.id }, ctx());
    expect(useRoutines.getState().routines).toHaveLength(0);
  });

  it("ask_bot checks its arguments and guards", async () => {
    const ask = getTool("ask_bot")!;
    expect(ask.risk).toBe("read");
    await expect(ask.run({ bot: "Nobody", task: "x" }, ctx())).rejects.toThrow(/no bot/);
    await expect(ask.run({ bot: "Scout", task: "  " }, ctx())).rejects.toThrow(/task/);
    await expect(ask.run({ bot: "ADT", task: "x" }, ctx())).rejects.toThrow(/yourself/);
    const list = String(await getTool("list_bots")!.run({}, ctx()));
    expect(list).toContain('Researcher ("Scout")');
    expect(list).toContain("ADT (\"Jarvis\") [you]");
  });
});
