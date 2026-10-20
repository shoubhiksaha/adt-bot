import { type ChatRequest, type StreamEvent, streamChat, type ToolTurn } from "../llm";
import { presetById } from "../providers";
import type { ToolCallRecord } from "../types";
import { logActivity } from "./activity";
import { accessGuidance, isComputerTool } from "./access";
import { decide, gate, waitForDecision } from "./approvals";
import { type AgentTool, getTool, type ToolContext, toResult } from "./tools";
import { insideWorkspace } from "./builtin";
import { desktopInvoke } from "../desktop";
import { markUntrusted, UNTRUSTED_GUIDANCE } from "./vendor/copilotkit/untrusted-content";
import type { ToolCall, ToolSchema } from "./vendor/openbot/types";

/** Tool results longer than this are cut (with a visible note) to protect the context window. */
const RESULT_LIMIT = 16_000;
/**
 * Above this many tools, expose the core tools plus "find_tools". Small local models (and the text
 * protocol) get confused by long catalogs; large cloud models handle them fine.
 */
const DISCOVERY_THRESHOLD = { small: 24, large: 64 };
/** Screen control stays listed (never behind find_tools): a task on the Mac needs it every step. */
const ALWAYS_LISTED = new Set(["mac"]);
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
  "If a tool fails or is declined, explain and suggest another way rather than repeating the same call unchanged.",
  UNTRUSTED_GUIDANCE,
].join(" ");

/** How to use apps on the Mac well: by name, with as few steps as possible. */
export const COMPUTER_GUIDANCE = [
  "Using apps on this Mac:",
  "- Work by name, not by pixels: mac_ui lists an app's controls with [id]s; act with mac_press and mac_set_text. They return the window afterwards, so don't look again unless something is missing. Typing into an app in the background leaves the user's window in front.",
  "- Inside web pages (Safari, Chrome, Brave, Edge, Arc), use mac_browser: it reads and acts on the page itself, signed in as the user, even in the background.",
  "- When mac_ui can't see something, mac_find_text reads the text on screen with positions for mac_click; use mac_screenshot only for what has no text (images, canvases, games) or to check something visual.",
  "- Check mac_recipes first: if a saved recipe does the task, run it with mac_recipe_run. After working out a multi-step task the user may ask for again, save it as a recipe (steps that worked, elements named by text, changing values as {{params}}).",
  "- Take the shortest path: app links (whatsapp://send?phone=…&text=…, mailto:, spotify:…) and keyboard shortcuts (mac_key) beat clicking through menus. mac_open_app opens an app and lists its controls in one step.",
  "- ADT Bot's own window is usually in front: name the app you mean (app: \"WhatsApp\").",
  "- Check the result before saying it's done (e.g. the sent message appears in the chat). If something didn't work, try another way: a different element, a shortcut, or a screenshot to see what happened.",
  "- Don't describe each step to the user. Ask before sending messages, emails or payments only when the user didn't clearly ask for that exact action.",
].join("\n");

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
  const exposed = new Set(discovery ? tools.filter((t) => CORE_TOOLS.has(t.name) || ALWAYS_LISTED.has(t.group)).map((t) => t.name) : tools.map((t) => t.name));
  const records: ToolCallRecord[] = [];
  const turns: ToolTurn[] = [];
  const computer = tools.some(isComputerTool) ? accessGuidance(context.settings.agent, context) : "";
  const screen = tools.some((t) => t.group === "mac" || t.controlsComputer);
  const system = [request.system, TOOL_GUIDANCE, computer, screen ? COMPUTER_GUIDANCE : ""].filter(Boolean).join("\n\n");
  // Tasks in apps take more steps than questions do.
  const maxSteps = screen ? Math.max(options.maxSteps, 30) : options.maxSteps;

  const publish = () => callbacks.onCalls(records.map((r) => ({ ...r })));
  const update = (id: string, patch: Partial<ToolCallRecord>) => {
    const record = records.find((r) => r.id === id);
    if (record) Object.assign(record, patch);
    publish();
  };

  for (let step = 0; step <= maxSteps; step++) {
    const last = step === maxSteps;
    // The last step keeps the same tool list (Claude binds its thinking to it) and says "answer now".
    const schemas: ToolSchema[] = [
      ...tools.filter((t) => exposed.has(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
      ...(discovery ? [findToolsSchema] : []),
    ];
    let asked: Extract<StreamEvent, { type: "tool_calls" }> | null = null;
    try {
      for await (const event of streamChat({
        ...request,
        system,
        tools: schemas,
        finalNote: last ? "You've used the maximum number of tool steps for this answer. Answer now with what you have." : undefined,
        toolTurns: turns,
        toolMode: mode,
      })) {
        if (event.type === "tool_calls") asked = event;
        else callbacks.onEvent(event);
      }
    } catch (error) {
      const message = (error as Error).message ?? "";
      // Models (often local ones) that reject the tools parameter: switch to the text protocol.
      // A tool whose schema the provider rejects is a problem with that tool, not with tools in general.
      const schemaProblem = /\bschema\b|parameters|properties|\bitems\b|\$ref|additionalProperties/i.test(message);
      if (mode === "native" && step === 0 && !schemaProblem && /\b(tools?|function|tool_choice)\b/i.test(message) && /\b(4\d\d|support|not|unknown|invalid)\b/i.test(message)) {
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

    const verdict = gate(tool, call, context, await typingIntoTerminal(call, context));
    const botName = context.bot.name;
    if (verdict.outcome === "deny") {
      update(call.id, { status: "denied", result: verdict.refusal });
      void logActivity({ bot: botName, tool: call.name, summary: verdict.reason, outcome: "denied", conversationId: context.conversationId });
      return { id: call.id, name: call.name, content: verdict.refusal, isError: true };
    }
    if (verdict.outcome === "ask" && context.unattended) {
      const content =
        "Refused: this needs the user's approval, and approval cards can't be shown in voice mode. Don't retry it. " +
        "Tell the user what you wanted to do, and that they can do it from the chat, or allow it under Settings → Tools & safety → Computer access.";
      update(call.id, { status: "denied", result: "Needs approval (not possible in voice mode)" });
      void logActivity({ bot: botName, tool: call.name, summary: verdict.summary, outcome: "denied", conversationId: context.conversationId });
      return { id: call.id, name: call.name, content, isError: true };
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
          // The tool gets its own signal, aborted on Stop and on the time limit, so it can end its
          // work (kill a command) instead of running on after the loop gave up on it.
          (callSignal) => tool.run(call.args, { ...context, signal: callSignal, progress: (text) => update(call.id, { result: text }) }),
          tool.timeoutMs ?? 120_000,
          context.signal,
        ),
      );
      let content = value.content ?? "";
      if (content.length > RESULT_LIMIT) content = `${content.slice(0, RESULT_LIMIT)}\n\n[…cut: ${content.length - RESULT_LIMIT} more characters]`;
      if (value.untrustedSource) content = markUntrusted(content, value.untrustedSource);
      if (value.untrustedSource && context.taint && taints(tool, call)) context.taint.sources.add(value.untrustedSource.slice(0, 80));
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

/**
 * Whether a result's outside content should make the rest of the turn ask before commands and file
 * changes. The screen (screenshots, UI lists) doesn't: Full access exists to work with what's on it.
 * Neither do the workspace's own files or plain command output; a command that fetched from the web does.
 */
export function taints(tool: AgentTool, call: ToolCall): boolean {
  if (tool.group === "mac") return tool.name === "mac_applescript";
  // Mac-control connectors (Peekaboo, Ghost OS…) look at the screen too.
  if (tool.controlsComputer) return false;
  if (tool.name === "read_file" || tool.name === "list_files") return !insideWorkspace(String(call.args.path ?? ""));
  if (tool.name === "run_command") return /\b(curl|wget|https?:\/\/|git\s+(clone|pull|fetch)|npx|pip3?\s+download)\b/i.test(String(call.args.command ?? ""));
  return true;
}

const TERMINALS = /\b(terminal|iterm2?|warp|alacritty|kitty|wezterm|ghostty|hyper|tabby|termius|console)\b/i;
const TYPING = new Set(["mac_type", "mac_key", "mac_set_text", "mac_press"]);

/** After outside content, typing or pressing keys into a terminal is as good as running a command: ask. */
async function typingIntoTerminal(call: ToolCall, context: ToolContext): Promise<string | undefined> {
  if (!context.taint?.sources.size || !TYPING.has(call.name)) return undefined;
  const reason = "this conversation read outside content, and this types into a terminal";
  if (TERMINALS.test(String(call.args.app ?? ""))) return reason;
  try {
    const front = await desktopInvoke<{ name?: string }>("adt:mac:frontmost");
    return TERMINALS.test(front?.name ?? "") ? reason : undefined;
  } catch {
    return undefined;
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

function withTimeout<T>(start: (signal: AbortSignal) => Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  const own = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      own.abort();
      reject(new Error(`timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
    const abort = () => {
      own.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    start(own.signal).then(
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
