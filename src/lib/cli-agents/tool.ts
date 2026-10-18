import { registerTool, registerToolGroup, str, type ToolRisk } from "../agent/tools";
import { CLI_AGENT_IDS, CLI_AGENT_NAMES, isCliAgent, progressLine, runCliAgent, Transcript, type CliPermission } from "./client";

registerToolGroup({
  id: "cli-agents",
  label: "Coding agents",
  description: "Hand coding tasks to command-line AI tools installed on this computer (Claude Code, Codex, Gemini CLI, OpenCode, Aider).",
  platforms: ["desktop"],
});

const PERMISSIONS: CliPermission[] = ["plan", "default", "edit", "bypass"];

/** Exported for tests: bypassing the CLI's own permission checks always needs a fresh approval. */
export function delegateRisk(args: Record<string, unknown>): ToolRisk {
  return args.permission === "bypass" ? "destructive" : "external";
}

registerTool({
  name: "delegate_to_cli_agent",
  group: "cli-agents",
  risk: "external",
  kind: "shell",
  platforms: ["desktop"],
  description:
    "Hand a coding task to a command-line AI agent installed on this computer (Claude Code, Codex, Gemini CLI, OpenCode or Aider). " +
    "It works in a folder (default: the ADT Bot Workspace) with its own tools and returns its final answer and a session id; " +
    "pass resumeSession to continue the same session with a follow-up. Describe the task completely — the agent can't see this chat.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", enum: CLI_AGENT_IDS, description: "Which CLI: claude, codex, gemini, opencode or aider" },
      task: { type: "string", description: "The full task or question for the agent" },
      folder: { type: "string", description: "Working folder (absolute, ~/…, or relative to the ADT Bot Workspace)" },
      resumeSession: { type: "string", description: "Session id from an earlier run, to continue it" },
      permission: {
        type: "string",
        enum: PERMISSIONS,
        description:
          "plan = read-only; default = the CLI's own defaults (anything that would ask is refused); edit = may edit files; bypass = no permission checks at all (dangerous, needs explicit user request)",
      },
      model: { type: "string", description: "Optional model name/alias for the CLI (e.g. sonnet, opus)" },
    },
    required: ["agent", "task"],
  },
  riskFor: delegateRisk,
  timeoutMs: 30 * 60_000,
  async run(args, ctx) {
    const agent = str(args, "agent").trim().toLowerCase();
    if (!isCliAgent(agent)) throw new Error(`Unknown agent "${agent}". Use one of: ${CLI_AGENT_IDS.join(", ")}.`);
    const permission = (PERMISSIONS as string[]).includes(str(args, "permission")) ? (str(args, "permission") as CliPermission) : "default";
    const transcript = new Transcript();
    let text = "";
    let lastPaint = 0;
    ctx.progress(`Starting ${CLI_AGENT_NAMES[agent]}…`);
    const summary = await runCliAgent(
      {
        agent,
        prompt: str(args, "task"),
        cwd: str(args, "folder") || undefined,
        resumeSession: str(args, "resumeSession") || undefined,
        permission,
        model: str(args, "model") || undefined,
        timeoutMs: 29 * 60_000,
      },
      (event) => {
        transcript.push(event);
        if (event.type === "text") text += event.text;
        const line = progressLine(event);
        const now = Date.now();
        if (line) ctx.progress(line);
        else if (event.type === "text" && now - lastPaint > 400) {
          lastPaint = now;
          ctx.progress(text.trim().split("\n").pop()?.slice(0, 120) || "Writing…");
        }
      },
      ctx.signal,
    );
    if (ctx.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const name = CLI_AGENT_NAMES[agent];
    const head = [
      `${name} ${summary.ok ? "finished" : "failed"} in ${summary.cwd || "the workspace"}${summary.durationMs ? ` (${Math.round(summary.durationMs / 1000)} s)` : ""}.`,
      summary.sessionId ? `Session id: ${summary.sessionId} (pass as resumeSession to follow up).` : "",
      summary.error ? `Error: ${summary.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const content = `${head}\n\nResult:\n${summary.result || "(no answer)"}`;
    return { content, display: { kind: "terminal", text: transcript.toString() || content }, untrustedSource: `${name} output` };
  },
});
