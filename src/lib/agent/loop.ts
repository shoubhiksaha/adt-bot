import { type ChatRequest, type StreamEvent, streamChat, type ToolTurn } from "../llm";
import { presetById } from "../providers";
import type { ToolCallRecord } from "../types";
import { type ActivityEntry, logActivity, redactArgs, resultPreview } from "./activity";
import { accessGuidance, isComputerTool } from "./access";
import { askAloudDetail, askAloudText } from "./asks";
import { callSummary, decide, gate, type GateResult, waitForDecision, isPending, type Decision } from "./approvals";
import { applyReview, reviewCall, reviewScope } from "./reviewer";
import { type AgentTool, getTool, type ToolContext, toResult } from "./tools";
import { insideWorkspace } from "./builtin";
import { isTerminalApp, TERMINAL_APPS } from "./danger";
import { fitArgs, parseBareCall } from "./prompted";
import { desktopInvoke } from "../desktop";
import { readFiring } from "./vendor/copilotkit/routine-firing";
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

/** Words in many tool names: on their own they don't say which tool the user means. */
const GENERIC_NAME_WORDS = new Set("get set list create read run search find make open add update delete remove use send save show new check write edit start stop ask".split(" "));
/** Joining words in tool names (discuss_with_bots): never a reason to list a tool. */
const NAME_FILLERS = new Set("with from into for and the to of by on in at my your".split(" "));

/**
 * With a short catalog, the tools the user's message names ("save this as a skill" → save_skill,
 * "check my email" → email_*), listed from the first step: small models rarely think to search.
 * A tool only qualifies when a specific word of its name is in the message.
 */
export function toolsForMessage(tools: Pick<AgentTool, "name" | "description">[], text: string, limit = 3): string[] {
  const stem = (w: string) => (w.length > 4 ? w.replace(/(ies|es|s)$/, "") : w);
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2)
      .map(stem),
  );
  return tools
    .filter((t) => !CORE_TOOLS.has(t.name))
    .map((t) => {
      const nameWords = t.name
        .toLowerCase()
        .split(/[_\W]+/)
        .filter((w) => w && !NAME_FILLERS.has(w))
        .map(stem);
      const specific = nameWords.filter((w) => !GENERIC_NAME_WORDS.has(w) && words.has(w)).length;
      const generic = nameWords.filter((w) => GENERIC_NAME_WORDS.has(w) && words.has(w)).length;
      const described = new Set(t.description.toLowerCase().split(/[^\p{L}\p{N}]+/u).map(stem));
      const context = [...words].filter((w) => described.has(w)).length;
      return { name: t.name, specific, score: specific * 3 + generic + Math.min(context, 4) * 0.25 };
    })
    .filter((s) => s.specific > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

function discoveryThreshold(request: LoopOptions["request"], mode: "native" | "prompted"): number {
  const local = mode === "prompted" || presetById(request.provider.presetId)?.local || request.provider.kind === "cli";
  return local ? DISCOVERY_THRESHOLD.small : DISCOVERY_THRESHOLD.large;
}

/**
 * Pure lookups: an identical call later in the same turn reuses the first result. Nothing that reads
 * the screen, apps or files (their state changes), and not the clock.
 */
const REUSABLE = new Set(["web_search", "read_url", "search_knowledge"]);

/** JSON with sorted keys, so {a, b} and {b, a} are the same call. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Models that rejected native tools this session; they use the text protocol from now on. */
const promptedFallback = new Set<string>();

/** Resolves "deny" when the turn is stopped (so a pending question never outlives it). */
function abortedAsDeny(signal: AbortSignal): Promise<"deny"> {
  return new Promise((resolve) => (signal.aborted ? resolve("deny") : signal.addEventListener("abort", () => resolve("deny"), { once: true })));
}

export const TOOL_GUIDANCE = [
  "You can use tools to act and to look things up. Use them when they genuinely help; for simple chat, just answer.",
  "When you use a tool, briefly say what you're doing. After the results arrive, answer the user directly.",
  "If a tool fails or is declined, explain and suggest another way rather than repeating the same call unchanged.",
  "For anything at a later time or on a schedule (reminders, daily summaries, recurring jobs), use create_routine: it's the app's own scheduler. Don't write cron jobs, launchd agents or scripts for it.",
  UNTRUSTED_GUIDANCE,
].join(" ");

/** How to use apps on the Mac well: by name, with as few steps as possible. */
export const COMPUTER_GUIDANCE = [
  "Using apps on this Mac:",
  "- Work by name, not by pixels: mac_ui lists an app's controls with [id]s; act with mac_press and mac_set_text. They return the window afterwards, so don't look again unless something is missing. Typing into an app in the background leaves the user's window in front.",
  "- Inside web pages (Safari, Chrome, Brave, Edge, Arc), use mac_browser: it reads and acts on the page itself, signed in as the user, even in the background. If it says the browser doesn't allow JavaScript from Apple Events, call mac_browser with action allow_page_access once (never AppleScript or menu clicks for this).",
  "- When mac_ui can't see something, mac_find_text reads the text on screen with positions for mac_click; use mac_screenshot only for what has no text (images, canvases, games) or to check something visual.",
  "- Check mac_recipes first: if a saved recipe does the task, run it with mac_recipe_run. After working out a multi-step task the user may ask for again, save it as a recipe (steps that worked, elements named by text, changing values as {{params}}).",
  "- Take the shortest path: app links (whatsapp://send?phone=…&text=…, mailto:, spotify:…) and keyboard shortcuts (mac_key) beat clicking through menus. mac_open_app opens an app and lists its controls in one step.",
  "- ADT Bot's own window is usually in front: name the app you mean (app: \"WhatsApp\").",
  "- The user may be using the Mac at the same time. Stay in the background: name the app (app: \"WhatsApp\"), press by name, type with mac_set_text. Tools that need the front app wait for the user to pause and refuse if there's none (\"busy\"): wait a moment and try again, don't fight for the keyboard.",
  "- Sending: use mac_set_text with submit:true, which sends only if the field still holds your text in the same app. If it reports the text is still there, press the app's Send button by name. Never press enter on its own to send: the user may have switched chats, and Return would send whatever they were typing.",
  "- Check the result before saying it's done (e.g. the sent message appears in the chat, in the right chat). If something didn't work, try another way: a different element, a shortcut, or a screenshot to see what happened.",
  "- When you say a task is done, say in a few words what you saw that shows it (e.g. \"your message now shows in the chat with Sam\"). If you couldn't confirm it, say so instead of claiming success.",
  "- Don't describe each step to the user. Ask before sending messages, emails or payments only when the user didn't clearly ask for that exact action.",
].join("\n");

/** Screen tools that only look: their result shows the app or screen as it is now. */
const SCREEN_LOOKS = new Set(["mac_ui", "mac_screenshot", "mac_find_text"]);
/** mac_ tools that don't act on the screen. */
const OFF_SCREEN = new Set(["mac_recipes", "mac_list_apps"]);

/**
 * After a screen tool ran: the action whose result nobody has looked at yet (its name), or null once
 * a look (or an action that returns the window afterwards) shows the current state. Other tools
 * leave it as it was.
 */
export function unseenAction(current: string | null, tool: Pick<AgentTool, "name" | "group" | "risk" | "riskFor">, args: Record<string, unknown>, observed?: boolean): string | null {
  if (tool.group !== "mac" || OFF_SCREEN.has(tool.name)) return current;
  if (SCREEN_LOOKS.has(tool.name) || (tool.riskFor?.(args) ?? tool.risk) === "read") return null;
  return observed ? null : tool.name;
}

/** Whether a final answer says the task worked (rather than that it couldn't, or asking something). */
export function claimsSuccess(text: string): boolean {
  if (/\b(couldn['’]?t|could not|can['’]?t|cannot|unable|failed|didn['’]?t|did not|wasn['’]?t|weren['’]?t|haven['’]?t|hasn['’]?t|not sure|unclear|not (yet )?(confirm|done|sent))/i.test(text)) return false;
  return /\b(done|all set|sent|posted|saved|created|opened|closed|added|removed|deleted|moved|renamed|completed|finished|updated|changed|switched|turned (on|off)|enabled|disabled|started|playing|scheduled|booked|submitted|typed|pressed|clicked|success(ful(ly)?)?|should (now )?(be|show|appear))\b/i.test(text);
}

/** Told to the model (with the last result) when it says a screen task is done without having seen the result. */
export const verifyNote = (action: string) =>
  `[ADT Bot: nothing has looked at the screen since your last action (${action}), so the result isn't confirmed. Before telling the user it's done, check it once (mac_ui, mac_find_text or mac_screenshot), then answer with what you saw.]`;

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
  /** Tool calls wait for this before running; if it rejects, none run (an early voice reply that was dropped). */
  hold?: Promise<void>;
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
  if (discovery) {
    // The user's own words name the tools worth listing now: not pasted outside content, nor the
    // context the app adds to the message (notes, memories).
    const latest = [...request.messages].reverse().find((m) => m.role === "user")?.content.split("<untrusted_data")[0].split("\n\n---\nContext for this message:")[0] ?? "";
    // A routine run: only its instruction, not the app's frame around it.
    const asked = readFiring(latest) ?? latest;
    for (const name of toolsForMessage(tools, asked)) exposed.add(name);
  }
  const turns: ToolTurn[] = [];
  const runner = createToolRunner({ tools, context, exposed, onCalls: callbacks.onCalls });
  const computer = tools.some(isComputerTool) ? accessGuidance(context.settings.agent, context) : "";
  const screen = tools.some((t) => t.group === "mac" || t.controlsComputer);
  const system = [request.system, TOOL_GUIDANCE, computer, screen ? COMPUTER_GUIDANCE : ""].filter(Boolean).join("\n\n");
  // Tasks in apps take more steps than questions do.
  const maxSteps = screen ? Math.max(options.maxSteps, 30) : options.maxSteps;

  // Verify before "done" (runner.unseen: the latest screen action nobody has looked at since), and
  // whether the model was already sent back once to check it.
  let nudged = false;
  // A call to a tool that doesn't exist was answered once already.
  let corrected = false;

  for (let step = 0; step <= maxSteps; step++) {
    const last = step === maxSteps;
    // The last step keeps the same tool list (Claude binds its thinking to it) and says "answer now".
    const schemas: ToolSchema[] = [
      ...tools.filter((t) => exposed.has(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
      ...(discovery ? [findToolsSchema] : []),
    ];
    let asked: Extract<StreamEvent, { type: "tool_calls" }> | null = null;
    let invented: Extract<StreamEvent, { type: "bad_call" }> | null = null;
    // After an action on screen nobody has looked at, an answer now may be sent back for one look:
    // hold this step's text until it's clear, so a premature "done" never shows.
    const holdText = runner.unseen !== null && !nudged && !last;
    const held: StreamEvent[] = [];
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
        else if (event.type === "bad_call") invented = event;
        else if (holdText && (event.type === "text" || event.type === "reasoning")) held.push(event);
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
    if (invented && (!asked || !asked.calls.length)) {
      // One of this bot's tools that just wasn't listed this step (local models see a short list): use it.
      const unlisted = tools.find((t) => t.name === invented?.name);
      const call = unlisted && !last ? parseBareCall(invented.text, [unlisted]) : undefined;
      if (unlisted && call) {
        exposed.add(unlisted.name);
        asked = { type: "tool_calls", calls: [call], raw: {}, text: invented.before };
        invented = null;
      }
    }
    if (invented && (!asked || !asked.calls.length)) {
      if (!corrected && !last) {
        // Tell the model once, as the answer to the call it made up, and let it try again.
        corrected = true;
        const id = `invented_${crypto.randomUUID().slice(0, 8)}`;
        turns.push({
          raw: {},
          text: invented.before,
          calls: [{ id, name: invented.name, args: {} }],
          results: [{ id, name: invented.name, content: `Error: there's no tool called "${invented.name}". Use one of your tools, or answer the user in plain words.`, isError: true }],
        });
        continue;
      }
      callbacks.onEvent({ type: "text", text: invented.text });
    }
    if (!asked || !asked.calls.length) {
      const answer = held.map((e) => (e.type === "text" ? e.text : "")).join("");
      const unseen = runner.unseen;
      if (holdText && unseen && turns.length && claimsSuccess(answer)) {
        // Ask for one look first: the note rides on the last result, and this answer is dropped.
        nudged = true;
        const previous = turns[turns.length - 1];
        const results = previous.results.slice();
        const end = results.length - 1;
        results[end] = { ...results[end], content: `${results[end].content}\n\n${verifyNote(unseen)}` };
        turns[turns.length - 1] = { ...previous, results };
        continue;
      }
      held.forEach(callbacks.onEvent);
      return;
    }
    held.forEach(callbacks.onEvent);
    if (asked.text) callbacks.onEvent({ type: "text", text: "\n\n" });
    if (options.hold) await options.hold;

    turns.push({ raw: asked.raw, text: asked.text, calls: asked.calls, results: await runner.runStep(asked.calls) });
  }
}

export type ToolRunner = {
  /** Runs one step's calls, results in the model's order (see runStep below). */
  runStep(calls: ToolCall[]): Promise<ToolTurn["results"]>;
  /** One call on its own: the user's OK if it needs one, then the tool. `signal` ends just this call. */
  run(call: ToolCall, signal?: AbortSignal): Promise<ToolTurn["results"][number]>;
  /** The latest action on screen nobody has looked at since (verify before "done"). */
  readonly unseen: string | null;
};

/**
 * Runs a model's tool calls: the approval (a card, or asked aloud in voice mode), the tool with its
 * time limit, and the records the chat shows. Used by every turn with tools, and by Gemini Live.
 */
export function createToolRunner(options: {
  tools: AgentTool[];
  context: ToolContext;
  onCalls: (calls: ToolCallRecord[]) => void;
  /** Tools listed to the model so far (find_tools adds to it). Default: all of them. */
  exposed?: Set<string>;
}): ToolRunner {
  const { tools, context } = options;
  const exposed = options.exposed ?? new Set(tools.map((t) => t.name));
  const records: ToolCallRecord[] = [];
  const reusable = new Map<string, Promise<ToolTurn["results"][number]>>();
  let unseen: string | null = null;

  const publish = () => options.onCalls(records.map((r) => ({ ...r })));
  const update = (id: string, patch: Partial<ToolCallRecord>) => {
    const record = records.find((r) => r.id === id);
    if (record) Object.assign(record, patch);
    publish();
  };

  return {
    runStep,
    run: (call, signal) => runCall(call, signal ? { ...context, signal: AbortSignal.any([context.signal, signal]) } : context),
    get unseen() {
      return unseen;
    },
  };

  /**
   * Runs one step's calls, results in the model's order. Neighbouring calls that only read and
   * never ask (searches, page reads) run at the same time; anything that may ask for approval,
   * changes something or touches the computer runs on its own, in order.
   */
  async function runStep(calls: ToolCall[]): Promise<ToolTurn["results"]> {
    const results: ToolTurn["results"] = [];
    for (let i = 0; i < calls.length; ) {
      let end = i;
      while (end < calls.length && runsAlongside(calls[end])) end++;
      if (end - i > 1) {
        results.push(...(await Promise.all(calls.slice(i, end).map(runOnce))));
        i = end;
      } else {
        results.push(await runOnce(calls[i]));
        i++;
      }
    }
    return results;
  }

  function runsAlongside(call: ToolCall): boolean {
    const tool = getTool(call.name);
    if (!tool || !tools.includes(tool)) return false;
    const risk = tool.riskFor?.(call.args) ?? tool.risk;
    if (risk !== "read" || isComputerTool(tool) || tool.kind === "computer") return false;
    return gate(tool, call, context).outcome === "allow";
  }

  /**
   * Same-turn reuse: an identical call to a pure lookup (same search, same page) gets the earlier
   * result instead of fetching again. Never for the screen or apps, whose state changes.
   */
  function runOnce(call: ToolCall): Promise<ToolTurn["results"][number]> {
    if (!REUSABLE.has(call.name)) return runCall(call);
    const key = `${call.name}:${stableJson(call.args)}`;
    const earlier = reusable.get(key);
    if (!earlier) {
      const running = runCall(call);
      reusable.set(key, running);
      // Errors aren't reused: trying again may work.
      void running.then((r) => r.isError && reusable.delete(key));
      return running;
    }
    // Listed straight away, so the chat shows calls in the order the model made them.
    const record: ToolCallRecord = { id: call.id, name: call.name, args: call.args, status: "running", startedAt: Date.now() };
    records.push(record);
    publish();
    return earlier.then((r) => {
      if (r.isError) {
        records.splice(records.indexOf(record), 1);
        return runCall(call);
      }
      update(call.id, { status: "done", result: "Same as an earlier call in this answer (result reused).", ms: 0 });
      const { image: _image, ...rest } = r;
      return { ...rest, id: call.id, content: `${r.content}\n\n[Same call as earlier in this answer: the earlier result is repeated here.]` };
    });
  }

  async function runCall(call: ToolCall, context = options.context): Promise<ToolTurn["results"][number]> {
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
    // Native calls get the same repair as calls written as text (the required argument misnamed).
    const fitted = fitArgs(call.args ?? {}, tool.parameters);
    if (fitted !== call.args) {
      call = { ...call, args: fitted };
      record.args = fitted;
    }

    const forceAsk = await typingIntoTerminal(call, context);
    let verdict = gate(tool, call, context, forceAsk);
    if (reviewScope(context.settings.agent.reviewer, tool, call, verdict, context, forceAsk)) {
      update(call.id, { result: "The AI reviewer is checking this…" });
      const review = await reviewCall(tool, call, verdict, context, callSummary(tool, call), forceAsk);
      verdict = applyReview(verdict, review, tool, call, context);
      update(call.id, { result: undefined, ...(review ? { review } : {}) });
    }
    // The agent log: who did what, with what, why it was allowed, and what came back.
    const log = (outcome: ActivityEntry["outcome"], summary: string, extra: Partial<ActivityEntry> = {}) =>
      void logActivity({
        bot: context.bot.name,
        botId: context.bot.id,
        tool: call.name,
        summary,
        outcome,
        conversationId: context.conversationId,
        args: redactArgs(call.args ?? {}),
        ...(context.taint?.sources.size ? { taint: [...context.taint.sources].join("; ").slice(0, 200) } : {}),
        ...extra,
      });
    if (verdict.outcome === "deny") {
      update(call.id, { status: "denied", result: verdict.refusal });
      log("denied", verdict.reason, { decision: verdict.reason });
      return { id: call.id, name: call.name, content: verdict.refusal, isError: true };
    }
    if (verdict.outcome === "ask" && context.unattended && !context.askAloud) {
      const content =
        "Refused: this needs the user's approval, and approval cards can't be shown in voice mode. Don't retry it. " +
        "Tell the user what you wanted to do, and that they can do it from the chat, or allow it under Settings → Tools & safety → Computer access.";
      update(call.id, { status: "denied", result: "Needs approval (not possible in voice mode)" });
      log("denied", verdict.summary, { decision: `needed approval (${verdict.reason}), and nobody could answer` });
      return { id: call.id, name: call.name, content, isError: true };
    }
    let decision: Decision | undefined;
    let unanswered = false;
    if (verdict.outcome === "ask") {
      update(call.id, {
        status: "awaiting",
        approval: { summary: verdict.summary, detail: verdict.detail, reason: verdict.reason, kind: verdict.kind, allowAlways: verdict.allowAlways },
      });
      if (context.unattended && context.askAloud) {
        // Voice mode: asked aloud; the card in the chat answers too, whichever comes first.
        const settle = new AbortController();
        const fromCard = waitForDecision(call.id, settle.signal);
        const aloud = context
          .askAloud({ summary: askAloudText(call), detail: askAloudDetail(call), reason: verdict.reason, signal: settle.signal })
          .then((answer): Decision => {
            unanswered = answer === "timeout";
            return answer === "allow" ? "once" : "deny";
          });
        decision = await Promise.race([fromCard, aloud, abortedAsDeny(context.signal)]);
        if (isPending(call.id)) decide(tool, call, decision);
        settle.abort();
      } else {
        decision = await waitForDecision(call.id, context.signal);
      }
      if (decision === "deny" && unanswered) {
        // Asked aloud and nobody answered: not the user saying no, so don't tell them they did.
        const content =
          "Not run: you asked the user aloud and heard no answer in time (silence isn't a yes). Say in a few words that you didn't do it " +
          "because you didn't hear a yes, and that they can say yes to try again.";
        update(call.id, { status: "denied", result: "No answer in time", approval: undefined });
        log("denied", verdict.summary, { decision: `asked aloud (${verdict.reason}); no answer in time` });
        return { id: call.id, name: call.name, content, isError: true };
      }
      if (decision === "deny") {
        const content = "The user declined this action. Don't retry it; tell them what you were trying to do or suggest another way.";
        update(call.id, { status: "denied", result: "Declined", approval: undefined });
        log("denied", verdict.summary, { decision: `asked (${verdict.reason}); you declined` });
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
          (callSignal) => tool.run(call.args, { ...context, signal: callSignal, callId: call.id, progress: (text) => update(call.id, { result: text }) }),
          tool.timeoutMs ?? 120_000,
          context.signal,
        ),
      );
      unseen = unseenAction(unseen, tool, call.args, value.observed);
      let content = value.content ?? "";
      if (content.length > RESULT_LIMIT) content = `${content.slice(0, RESULT_LIMIT)}\n\n[…cut: ${content.length - RESULT_LIMIT} more characters]`;
      if (value.untrustedSource) content = markUntrusted(content, value.untrustedSource);
      if (value.untrustedSource && context.taint && taints(tool, call)) context.taint.sources.add(value.untrustedSource.slice(0, 80));
      // Command output and this computer's files aren't outside content, but the AI reviewer stays out after them.
      else if (context.taint && (tool.kind === "shell" || (tool.group === "local" && (tool.riskFor?.(call.args) ?? tool.risk) === "read"))) context.taint.local = true;
      update(call.id, { status: "done", result: preview(value.content ?? ""), display: value.display, ms: Date.now() - started });
      log("done", verdict.outcome === "ask" ? verdict.summary : summariseArgs(call), {
        ms: Date.now() - started,
        decision: allowedBecause(verdict, decision),
        result: resultPreview(value.content ?? ""),
      });
      return { id: call.id, name: call.name, content, ...(value.image ? { image: value.image } : {}) };
    } catch (error) {
      const content = `Error: ${(error as Error).message}`;
      update(call.id, { status: "error", result: content, ms: Date.now() - started });
      log("error", summariseArgs(call), { ms: Date.now() - started, decision: allowedBecause(verdict, decision), result: resultPreview(content) });
      return { id: call.id, name: call.name, content, isError: true };
    }
  }
}

/**
 * Whether a result's outside content should make the rest of the turn ask before commands and file
 * changes. What's on the screen or in a web page counts (someone else's message, a page): screen
 * actions still run under Full access (they aren't taint-sensitive), but commands, file changes,
 * scripts and routines ask afterwards. The workspace's own files and plain command output don't
 * count; a command that fetched from the web does.
 */
export function taints(tool: AgentTool, call: ToolCall): boolean {
  // Built-in screen control, and connectors that look at the screen (Peekaboo, Ghost OS…).
  if (tool.group === "mac" || tool.controlsComputer) return true;
  if (tool.name === "read_file" || tool.name === "list_files") return !insideWorkspace(String(call.args.path ?? ""));
  if (tool.name === "run_command") return /\b(curl|wget|https?:\/\/|git\s+(clone|pull|fetch)|npx|pip3?\s+download)\b/i.test(String(call.args.command ?? ""));
  return true;
}

const TYPING = new Set(["mac_type", "mac_key", "mac_set_text", "mac_press"]);

/** Typing or pressing keys into a terminal is as good as running a command: always ask. */
export async function typingIntoTerminal(call: ToolCall, _context: ToolContext): Promise<string | undefined> {
  if (!TYPING.has(call.name)) return undefined;
  const reason = "this types into a terminal or script app, which runs it like a command";
  const named = String(call.args.app ?? "").trim();
  if (named) return isTerminalApp(named) ? reason : undefined;
  try {
    const front = await desktopInvoke<{ name?: string; bundleId?: string }>("adt:mac:frontmost");
    return TERMINAL_APPS.test(`${front?.name ?? ""} ${front?.bundleId ?? ""}`) ? reason : undefined;
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

/** Why a call that ran was allowed, for the agent log. */
function allowedBecause(verdict: GateResult, decision: Decision | undefined): string {
  if (verdict.outcome !== "ask") return verdict.reason;
  return decision === "always" ? `asked (${verdict.reason}); you chose Always allow` : `asked (${verdict.reason}); you allowed it`;
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
