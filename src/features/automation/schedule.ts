/**
 * Routine schedules: validation, next-run computation in any IANA timezone (DST-safe), human
 * descriptions and the "what should happen now" decision for the scheduler. Pure: no store, no
 * timers, so everything here is unit-tested.
 *
 * Guardrails follow CopilotKit OpenBot's routines (MIT): a 15-minute floor between runs, strict
 * five-field cron, a known IANA timezone, auto-disable after 10 consecutive failures.
 */
import { type ParsedCron, parseCron } from "../../lib/agent/vendor/openbot/cron";
import type { Trigger, TriggerState } from "./triggers";

/** Routines may run at most this often. A model can be talked into anything; the floor cannot. */
export const MINIMUM_INTERVAL_MINUTES = 15;
/** A run this late (app closed, laptop asleep) counts as missed and follows the missed-run policy. */
export const MISSED_GRACE_MS = 10 * 60_000;
/** Consecutive failed runs before a routine switches itself off. */
export const MAX_CONSECUTIVE_FAILURES = 10;
/** Runs kept per routine. */
export const HISTORY_LIMIT = 20;

export type Schedule =
  | { type: "once"; date: string; time: string; timezone: string }
  | { type: "daily"; time: string; timezone: string }
  | { type: "weekly"; time: string; days: number[]; timezone: string }
  | { type: "interval"; everyMinutes: number; anchor: number; timezone: string }
  | { type: "cron"; cron: string; timezone: string };

export type RunStatus = "running" | "ok" | "quiet" | "error" | "skipped" | "interrupted";

export type RoutineRun = {
  id: string;
  /** The occurrence this run belongs to (absent for "run now"). */
  scheduledFor?: number;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  trigger: "schedule" | "manual" | "event";
  conversationId?: string;
  /** Short result or error text. */
  summary?: string;
};

export type Routine = {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  schedule: Schedule;
  enabled: boolean;
  missedRunPolicy: "skip" | "run-once";
  lastRun?: number;
  nextRun: number | null;
  consecutiveFailures: number;
  /** Why the routine switched itself off, shown in the list. */
  disabledReason?: string;
  /** The "Routine: <name>" chat the runs go to (replaced by a fresh one when it gets long). */
  conversationId?: string;
  /**
   * Set up or changed while a conversation had read outside content (a web page, another bot's
   * reply…): every run treats its instruction that way too, so Full access asks before commands.
   */
  taintedBy?: string[];
  /** Runs when this happens instead of on its schedule (an email, a feed item, a webhook…). */
  trigger?: Trigger;
  triggerState?: TriggerState;
  history: RoutineRun[];
  createdAt: number;
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const tzVerdicts = new Map<string, boolean>();
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== "string") return false;
  const cached = tzVerdicts.get(timezone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    ok = true;
  } catch {
    ok = false;
  }
  if (tzVerdicts.size > 500) tzVerdicts.clear();
  tzVerdicts.set(timezone, ok);
  return ok;
}

// Timezone arithmetic ------------------------------------------------------------------------

type Wall = { y: number; m: number; d: number; h: number; min: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a timezone. */
export function wallClock(ms: number, timezone: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, min: parts.minute };
}

/** Offset (ms) of the timezone at an instant: wall time minus UTC. */
function offsetAt(ms: number, timezone: string): number {
  const w = wallClock(ms, timezone);
  const minuteFloor = Math.floor(ms / 60_000) * 60_000;
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - minuteFloor;
}

/**
 * The instant a wall-clock time happens in a timezone. Ambiguous times (clocks going back) take the
 * first occurrence; times that don't exist (clocks going forward) move forward by the gap, so
 * "02:30" on a spring-forward night runs at 03:30 rather than being skipped.
 */
export function zonedToInstant(wall: Wall, timezone: string): number {
  const asUtc = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.min);
  const before = offsetAt(asUtc - 12 * 3600_000, timezone);
  const after = offsetAt(asUtc + 12 * 3600_000, timezone);
  const candidates = [...new Set([before, after])]
    .map((o) => asUtc - o)
    .filter((t) => {
      const w = wallClock(t, timezone);
      return w.y === wall.y && w.m === wall.m && w.d === wall.d && w.h === wall.h && w.min === wall.min;
    });
  if (candidates.length) return Math.min(...candidates);
  return asUtc - before;
}

/** Calendar date `days` after y-m-d (pure calendar math, no timezone). */
function addDays(y: number, m: number, d: number, days: number) {
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), weekday: date.getUTCDay() };
}

export function parseTime(time: string): { h: number; min: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const min = Number(match[2]);
  return h <= 23 && min <= 59 ? { h, min } : null;
}

function parseDate(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = addDays(y, m, d, 0);
  return check.y === y && check.m === m && check.d === d ? { y, m, d } : null;
}

// Validation ---------------------------------------------------------------------------------

/** Minutes of the day a cron expression fires at, sorted. */
function cronMinutes(parsed: ParsedCron): number[] {
  const out: number[] = [];
  for (const h of parsed.hour.values) for (const m of parsed.minute.values) out.push(h * 60 + m);
  return out.sort((a, b) => a - b);
}

/** Error text, or null when the schedule is valid. */
export function validateSchedule(schedule: Schedule): string | null {
  if (!schedule || typeof schedule !== "object") return "Missing schedule.";
  if (!isValidTimezone(schedule.timezone)) return `"${schedule.timezone}" is not a timezone I know (use an IANA name like Europe/London).`;
  switch (schedule.type) {
    case "once":
      if (!parseDate(schedule.date)) return "Give the date as YYYY-MM-DD.";
      if (!parseTime(schedule.time)) return "Give the time as HH:MM (24-hour).";
      return null;
    case "daily":
      return parseTime(schedule.time) ? null : "Give the time as HH:MM (24-hour).";
    case "weekly":
      if (!parseTime(schedule.time)) return "Give the time as HH:MM (24-hour).";
      if (!Array.isArray(schedule.days) || !schedule.days.length) return "Pick at least one day.";
      if (schedule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Days are 0 (Sunday) to 6 (Saturday).";
      return null;
    case "interval":
      if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes <= 0) return "Give the interval in minutes.";
      if (schedule.everyMinutes < MINIMUM_INTERVAL_MINUTES) return `Routines may run at most every ${MINIMUM_INTERVAL_MINUTES} minutes.`;
      if (schedule.everyMinutes > 60 * 24 * 366) return "That interval is too long.";
      return null;
    case "cron": {
      const source = String(schedule.cron ?? "").trim();
      if (source.split(/\s+/).length !== 5) return "A cron schedule has exactly five fields: minute hour day month weekday.";
      const parsed = parseCron(source);
      if (!parsed) return "That cron schedule could not be read.";
      const minutes = cronMinutes(parsed);
      for (let i = 1; i < minutes.length; i++) {
        if (minutes[i] - minutes[i - 1] < MINIMUM_INTERVAL_MINUTES) return `Routines may run at most every ${MINIMUM_INTERVAL_MINUTES} minutes.`;
      }
      if (minutes.length > 1 && minutes[0] + 1440 - minutes[minutes.length - 1] < MINIMUM_INTERVAL_MINUTES) {
        return `Routines may run at most every ${MINIMUM_INTERVAL_MINUTES} minutes.`;
      }
      return null;
    }
    default:
      return "Unknown schedule type (use once, daily, weekly, interval or cron).";
  }
}

// Next run -----------------------------------------------------------------------------------

const MAX_SCAN_DAYS = 366 * 9;

/** The first run strictly after `after`, or null when there is none (a past one-off, an impossible cron). */
export function nextRunAfter(schedule: Schedule, after: number): number | null {
  if (validateSchedule(schedule)) return null;
  const tz = schedule.timezone;
  switch (schedule.type) {
    case "once": {
      const date = parseDate(schedule.date)!;
      const time = parseTime(schedule.time)!;
      const at = zonedToInstant({ ...date, ...time }, tz);
      return at > after ? at : null;
    }
    case "interval": {
      const step = schedule.everyMinutes * 60_000;
      const anchor = Number.isFinite(schedule.anchor) ? schedule.anchor : after;
      if (after < anchor) return anchor;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    case "daily":
    case "weekly": {
      const time = parseTime(schedule.time)!;
      const days = schedule.type === "weekly" ? new Set(schedule.days) : null;
      const start = wallClock(after, tz);
      for (let i = 0; i <= 8; i++) {
        const day = addDays(start.y, start.m, start.d, i);
        if (days && !days.has(day.weekday)) continue;
        const at = zonedToInstant({ y: day.y, m: day.m, d: day.d, ...time }, tz);
        if (at > after) return at;
      }
      return null;
    }
    case "cron": {
      const parsed = parseCron(schedule.cron)!;
      const minutes = cronMinutes(parsed);
      const restricted = !parsed.day.wildcard && !parsed.weekday.wildcard;
      const start = wallClock(after, tz);
      for (let i = 0; i < MAX_SCAN_DAYS; i++) {
        const day = addDays(start.y, start.m, start.d, i);
        if (!parsed.month.values.has(day.m)) continue;
        const dayMatch = parsed.day.values.has(day.d);
        const weekdayMatch = parsed.weekday.values.has(day.weekday);
        if (restricted ? !(dayMatch || weekdayMatch) : !(dayMatch && weekdayMatch)) continue;
        let best: number | null = null;
        for (const m of minutes) {
          const at = zonedToInstant({ y: day.y, m: day.m, d: day.d, h: Math.floor(m / 60), min: m % 60 }, tz);
          if (at > after && (best === null || at < best)) best = at;
        }
        if (best !== null) return best;
      }
      return null;
    }
  }
}

// Scheduler decisions ------------------------------------------------------------------------

export type DuePlan =
  | { action: "none" }
  /** Run now for the occurrence `scheduledFor`, then move on to `next`. */
  | { action: "run"; scheduledFor: number; next: number | null; late: boolean }
  /** The occurrence was missed and the policy says skip it. */
  | { action: "skip"; scheduledFor: number; next: number | null }
  /** This occurrence already has a run on record (e.g. the app closed mid-run): just move on. */
  | { action: "advance"; next: number | null };

export function planDue(routine: Routine, now: number): DuePlan {
  // Event routines run when their trigger fires (trigger-runner.ts), not on the clock.
  if (routine.trigger || !routine.enabled || routine.nextRun === null || routine.nextRun > now) return { action: "none" };
  const scheduledFor = routine.nextRun;
  const next = nextRunAfter(routine.schedule, now);
  if (routine.history.some((r) => r.scheduledFor === scheduledFor)) return { action: "advance", next };
  const late = now - scheduledFor > MISSED_GRACE_MS;
  if (late && routine.missedRunPolicy === "skip") return { action: "skip", scheduledFor, next };
  return { action: "run", scheduledFor, next, late };
}

/** Adds a run to the history (newest first), keeping the last {@link HISTORY_LIMIT}. */
export function withRun(routine: Routine, run: RoutineRun): Routine {
  const history = [run, ...routine.history.filter((r) => r.id !== run.id)].slice(0, HISTORY_LIMIT);
  return { ...routine, history };
}

/** Records a finished run: failure counting, auto-disable after too many failures in a row. */
export function finishRun(routine: Routine, run: RoutineRun): Routine {
  let next = withRun(routine, run);
  next = { ...next, lastRun: run.startedAt };
  if (run.status === "error") {
    const failures = routine.consecutiveFailures + 1;
    next = { ...next, consecutiveFailures: failures };
    if (failures >= MAX_CONSECUTIVE_FAILURES && next.enabled) {
      next = {
        ...next,
        enabled: false,
        disabledReason: `Switched off after ${failures} failed runs in a row. Fix the problem, then turn it back on.`,
      };
    }
  } else if (run.status === "ok" || run.status === "quiet") {
    next = { ...next, consecutiveFailures: 0 };
  }
  return next;
}

// Quiet runs ---------------------------------------------------------------------------------

export const NO_UPDATE_MARKER = "[[no-update]]";
const MARKER_RE = /\[\[\s*no[-_ ]update\s*\]\]/gi;

/** The reply says there's nothing new: record the run, but don't notify. */
export function isQuietReply(text: string | undefined): boolean {
  return Boolean(text && new RegExp(MARKER_RE.source, "i").test(text));
}

export function stripQuietMarker(text: string): string {
  return text.replace(MARKER_RE, "").trim();
}

export const QUIET_GUIDANCE =
  `If this run finds nothing worth telling the user (no change, nothing new), reply with ${NO_UPDATE_MARKER} ` +
  "and a one-line reason, and they won't be notified.";

// Descriptions -------------------------------------------------------------------------------

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "Every weekday";
  if (key === "0,6") return "Weekends";
  if (sorted.length === 7) return "Every day";
  if (sorted.length === 1) return `Every ${WEEKDAY_FULL[sorted[0]]}`;
  return sorted.map((d) => WEEKDAYS[d]).join(", ");
}

/** "Every weekday at 08:00", "Every 30 minutes", "Once on 2026-10-20 at 09:00". */
export function describeSchedule(schedule: Schedule, showTimezone = schedule.timezone !== localTimezone()): string {
  const tz = showTimezone ? ` (${schedule.timezone})` : "";
  switch (schedule.type) {
    case "once":
      return `Once on ${schedule.date} at ${schedule.time}${tz}`;
    case "daily":
      return `Every day at ${schedule.time}${tz}`;
    case "weekly":
      return `${describeDays(schedule.days)} at ${schedule.time}${tz}`;
    case "interval": {
      const m = schedule.everyMinutes;
      if (m % 1440 === 0) return m === 1440 ? "Every 24 hours" : `Every ${m / 1440} days`;
      if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
      return `Every ${m} minutes`;
    }
    case "cron": {
      const fields = schedule.cron.trim().split(/\s+/);
      const [mi, h, dom, mon, dow] = fields;
      if (fields.length === 5 && /^\d{1,2}$/.test(mi) && /^\d{1,2}$/.test(h) && mon === "*") {
        const time = `${pad(Number(h))}:${pad(Number(mi))}`;
        if (dom === "*" && dow === "*") return `Every day at ${time}${tz}`;
        if (dom === "*" && dow === "1-5") return `Every weekday at ${time}${tz}`;
        if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) return `${describeDays(dow.split(",").map((d) => Number(d) % 7))} at ${time}${tz}`;
        if (dow === "*" && /^\d{1,2}$/.test(dom)) return `Monthly on day ${Number(dom)} at ${time}${tz}`;
      }
      return `Cron ${schedule.cron}${tz}`;
    }
  }
}

/** "Mon 8:00" for the coming week, "Mon 3 Nov 8:00" further out, in the device's timezone. */
export function formatWhen(ms: number, now = Date.now(), timezone?: string): string {
  const far = Math.abs(ms - now) > 6 * 86400_000;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    ...(far ? { day: "numeric", month: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}
