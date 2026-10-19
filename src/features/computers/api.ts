/** Typed calls to electron/features/80-computers.cjs ("adt:computers:*"). */
import { desktopInvoke, desktopOn } from "../../lib/desktop";
import { type ComputerConfig, configFor } from "./store";

export type EngineStatus = {
  installed: boolean;
  running: boolean;
  runtime: string | null;
  binary?: string;
  version?: string;
  cpus?: number | null;
  memory?: number | null;
  error?: string;
  hints: string[];
};

export type ComputerInfo = {
  name: string;
  botId: string;
  state: string;
  status: string;
  image: string;
  cpu: string | null;
  memory: string | null;
  memoryPercent: string | null;
};

export type ExecResult = { runId: string; code: number; output: string; truncated: boolean; timedOut: boolean; cancelled: boolean; ms: number };
export type FileEntry = { name: string; type: "dir" | "file" | "link" | "other"; size: number; modified: number };
export type ReadResult = { path: string; binary: boolean; size: number; text: string; truncated?: boolean };

/** Main-process errors arrive as "Error invoking remote method 'adt:…': Error: <message>". */
function clean(error: unknown): Error {
  const message = String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
  return new Error(message);
}

async function call<T>(op: string, payload?: Record<string, unknown>): Promise<T> {
  try {
    return await desktopInvoke<T>(`adt:computers:${op}`, payload);
  } catch (error) {
    throw clean(error);
  }
}

const withConfig = (botId: string, extra: Record<string, unknown> = {}) => ({ botId, config: configFor(botId) as ComputerConfig, ...extra });

export const computers = {
  status: () => call<EngineStatus>("status"),
  ensureImage: (browser = false) => call<{ tag: string; built: boolean }>("ensure-image", { browser }),
  list: () => call<ComputerInfo[]>("list"),
  start: (botId: string) => call("start", withConfig(botId)),
  stop: (botId: string) => call("stop", { botId }),
  reset: (botId: string, wipe = false) => call("reset", withConfig(botId, { wipe })),
  remove: (botId: string, wipe = false) => call("delete", { botId, wipe }),
  exec: (botId: string, command: string, opts: { runId: string; timeoutMs?: number; cwd?: string; root?: boolean }) =>
    call<ExecResult>("exec", withConfig(botId, { command, ...opts })),
  cancel: (runId: string) => call<{ cancelled: boolean }>("cancel", { runId }),
  read: (botId: string, path: string) => call<ReadResult>("read", withConfig(botId, { path })),
  write: (botId: string, path: string, content: string, append = false) => call<{ path: string; size: number }>("write", withConfig(botId, { path, content, append })),
  listFiles: (botId: string, path: string) => call<{ path: string; entries: FileEntry[] }>("list-files", withConfig(botId, { path })),
  download: (botId: string, path: string) => call<{ path: string }>("download", { botId, path }),
  browse: (botId: string, url: string, runId: string) => call<{ url: string; text: string; screenshot: string | null }>("browse", withConfig(botId, { url, runId })),
  pickFolder: () => call<{ path: string | null }>("pick-folder"),
};

export const onOutput = (listener: (e: { runId: string; chunk: string }) => void) => desktopOn("adt:computers:output", listener);
export const onBuild = (listener: (e: { tag: string; chunk: string; done?: boolean }) => void) => desktopOn("adt:computers:build", listener);

export const newRunId = () => crypto.randomUUID();
