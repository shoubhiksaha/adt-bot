import { createStore, get, set } from "idb-keyval";
import { create } from "zustand";
import { uid } from "../../lib/store";
import {
  localTimezone,
  MINIMUM_INTERVAL_MINUTES,
  nextRunAfter,
  type Routine,
  type RoutineRun,
  type Schedule,
  validateSchedule,
} from "./schedule";

/** Routines live in their own IndexedDB store on this device (no server). */
type Saved = { routines: Routine[]; keepAlive: boolean };
type RoutinesState = Saved & { loaded: boolean; running: string[] };

const db = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-routines", "data");
const KEY = "state";

export const useRoutines = create<RoutinesState>(() => ({ routines: [], keepAlive: false, loaded: false, running: [] }));

let loading: Promise<void> | null = null;

export function loadRoutines(): Promise<void> {
  loading ??= (async () => {
    if (useRoutines.getState().loaded) return;
    const saved = db ? await get<Saved>(KEY, db).catch(() => undefined) : undefined;
    // A run that was in progress when the app closed can't be finished any more.
    const routines = (saved?.routines ?? []).map((r) => ({
      ...r,
      history: r.history.map((h) => (h.status === "running" ? { ...h, status: "interrupted" as const, finishedAt: h.finishedAt ?? h.startedAt } : h)),
    }));
    useRoutines.setState({ routines, keepAlive: Boolean(saved?.keepAlive), loaded: true });
  })();
  return loading;
}

/** Writes the current state; awaited by the scheduler so a run is on disk before the schedule moves. */
export async function saveRoutines(): Promise<void> {
  const { routines, keepAlive } = useRoutines.getState();
  if (db) await set(KEY, { routines, keepAlive }, db);
}

export function getRoutine(id: string): Routine | undefined {
  return useRoutines.getState().routines.find((r) => r.id === id);
}

export async function patchRoutine(id: string, update: (r: Routine) => Routine): Promise<Routine | undefined> {
  let result: Routine | undefined;
  useRoutines.setState((s) => ({
    routines: s.routines.map((r) => {
      if (r.id !== id) return r;
      result = update(r);
      return result;
    }),
  }));
  await saveRoutines();
  return result;
}

export type RoutineInput = {
  botId: string;
  name: string;
  instruction: string;
  schedule: Schedule;
  enabled?: boolean;
  missedRunPolicy?: Routine["missedRunPolicy"];
  taintedBy?: string[];
};

/** Checks a routine's fields; returns an error sentence or null. */
export function validateRoutine(input: Partial<RoutineInput>): string | null {
  if (!input.name?.trim()) return "Give the routine a name.";
  if (input.name.trim().length > 80) return "Keep the name under 80 characters.";
  if (!input.instruction?.trim()) return "Say what the bot should do on each run.";
  if (input.instruction.length > 8000) return "The instruction is too long (8000 characters max).";
  if (!input.botId) return "Pick a bot.";
  if (!input.schedule) return "Pick a schedule.";
  return validateSchedule(input.schedule);
}

export async function createRoutine(input: RoutineInput, now = Date.now()): Promise<Routine> {
  const error = validateRoutine(input);
  if (error) throw new Error(error);
  const schedule = input.schedule.type === "interval" ? { ...input.schedule, anchor: now } : input.schedule;
  const nextRun = nextRunAfter(schedule, now);
  if (nextRun === null) throw new Error(schedule.type === "once" ? "That time is already in the past." : "That schedule never runs.");
  const routine: Routine = {
    id: uid(),
    botId: input.botId,
    name: input.name.trim(),
    instruction: input.instruction.trim(),
    schedule,
    enabled: input.enabled ?? true,
    missedRunPolicy: input.missedRunPolicy ?? "run-once",
    ...(input.taintedBy?.length ? { taintedBy: input.taintedBy } : {}),
    nextRun,
    consecutiveFailures: 0,
    history: [],
    createdAt: now,
  };
  useRoutines.setState((s) => ({ routines: [...s.routines, routine] }));
  await saveRoutines();
  return routine;
}

export async function updateRoutine(id: string, patch: Partial<RoutineInput>, now = Date.now()): Promise<Routine> {
  const current = getRoutine(id);
  if (!current) throw new Error("No such routine.");
  const merged = { ...current, ...patch };
  const error = validateRoutine(merged);
  if (error) throw new Error(error);
  const scheduleChanged = patch.schedule && JSON.stringify(patch.schedule) !== JSON.stringify(current.schedule);
  const schedule = scheduleChanged && merged.schedule.type === "interval" ? { ...merged.schedule, anchor: now } : merged.schedule;
  const turningOn = patch.enabled === true && !current.enabled;
  const nextRun = scheduleChanged || turningOn || current.nextRun === null ? nextRunAfter(schedule, now) : current.nextRun;
  if (merged.enabled && nextRun === null) {
    throw new Error(schedule.type === "once" ? "That time is already in the past." : "That schedule never runs.");
  }
  const updated = await patchRoutine(id, (r) => ({
    ...r,
    ...patch,
    name: merged.name.trim(),
    instruction: merged.instruction.trim(),
    schedule,
    nextRun,
    // Turning a routine back on gives it a clean slate.
    ...(turningOn ? { consecutiveFailures: 0, disabledReason: undefined } : {}),
  }));
  return updated!;
}

export async function deleteRoutine(id: string) {
  useRoutines.setState((s) => ({ routines: s.routines.filter((r) => r.id !== id) }));
  await saveRoutines();
}

export async function setKeepAlive(keepAlive: boolean) {
  useRoutines.setState({ keepAlive });
  await saveRoutines();
}

export function markRunning(id: string, running: boolean) {
  useRoutines.setState((s) => ({ running: running ? [...new Set([...s.running, id])] : s.running.filter((r) => r !== id) }));
}

/** Find a routine by id or (case-insensitive) name. */
export function findRoutine(ref: string): Routine | undefined {
  const { routines } = useRoutines.getState();
  const key = ref.trim().toLowerCase();
  return routines.find((r) => r.id === ref) ?? routines.find((r) => r.name.toLowerCase() === key);
}

export function emptySchedule(): Schedule {
  return { type: "daily", time: "08:00", timezone: localTimezone() };
}

export { MINIMUM_INTERVAL_MINUTES };
export type { Routine, RoutineRun };
