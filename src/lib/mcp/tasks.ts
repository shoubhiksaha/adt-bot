/**
 * Long-running tool calls (the io.modelcontextprotocol/tasks extension, 2026-07-28): instead of a
 * result the server returns a task handle; we poll tasks/get until it finishes, answer questions
 * it asks on the way (tasks/update), and cancel it (tasks/cancel) when the user presses Stop or the
 * tool's time limit runs out. Pure apart from the injected I/O, so it is tested directly.
 */
import { McpError, McpTimeoutError } from "./protocol";
import { stripHidden } from "./unicode";

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type McpTask = {
  taskId: string;
  status: TaskStatus | string;
  statusMessage?: string;
  pollIntervalMs?: number;
  ttlMs?: number | null;
  inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
};

export const isTask = (value: unknown): value is McpTask =>
  Boolean(value) && typeof (value as McpTask).taskId === "string" && typeof (value as McpTask).status === "string";

/**
 * Time the server may spend, not counting time spent waiting for the user's answers (a question can
 * sit on screen for minutes without eating into the tool's time limit).
 */
export class Budget {
  private readonly started = Date.now();
  private excluded = 0;
  constructor(readonly totalMs: number) {}
  left(): number {
    return this.totalMs - (Date.now() - this.started - this.excluded);
  }
  async paused<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.excluded += Date.now() - start;
    }
  }
}

export type TaskIo = {
  get(taskId: string, timeoutMs: number): Promise<unknown>;
  update(taskId: string, inputResponses: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  cancel(taskId: string): Promise<unknown>;
  /** Asks the user; rejects when nobody can answer. */
  answer(inputRequests: NonNullable<McpTask["inputRequests"]>): Promise<Record<string, unknown>>;
  progress?(text: string): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
};

export const MIN_POLL_MS = 250;
export const MAX_POLL_MS = 30_000;
const FIRST_POLL_MS = 500;
const MAX_BACKOFF_MS = 5_000;
const MAX_POLL_FAILURES = 3;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Stopped", "AbortError"));
    const done = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** How long to wait before the next poll: the server's hint (bounded), else growing backoff. */
export function nextDelay(task: McpTask, previous: number | undefined): number {
  const hint = task.pollIntervalMs;
  if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0) return Math.min(Math.max(hint, MIN_POLL_MS), MAX_POLL_MS);
  return previous === undefined ? FIRST_POLL_MS : Math.min(Math.round(previous * 1.5), MAX_BACKOFF_MS);
}

const clean = (text: unknown) => (typeof text === "string" ? stripHidden(text).text.slice(0, 300) : "");

/** Polls a task to its end and returns the final result (what tools/call would have returned). */
export async function followTask(
  io: TaskIo,
  created: McpTask,
  options: { budget: Budget; signal?: AbortSignal; what: string },
): Promise<Record<string, unknown>> {
  const { budget, signal, what } = options;
  const wait = io.sleep ?? sleep;
  const answered = new Set<string>();
  let task = created;
  let delay: number | undefined;
  let failures = 0;
  const taskId = created.taskId;
  try {
    for (;;) {
      switch (task.status) {
        case "completed":
          if (!task.result || typeof task.result !== "object") throw new Error("The server finished the task without a result.");
          return task.result;
        case "failed": {
          const error = task.error ?? {};
          throw new McpError(typeof error.code === "number" ? error.code : -32603, clean(error.message) || clean(task.statusMessage) || "The task failed.", error.data);
        }
        case "cancelled":
          throw new Error(`The server cancelled the task${task.statusMessage ? `: ${clean(task.statusMessage)}` : "."}`);
        case "input_required": {
          // Keys are unique for a task's lifetime: never ask the same question twice.
          const open = Object.entries(task.inputRequests ?? {}).filter(([key]) => !answered.has(key));
          if (open.length) {
            const responses = await budget.paused(() => io.answer(Object.fromEntries(open)));
            for (const [key] of open) answered.add(key);
            await io.update(taskId, responses, Math.max(budget.left(), 1_000));
            delay = undefined;
          }
          break;
        }
        case "working":
          if (task.statusMessage) io.progress?.(clean(task.statusMessage));
          break;
        default:
          throw new Error(`The server reported an unknown task status (${String(task.status).slice(0, 40)}).`);
      }
      // After a failed poll, back off further before trying again.
      delay = Math.max(nextDelay(task, delay), failures ? Math.min(FIRST_POLL_MS * 2 ** failures, MAX_BACKOFF_MS) : 0);
      if (budget.left() <= 0) throw new McpTimeoutError(what, budget.totalMs);
      await wait(Math.min(delay, budget.left()), signal);
      if (budget.left() <= 0) throw new McpTimeoutError(what, budget.totalMs);
      try {
        const next = await io.get(taskId, budget.left());
        if (!isTask(next) || next.taskId !== taskId) throw new Error("The server answered tasks/get with something that isn't the task.");
        task = next;
        failures = 0;
      } catch (error) {
        const e = error as Error;
        if (e.name === "AbortError" || e instanceof McpTimeoutError) throw error;
        // An unknown or expired task can't come back.
        if (error instanceof McpError && error.code === -32602) throw new Error(`The server no longer knows the task (${clean(error.message)}).`);
        if (++failures > MAX_POLL_FAILURES) throw error;
      }
    }
  } catch (error) {
    const e = error as Error;
    // Stopped or out of time: tell the server (cooperative; it may finish anyway).
    if (e.name === "AbortError" || e instanceof McpTimeoutError) void io.cancel(taskId).catch(() => undefined);
    throw error;
  }
}
