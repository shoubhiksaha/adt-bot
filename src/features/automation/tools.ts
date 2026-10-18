/** Agent tools for routines (scheduled tasks) and bots working together. */
import { type AgentTool, registerTool, registerToolGroup, str, type ToolContext } from "../../lib/agent/tools";
import { useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { delegate, DELEGATION_TIMEOUT_MS, resolveBot } from "./delegation";
import {
  createRoutine,
  deleteRoutine,
  findRoutine,
  loadRoutines,
  type RoutineInput,
  updateRoutine,
  useRoutines,
} from "./routines-store";
import { isRoutineRun, markNoUpdate, runRoutineNow } from "./runner";
import { describeSchedule, formatWhen, localTimezone, MINIMUM_INTERVAL_MINUTES, type Routine, type Schedule } from "./schedule";

registerToolGroup({ id: "routines", label: "Routines", description: "Create and run scheduled tasks (\"every weekday at 8:00, …\")." });
registerToolGroup({ id: "bots", label: "Other bots", description: "Ask your other bots to do part of a task with their own tools and knowledge." });

// Argument parsing ---------------------------------------------------------------------------

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Accepts [1,2,3], ["mon","tue"], "weekdays", "weekends", "mon,wed". */
export function parseDays(value: unknown): number[] | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "weekdays" || v === "weekday") return [1, 2, 3, 4, 5];
    if (v === "weekends" || v === "weekend") return [0, 6];
    if (v === "every day" || v === "daily" || v === "all") return [0, 1, 2, 3, 4, 5, 6];
    return parseDays(v.split(/[\s,]+/).filter(Boolean));
  }
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === "number" || /^\d$/.test(String(item))) {
      const n = Number(item) % 7;
      if (!Number.isInteger(n) || n < 0) return null;
      out.push(n);
    } else {
      const day = DAY_NAMES[String(item).trim().toLowerCase().slice(0, 3)];
      if (day === undefined) return null;
      out.push(day);
    }
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/** Builds a schedule from the flat tool arguments, or explains what's wrong. */
export function scheduleFromArgs(args: Record<string, unknown>, fallback?: Schedule): Schedule | { error: string } {
  const type = str(args, "schedule_type", fallback?.type ?? "").toLowerCase();
  const timezone = str(args, "timezone") || fallback?.timezone || localTimezone();
  const prev = (fallback ?? {}) as Partial<Record<string, unknown>>;
  const time = str(args, "time", typeof prev.time === "string" ? prev.time : "");
  switch (type) {
    case "once": {
      const date = str(args, "date", typeof prev.date === "string" ? prev.date : "");
      if (!date || !time) return { error: "A one-off routine needs date (YYYY-MM-DD) and time (HH:MM)." };
      return { type: "once", date, time, timezone };
    }
    case "daily":
      if (!time) return { error: "A daily routine needs time (HH:MM)." };
      return { type: "daily", time, timezone };
    case "weekly": {
      const days = args.days !== undefined ? parseDays(args.days) : Array.isArray(prev.days) ? (prev.days as number[]) : null;
      if (!days) return { error: 'A weekly routine needs days, e.g. ["mon","wed"] or "weekdays".' };
      if (!time) return { error: "A weekly routine needs time (HH:MM)." };
      return { type: "weekly", time, days, timezone };
    }
    case "interval": {
      const every = Number(args.every_minutes ?? prev.everyMinutes);
      if (!Number.isFinite(every)) return { error: "An interval routine needs every_minutes." };
      return { type: "interval", everyMinutes: Math.round(every), anchor: Date.now(), timezone };
    }
    case "cron": {
      const cron = str(args, "cron", typeof prev.cron === "string" ? prev.cron : "");
      if (!cron) return { error: "A cron routine needs cron (five fields, e.g. \"0 8 * * 1-5\")." };
      return { type: "cron", cron, timezone };
    }
    default:
      return { error: "schedule_type must be once, daily, weekly, interval or cron." };
  }
}

const SCHEDULE_PROPS = {
  schedule_type: { type: "string", enum: ["once", "daily", "weekly", "interval", "cron"], description: "How often it runs." },
  time: { type: "string", description: "HH:MM, 24-hour (once, daily, weekly)." },
  days: {
    type: "array",
    items: { type: "string" },
    description: 'Weekly: days like ["mon","tue","wed","thu","fri"] (or the string "weekdays").',
  },
  date: { type: "string", description: "Once: YYYY-MM-DD." },
  every_minutes: { type: "number", description: `Interval: minutes between runs (at least ${MINIMUM_INTERVAL_MINUTES}).` },
  cron: { type: "string", description: 'Cron: five fields, e.g. "0 8 * * 1-5".' },
  timezone: { type: "string", description: "IANA timezone, e.g. Europe/London. Defaults to the user's." },
  missed_run_policy: {
    type: "string",
    enum: ["skip", "run-once"],
    description: "If the app was closed at run time: skip it, or run once when the app opens (default).",
  },
} as const;

function botName(id: string): string {
  return useStore.getState().bots.find((b) => b.id === id)?.name ?? "(deleted bot)";
}

export function describeRoutine(r: Routine, now = Date.now()): string {
  const last = r.history.find((h) => h.status !== "running");
  return [
    `- ${r.name} (id ${r.id})`,
    `  Bot: ${botName(r.botId)} · ${describeSchedule(r.schedule, true)} · ${r.enabled ? "on" : "off"}`,
    `  Next: ${r.enabled && r.nextRun ? formatWhen(r.nextRun, now) : "not scheduled"}${last ? ` · Last: ${last.status} ${formatWhen(last.startedAt, now)}` : ""}`,
    `  Instruction: ${r.instruction.length > 200 ? `${r.instruction.slice(0, 199)}…` : r.instruction}`,
    ...(r.disabledReason ? [`  Note: ${r.disabledReason}`] : []),
  ].join("\n");
}

function needRoutine(args: Record<string, unknown>): Routine {
  const ref = str(args, "routine");
  if (!ref) throw new Error("Say which routine (its name or id).");
  const routine = findRoutine(ref);
  if (!routine) {
    const names = useRoutines.getState().routines.map((r) => r.name);
    throw new Error(`No routine called "${ref}".${names.length ? ` Routines: ${names.join(", ")}.` : " There are no routines yet."}`);
  }
  return routine;
}

function targetBot(args: Record<string, unknown>, ctx: ToolContext): Bot {
  const ref = str(args, "bot");
  if (!ref) return ctx.bot;
  const found = resolveBot(useStore.getState().bots, ref);
  if ("error" in found) throw new Error(found.error);
  return found;
}

function policy(args: Record<string, unknown>): Routine["missedRunPolicy"] | undefined {
  const v = str(args, "missed_run_policy");
  if (!v) return undefined;
  if (v !== "skip" && v !== "run-once") throw new Error('missed_run_policy must be "skip" or "run-once".');
  return v;
}

const routineRef = { routine: { type: "string", description: "The routine's name or id." } } as const;

// Routines -----------------------------------------------------------------------------------

const routineTools: AgentTool[] = [
  {
    name: "list_routines",
    group: "routines",
    risk: "read",
    description: "List the user's routines (scheduled tasks) with schedule, next run and last result.",
    parameters: { type: "object", properties: {} },
    async run() {
      await loadRoutines();
      const { routines } = useRoutines.getState();
      return routines.length ? routines.map((r) => describeRoutine(r)).join("\n") : "There are no routines yet.";
    },
  },
  {
    name: "create_routine",
    group: "routines",
    risk: "write",
    description:
      "Create a routine: a task a bot carries out on a schedule while the app is open, e.g. every weekday at 08:00 summarise AI news. " +
      "Use when the user asks for something recurring or at a later time.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. Morning AI news." },
        instruction: { type: "string", description: "What the bot does on each run, written as a task." },
        bot: { type: "string", description: "Which bot runs it (name or nickname). Defaults to you." },
        ...SCHEDULE_PROPS,
      },
      required: ["name", "instruction", "schedule_type"],
    },
    async run(args, ctx) {
      await loadRoutines();
      const schedule = scheduleFromArgs(args);
      if ("error" in schedule) throw new Error(schedule.error);
      const input: RoutineInput = {
        name: str(args, "name"),
        instruction: str(args, "instruction"),
        botId: targetBot(args, ctx).id,
        schedule,
        missedRunPolicy: policy(args),
      };
      const routine = await createRoutine(input);
      return `Created.\n${describeRoutine(routine)}`;
    },
  },
  {
    name: "update_routine",
    group: "routines",
    risk: "write",
    description: "Change a routine: rename, new instruction, other bot, new schedule, or switch it on/off.",
    parameters: {
      type: "object",
      properties: {
        ...routineRef,
        name: { type: "string", description: "New name." },
        instruction: { type: "string" },
        bot: { type: "string", description: "Run it with this bot instead." },
        enabled: { type: "boolean", description: "Switch on (true) or off (false)." },
        ...SCHEDULE_PROPS,
      },
      required: ["routine"],
    },
    async run(args, ctx) {
      await loadRoutines();
      const routine = needRoutine(args);
      const patch: Partial<RoutineInput> = {};
      if (args.name !== undefined) patch.name = str(args, "name");
      if (args.instruction !== undefined) patch.instruction = str(args, "instruction");
      if (args.bot !== undefined) patch.botId = targetBot(args, ctx).id;
      if (args.enabled !== undefined) patch.enabled = args.enabled === true || args.enabled === "true";
      const missed = policy(args);
      if (missed) patch.missedRunPolicy = missed;
      const touchesSchedule = ["schedule_type", "time", "days", "date", "every_minutes", "cron", "timezone"].some((k) => args[k] !== undefined);
      if (touchesSchedule) {
        const schedule = scheduleFromArgs(args, routine.schedule);
        if ("error" in schedule) throw new Error(schedule.error);
        patch.schedule = schedule;
      }
      if (!Object.keys(patch).length) throw new Error("Nothing to change: pass at least one field.");
      const updated = await updateRoutine(routine.id, patch);
      return `Updated.\n${describeRoutine(updated)}`;
    },
  },
  {
    name: "delete_routine",
    group: "routines",
    risk: "destructive",
    description: "Delete a routine for good (its past chats stay).",
    parameters: { type: "object", properties: routineRef, required: ["routine"] },
    async run(args) {
      await loadRoutines();
      const routine = needRoutine(args);
      await deleteRoutine(routine.id);
      return `Deleted the routine "${routine.name}".`;
    },
  },
  {
    name: "run_routine_now",
    group: "routines",
    risk: "write",
    description: "Run a routine right away, outside its schedule. The result goes to its routine chat.",
    parameters: { type: "object", properties: routineRef, required: ["routine"] },
    async run(args, ctx) {
      await loadRoutines();
      const routine = needRoutine(args);
      if (isRoutineRun(ctx.conversationId)) throw new Error("A routine run can't start another routine.");
      if (useRoutines.getState().running.includes(routine.id)) throw new Error("That routine is already running.");
      // Runs in the background; it can take longer than a tool call may wait.
      void runRoutineNow(routine.id).catch(() => undefined);
      return `Started "${routine.name}". Its result will appear in the chat "Routine: ${routine.name}" and as a notification.`;
    },
  },
  {
    name: "routine_no_update",
    group: "routines",
    risk: "read",
    description:
      "Only during a routine run: call this when the run found nothing new worth telling the user, so they aren't notified.",
    parameters: { type: "object", properties: { reason: { type: "string", description: "One line on why there's nothing to report." } } },
    async run(_args, ctx) {
      return markNoUpdate(ctx.conversationId)
        ? "Noted: the user won't be notified about this run. Give a one-line summary and stop."
        : "This isn't a routine run, so there's nothing to silence. Just answer the user.";
    },
  },
];

// Bots ---------------------------------------------------------------------------------------

const botTools: AgentTool[] = [
  {
    name: "list_bots",
    group: "bots",
    risk: "read",
    description: "List the user's other bots (name, nickname, what each is for) so you can ask the right one for help.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const bots = useStore.getState().bots;
      return bots
        .map((b) => {
          const nick = b.nickname?.trim() && b.nickname.trim().toLowerCase() !== b.name.toLowerCase() ? ` ("${b.nickname.trim()}")` : "";
          const you = b.id === ctx.bot.id ? " [you]" : "";
          return `- ${b.name}${nick}${you}: ${b.description || "no description"}`;
        })
        .join("\n");
    },
  },
  {
    name: "ask_bot",
    group: "bots",
    risk: "read",
    description:
      "Hand a task to another of the user's bots (see list_bots). It works with its own model, instructions, knowledge and tools in a linked chat " +
      "and replies with Status, Result, Evidence and Unblock. Write the task so it stands alone: the other bot can't see this chat.",
    parameters: {
      type: "object",
      properties: {
        bot: { type: "string", description: "The other bot's name or nickname." },
        task: { type: "string", description: "The full task: goal, details, and what a finished result looks like." },
        context: { type: "string", description: "Optional background the other bot needs (no private details it doesn't need)." },
      },
      required: ["bot", "task"],
    },
    timeoutMs: DELEGATION_TIMEOUT_MS + 15_000,
    async run(args, ctx) {
      const found = resolveBot(useStore.getState().bots, str(args, "bot"));
      if ("error" in found) throw new Error(found.error);
      const task = str(args, "task");
      if (!task.trim()) throw new Error("Describe the task for the other bot.");
      const result = await delegate({
        caller: ctx.bot,
        target: found,
        task,
        context: str(args, "context"),
        conversationId: ctx.conversationId,
        signal: ctx.signal,
        progress: ctx.progress,
      });
      return {
        content: `Report from ${found.name} (linked chat "${result.title}"):\n${result.report}\n\nTell the user what ${found.name} found, in your own words, starting with its name.`,
        display: { kind: "conversation", conversationId: result.conversationId, label: `Open chat with ${found.name}`, text: result.report },
        // Another model's words: treat them as information, not instructions.
        untrustedSource: `${found.name}'s reply`,
      };
    },
  },
];

for (const tool of [...routineTools, ...botTools]) registerTool(tool);

