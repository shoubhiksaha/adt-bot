/**
 * Renderer side of "coding agents": command-line AI tools (Claude Code, Codex, Gemini CLI,
 * OpenCode, Aider) run by the desktop app (electron/features/50-cli-agents.cjs).
 */
import { desktopInvoke, desktopOn, isDesktop } from "../desktop";

export type CliAgentId = "claude" | "codex" | "gemini" | "opencode" | "aider";
export type CliPermission = "plan" | "default" | "edit" | "bypass";

export const CLI_AGENT_IDS: CliAgentId[] = ["claude", "codex", "gemini", "opencode", "aider"];

export const CLI_AGENT_NAMES: Record<CliAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  aider: "Aider",
};

export const PERMISSION_LABELS: Record<CliPermission, string> = {
  plan: "Read-only / plan",
  default: "Default (asks → denied)",
  edit: "Auto-accept edits",
  bypass: "Bypass all permissions (dangerous)",
};

export type DetectedCli = {
  id: CliAgentId;
  name: string;
  installed: boolean;
  path?: string;
  version?: string | null;
  error?: string;
  install: string;
  homepage: string;
  resume: boolean;
  models: string[];
};

export type CliEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; phase: "start" | "end"; id?: string; name: string; summary?: string; output?: string; isError?: boolean }
  | { type: "result"; text: string; sessionId?: string; isError?: boolean; costUsd?: number; durationMs?: number; turns?: number }
  | { type: "error"; message: string }
  | { type: "log"; text: string };

export type CliRunSummary = {
  runId: string;
  agent: string;
  ok: boolean;
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
  sessionId: string;
  result: string;
  text: string;
  error: string;
  cwd: string;
  costUsd?: number;
  turns?: number;
  durationMs: number;
};

export type CliRunOptions = {
  agent: CliAgentId;
  prompt: string;
  /** Working folder; relative paths are inside the ADT Bot Workspace (default). */
  cwd?: string;
  model?: string;
  resumeSession?: string;
  permission?: CliPermission;
  /** Extra instructions (Claude: --append-system-prompt; others: prepended to the prompt). */
  system?: string;
  /** Quick side request: no tools, no saved session (Claude Code). */
  light?: boolean;
  timeoutMs?: number;
};

export function cliAgentsAvailable(): boolean {
  return isDesktop();
}

export function isCliAgent(value: unknown): value is CliAgentId {
  return typeof value === "string" && (CLI_AGENT_IDS as string[]).includes(value);
}

export async function detectCliAgents(): Promise<{ agents: DetectedCli[]; workspace: string }> {
  return desktopInvoke("adt:cli:detect");
}

let counter = 0;

/** Runs a task; `onEvent` streams normalised events. Aborting the signal kills the CLI. */
export async function runCliAgent(options: CliRunOptions, onEvent: (event: CliEvent) => void, signal?: AbortSignal): Promise<CliRunSummary> {
  const runId = `r${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const off = desktopOn<{ runId: string; event: CliEvent }>("adt:cli:event", (payload) => {
    if (payload?.runId === runId) onEvent(payload.event);
  });
  const abort = () => void desktopInvoke("adt:cli:cancel", { runId }).catch(() => undefined);
  if (signal?.aborted) {
    off();
    throw new DOMException("Aborted", "AbortError");
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await desktopInvoke<CliRunSummary>("adt:cli:run", { ...options, runId });
  } finally {
    signal?.removeEventListener("abort", abort);
    off();
  }
}

/** Collects events into a terminal-style transcript. */
export class Transcript {
  private body = "";
  private full = false;
  constructor(private readonly limit = 60_000) {}

  push(event: CliEvent): void {
    switch (event.type) {
      case "text":
        return this.append(event.text);
      case "reasoning":
        return this.line(`  ✻ ${event.text.trim().slice(0, 400)}`);
      case "tool": {
        if (event.phase === "start") return this.line(`⏺ ${event.name}${event.summary ? `(${event.summary})` : ""}`);
        const label = event.summary && !event.output ? `${event.name}(${event.summary}) ` : "";
        const output = (event.output ?? "").trim().split("\n").slice(0, 6).join("\n    ").slice(0, 600);
        return this.line(`  ⎿ ${event.isError ? "✗ " : ""}${label}${output || "done"}`);
      }
      case "session":
        return this.line(`· session ${event.sessionId}${event.model ? ` · ${event.model}` : ""}`);
      case "result": {
        const bits = [
          event.isError ? "failed" : "done",
          event.turns ? `${event.turns} turns` : "",
          event.durationMs ? `${(event.durationMs / 1000).toFixed(1)} s` : "",
          event.costUsd ? `$${event.costUsd.toFixed(4)}` : "",
        ];
        return this.line(`· ${bits.filter(Boolean).join(" · ")}`);
      }
      case "error":
        return this.line(`✗ ${event.message}`);
      case "log":
        return this.line(event.text);
    }
  }

  /** A line of its own (starts on a fresh line after streamed text). */
  private line(text: string) {
    if (this.body && !this.body.endsWith("\n")) this.append("\n");
    this.append(`${text}\n`);
  }

  private append(text: string) {
    if (this.full) return;
    this.body += text;
    if (this.body.length > this.limit) {
      this.body = `${this.body.slice(0, this.limit)}\n[transcript cut]`;
      this.full = true;
    }
  }

  toString(): string {
    return this.body.replace(/\n{3,}/g, "\n\n").trimEnd();
  }
}

/** One short progress line for an event, or null when it isn't worth showing. */
export function progressLine(event: CliEvent): string | null {
  if (event.type === "tool" && event.phase === "start") return `${event.name}${event.summary ? `: ${event.summary.slice(0, 100)}` : ""}`;
  if (event.type === "session") return "Started…";
  if (event.type === "text") return null;
  if (event.type === "error") return `Error: ${event.message.slice(0, 120)}`;
  return null;
}
