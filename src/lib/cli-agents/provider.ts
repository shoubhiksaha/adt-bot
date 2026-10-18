/**
 * A command-line agent as a bot's "model" (provider kind "cli", desktop only). Each reply runs the
 * CLI once: the latest user message (plus a short recap of the chat) goes in, its text streams back.
 * Claude Code / Codex / Gemini / OpenCode keep their own sessions, so later turns resume the session
 * and send only what's new.
 */
import type { ChatRequest, StreamEvent } from "../llm";
import type { Message, ModelInfo, ProviderConfig } from "../types";
import { CLI_AGENT_NAMES, cliAgentsAvailable, isCliAgent, runCliAgent, type CliAgentId, type CliEvent } from "./client";

const MODELS: Record<CliAgentId, string[]> = {
  claude: ["default", "sonnet", "opus", "haiku"],
  codex: ["default"],
  gemini: ["default", "gemini-2.5-pro", "gemini-2.5-flash"],
  opencode: ["default"],
  aider: ["default"],
};

const RESUMABLE = new Set<CliAgentId>(["claude", "codex", "gemini", "opencode"]);

/** "cli:claude" → "claude". */
export function cliAgentOf(provider: Pick<ProviderConfig, "baseUrl" | "presetId">): CliAgentId {
  const fromUrl = provider.baseUrl.replace(/^cli:\/*/i, "").trim().toLowerCase();
  if (isCliAgent(fromUrl)) return fromUrl;
  const fromPreset = provider.presetId.replace(/^cli-/, "");
  if (isCliAgent(fromPreset)) return fromPreset;
  throw new Error(`Unknown command-line agent "${provider.baseUrl}". Use cli:claude, cli:codex, cli:gemini, cli:opencode or cli:aider.`);
}

export async function cliModels(provider: ProviderConfig): Promise<ModelInfo[]> {
  const agent = cliAgentOf(provider);
  return MODELS[agent].map((id) => ({ id, name: id === "default" ? `${CLI_AGENT_NAMES[agent]} default` : id, reasoning: true }));
}

function textOf(m: Message): string {
  const files = (m.attachments ?? []).flatMap((a) => (a.kind === "file" ? [`<file name="${a.name}">\n${a.text}\n</file>`] : []));
  const images = (m.attachments ?? []).filter((a) => a.kind === "image").length;
  return [files.join("\n\n"), m.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), images ? `(${images} image(s) attached — not visible to the agent)` : ""]
    .filter(Boolean)
    .join("\n\n");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Brief recap of earlier turns + the new message. */
export function buildCliPrompt(messages: Message[]): string {
  const usable = messages.filter((m) => !m.error && (m.content || m.attachments?.length));
  const lastUser = [...usable].reverse().find((m) => m.role === "user");
  if (!lastUser) throw new Error("There's no message to send.");
  const current = textOf(lastUser);
  const earlier = usable.slice(0, usable.indexOf(lastUser)).slice(-6);
  if (!earlier.length) return current;
  let recap = earlier.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${clip(textOf(m), 1500)}`).join("\n\n");
  recap = clip(recap, 8000);
  return `Conversation so far (for context):\n${recap}\n\n---\n\nCurrent message:\n${current}`;
}

/** Remembered CLI sessions: chat (provider + first message) → session id and the last user message sent. */
const sessions = new Map<string, { sessionId: string; lastUserId: string }>();

function sessionKey(provider: ProviderConfig, messages: Message[]): string | null {
  const first = messages[0];
  if (!first || first.createdAt === 0) return null; // one-off side requests (titles, search queries)
  return `${provider.id}:${first.id}`;
}

/** What to send: only the new user turns when the CLI already holds the conversation. */
export function planTurn(
  messages: Message[],
  remembered: { sessionId: string; lastUserId: string } | undefined,
): { prompt: string; resumeSession?: string } {
  const users = messages.filter((m) => m.role === "user" && !m.error);
  const latest = users[users.length - 1];
  if (remembered && latest && latest.id !== remembered.lastUserId) {
    const at = messages.findIndex((m) => m.id === remembered.lastUserId);
    if (at >= 0) {
      const fresh = messages.slice(at + 1).filter((m) => m.role === "user" && !m.error);
      if (fresh.length) return { prompt: fresh.map(textOf).join("\n\n"), resumeSession: remembered.sessionId };
    }
  }
  return { prompt: buildCliPrompt(messages) };
}

/** streamChat for provider kind "cli". */
export async function* streamCliChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  if (!cliAgentsAvailable()) throw new Error("Command-line agents only work in the ADT Bot desktop app.");
  const agent = cliAgentOf(req.provider);
  const key = sessionKey(req.provider, req.messages);
  const remembered = key && RESUMABLE.has(agent) ? sessions.get(key) : undefined;
  const turn = planTurn(req.messages, remembered);
  const light = !key;

  // Bridge the callback stream into this generator.
  const queue: CliEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const run = runCliAgent(
    {
      agent,
      prompt: turn.prompt,
      model: req.model,
      resumeSession: turn.resumeSession,
      permission: "default",
      // The bot's instructions; on a resumed session the CLI already has them.
      system: turn.resumeSession ? undefined : clip(req.system || "", 6000) || undefined,
      light,
      timeoutMs: light ? 90_000 : 15 * 60_000,
    },
    (event) => {
      queue.push(event);
      wake?.();
    },
    req.signal,
  ).finally(() => {
    finished = true;
    wake?.();
  });
  run.catch(() => undefined);

  let sawText = false;
  while (true) {
    while (queue.length) {
      const event = queue.shift()!;
      if (event.type === "text") {
        sawText = true;
        yield { type: "text", text: event.text };
      } else if (event.type === "reasoning") yield { type: "reasoning", text: event.text };
      else if (event.type === "tool" && event.phase === "start") yield { type: "status", text: `${CLI_AGENT_NAMES[agent]}: ${event.name}${event.summary ? ` ${event.summary.slice(0, 80)}` : ""}` };
    }
    if (finished) break;
    await new Promise<void>((resolve) => (wake = resolve));
    wake = null;
  }
  const summary = await run;
  if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!summary.ok) throw new Error(summary.error || `${CLI_AGENT_NAMES[agent]} failed.`);
  if (!sawText && summary.result) yield { type: "text", text: summary.result };
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  if (key && summary.sessionId && lastUser && RESUMABLE.has(agent)) sessions.set(key, { sessionId: summary.sessionId, lastUserId: lastUser.id });
}
