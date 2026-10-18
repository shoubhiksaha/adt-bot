import { type ChatRequest, type StreamEvent, streamChat, type ToolTurn } from "../llm";
import { presetById } from "../providers";
import type { ToolCallRecord } from "../types";
import { logActivity } from "./activity";
import { decide, gate, waitForDecision } from "./approvals";
import { type AgentTool, getTool, type ToolContext, toResult } from "./tools";
import { markUntrusted, UNTRUSTED_GUIDANCE } from "./vendor/copilotkit/untrusted-content";
import type { ToolCall, ToolSchema } from "./vendor/openbot/types";

/** Tool results longer than this are cut (with a visible note) to protect the context window. */
const RESULT_LIMIT = 16_000;
/**
 * Above this many tools, expose the core tools plus "find_tools". Small local models (and the text
 * protocol) get confused by long catalogs; large cloud models handle them fine.
 */
const DISCOVERY_THRESHOLD = { small: 24, large: 64 };
const CORE_TOOLS = new Set([
  "web_search",
  "read_url",
  "search_knowledge",
  "remember",
  "current_time",
  "calculate",
  "visualize",
  "create_image",
  "find_tools",
]);

function discoveryThreshold(request: LoopOptions["request"], mode: "native" | "prompted"): number {
  const local = mode === "prompted" || presetById(request.provider.presetId)?.local || request.provider.kind === "cli";
  return local ? DISCOVERY_THRESHOLD.small : DISCOVERY_THRESHOLD.large;
}

/** Models that rejected native tools this session; they use the text protocol from now on. */
const promptedFallback = new Set<string>();

export const TOOL_GUIDANCE = [
  "You can use tools to act and to look things up. Use them when they genuinely help; for simple chat, just answer.",
  "When you use a tool, briefly say what you're doing. After the results arrive, answer the user directly.",
  "If a tool fails or is declined, explain and suggest another way rather than retrying the same call.",
  UNTRUSTED_GUIDANCE,
].join(" ");

export type LoopCallbacks = {
  onEvent: (event: StreamEvent) => void;
  onCalls: (calls: ToolCallRecord[]) => void;
};

export type LoopOptions = {
  request: Omit<ChatRequest, "tools" | "toolTurns" | "toolMode">;
  tools: AgentTool[];
  context: ToolContext;
  mode: "auto" | "native" | "prompted";
  maxSteps: number;
  callbacks: LoopCallbacks;
};

const findToolsSchema: ToolSchema = {
  name: "find_tools",
  description:
    "Search the other tools you can use (computers, files, projects, connectors…). Returns matching tools; they become available on your next step.",
  parameters: { type: "object", properties: { query: { type: "string", description: "What you want to do" } }, required: ["query"] },
};

/**
 * Runs one assistant turn with tools: model → tool calls → approvals → tools → model … until the
 * model answers without calling tools, or the step cap is reached (then it must answer).
 */
export async function runToolLoop(options: LoopOptions): Promise<void> {
  const { request, tools, context, callbacks } = options;
  const key = `${request.provider.id}::${request.model}`;
  let mode: "native" | "prompted" = options.mode === "auto" ? (promptedFallback.has(key) ? "prompted" : "native") : options.mode;
  const discovery = tools.length > discoveryThreshold(request, mode);
  const exposed = new Set(discovery ? tools.filter((t) => CORE_TOOLS.has(t.name)).map((t) => t.name) : tools.map((t) => t.name));
  const records: ToolCallRecord[] = [];
  const turns: ToolTurn[] = [];
  const system = [request.system, TOOL_GUIDANCE].filter(Boolean).join("\n\n");

  const publish = () => callbacks.onCalls(records.map((r) => ({ ...r })));
  const update = (id: string, patch: Partial<ToolCallRecord>) => {
    const record = records.find((r) => r.id === id);
    if (record) Object.assign(record, patch);
    publish();
  };

  for (let step = 0; step <= options.maxSteps; step++) {
    const last = step === options.maxSteps;
    const schemas: ToolSchema[] = last
      ? []
      : [
          ...tools.filter((t) => exposed.has(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
          ...(discovery ? [findToolsSchema] : []),
        ];
    let asked: Extract<StreamEvent, { type: "tool_calls" }> | null = null;
    try {
      for await (const event of streamChat({
        ...request,
        system: last ? `${system}\n\nYou've used the maximum number of tool steps for this answer. Answer now with what you have.` : system,
        tools: schemas,
        toolTurns: turns,
        toolMode: mode,
      })) {
        if (event.type === "tool_calls") asked = event;
        else callbacks.onEvent(event);
      }
    } catch (error) {
      const message = (error as Error).message ?? "";
      // Models (often local ones) that reject the tools parameter: switch to the text protocol.
      if (mode === "native" && step === 0 && /\b(tools?|function|tool_choice)\b/i.test(message) && /\b(4\d\d|support|not|unknown|invalid)\b/i.test(message)) {
        promptedFallback.add(key);
        mode = "prompted";
        step--;
        continue;
      }
      throw error;
    }
    if (!asked || !asked.calls.length) return;
    if (asked.text) callbacks.onEvent({ type: "text", text: "\n\n" });

    const results: ToolTurn["results"] = [];
    for (const call of asked.calls) {
      const content = await runCall(call);
      results.push(content);
    }
    turns.push({ raw: asked.raw, text: asked.text, calls: asked.calls, results });
  }

  async function runCall(call: ToolCall): Promise<ToolTurn["results"][number]> {
    const started = Date.now();
    const record: ToolCallRecord = { id: call.id, name: call.name, args: call.args, status: "pending", startedAt: started };
    records.push(record);
    publish();

    if (call.name === "find_tools") {
      const found = searchTools(tools, String(call.args.query ?? ""));
      for (const t of found) exposed.add(t.name);
      const content = found.length
        ? `These tools are now available:\n${found.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`
        : "No matching tools.";
      update(call.id, { status: "done", result: content, ms: Date.now() - started });
      return { id: call.id, name: call.name, content };
    }

    const tool = getTool(call.name);
    if (!tool || !tools.includes(tool)) {
      const content = `Error: the tool "${call.name}" isn't available. Use one of the listed tools.`;
      update(call.id, { status: "error", result: content, ms: 0 });
      return { id: call.id, name: call.name, content, isError: true };
    }

    const verdict = gate(tool, call);
    const botName = context.bot.name;
    if (verdict.outcome === "deny") {
      update(call.id, { status: "denied", result: verdict.refusal });
      void logActivity({ bot: botName, tool: call.name, summary: verdict.reason, outcome: "denied", conversationId: context.conversationId });
      return { id: call.id, name: call.name, content: verdict.refusal, isError: true };
    }
    if (verdict.outcome === "ask") {
      update(call.id, {
        status: "awaiting",
        approval: { summary: verdict.summary, detail: verdict.detail, reason: verdict.reason, kind: verdict.kind, allowAlways: verdict.allowAlways },
      });
      const decision = await waitForDecision(call.id, context.signal);
      if (decision === "deny") {
        const content = "The user declined this action. Don't retry it; tell them what you were trying to do or suggest another way.";
        update(call.id, { status: "denied", result: "Declined", approval: undefined });
        void logActivity({ bot: botName, tool: call.name, summary: verdict.summary, outcome: "denied", conversationId: context.conversationId });
        return { id: call.id, name: call.name, content, isError: true };
      }
      update(call.id, { approval: undefined });
    }

    update(call.id, { status: "running", startedAt: Date.now() });
    try {
      const value = toResult(
        await withTimeout(
          tool.run(call.args, { ...context, progress: (text) => update(call.id, { result: text }) }),
          tool.timeoutMs ?? 120_000,
          context.signal,
        ),
      );
      let content = value.content ?? "";
      if (content.length > RESULT_LIMIT) content = `${content.slice(0, RESULT_LIMIT)}\n\n[…cut: ${content.length - RESULT_LIMIT} more characters]`;
      if (value.untrustedSource) content = markUntrusted(content, value.untrustedSource);
      update(call.id, { status: "done", result: preview(value.content ?? ""), display: value.display, ms: Date.now() - started });
      void logActivity({
        bot: botName,
        tool: call.name,
        summary: verdict.outcome === "ask" ? verdict.summary : summariseArgs(call),
        outcome: "done",
        ms: Date.now() - started,
        conversationId: context.conversationId,
      });
      return { id: call.id, name: call.name, content, ...(value.image ? { image: value.image } : {}) };
    } catch (error) {
      const content = `Error: ${(error as Error).message}`;
      update(call.id, { status: "error", result: content, ms: Date.now() - started });
      void logActivity({ bot: botName, tool: call.name, summary: content.slice(0, 160), outcome: "error", conversationId: context.conversationId });
      return { id: call.id, name: call.name, content, isError: true };
    }
  }
}

/** Approve or deny a pending call from the chat UI. */
export function answerApproval(record: ToolCallRecord, decision: "once" | "always" | "deny") {
  decide(getTool(record.name), { id: record.id, name: record.name, args: record.args }, decision);
}

function searchTools(tools: AgentTool[], query: string): AgentTool[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scored = tools
    .filter((t) => !CORE_TOOLS.has(t.name))
    .map((t) => {
      const hay = `${t.name} ${t.description} ${t.group}`.toLowerCase();
      return { t, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.t);
}

function preview(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function summariseArgs(call: ToolCall): string {
  const first = Object.values(call.args).find((v) => typeof v === "string") as string | undefined;
  return `${call.name}${first ? `: ${first.slice(0, 120)}` : ""}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
