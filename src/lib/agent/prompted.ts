// Prompt-and-parse tool calling for models without native tool schemas (many local models).
// Adapted from OpenBOT's promptedTools.ts (MIT, Copyright (c) 2026 OpenBOT contributors; see
// ./vendor/openbot/LICENSE): same delimited-call protocol and schema-filtered arguments, plus
// streaming hold-back so the markup never flashes in the chat.
import { parseObjectLoose } from "./vendor/openbot/lenientJson";
import type { ToolCall, ToolSchema } from "./vendor/openbot/types";

/** Hermes/Qwen-style tags: many local models were trained on exactly this shape. */
export const OPEN = "<tool_call>";
export const CLOSE = "</tool_call>";

export function promptedProtocol(tools: ToolSchema[]): string {
  const catalog = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return [
    "# Tools",
    "You can use tools. The app runs them for you and shows you the result.",
    "To use a tool, reply with ONLY one call in exactly this form, and nothing else:",
    `${OPEN}{"name": "tool_name", "arguments": {"param": "value"}}${CLOSE}`,
    "Use only the tools listed below, with valid JSON arguments. One call per reply. After the result arrives,",
    "either call another tool or answer the user normally (without any tool markup).",
    `Available tools: ${JSON.stringify(catalog)}`,
  ].join("\n");
}

/** Extracts at most one delimited call; unknown or malformed calls stay as text. */
export function parsePromptedCall(text: string, tools: ToolSchema[]): { text: string; call?: ToolCall } {
  const start = text.indexOf(OPEN);
  if (start < 0) return { text };
  const endAt = text.indexOf(CLOSE, start + OPEN.length);
  const raw = text.slice(start + OPEN.length, endAt < 0 ? undefined : endAt).trim();
  const record = parseCallJson(raw);
  if (!record) return { text };
  const call = callFromRecord(record, tools);
  if (!call) return { text };
  const before = text.slice(0, start).trim();
  const after = endAt < 0 ? "" : text.slice(endAt + CLOSE.length).trim();
  return { text: [before, after].filter(Boolean).join("\n"), call };
}

/** Slips small models make in calls, repaired in turn (each on top of the ones before). */
const REPAIRS: ((text: string) => string)[] = [
  // A list wrapped in quotes: "days": "["mon"]".
  (text) => text.replace(/"\[([^[\]]*)\]"/g, "[$1]"),
  // Quotes escaped as if inside a string: "parameters\":{\"x\":1}.
  (text) => text.replace(/\\"/g, '"'),
  // A link without quotes: "url": https://example.com.
  (text) => text.replace(/:\s*(https?:\/\/[^\s"',}\]]+)/g, ':"$1"'),
];

/** Lenient parse, then the repairs above. */
function parseCallJson(text: string): Record<string, unknown> | null {
  let current = text;
  const parsed = parseObjectLoose(current);
  if (parsed) return parsed;
  for (const repair of REPAIRS) {
    const next = repair(current);
    if (next === current) continue;
    current = next;
    const repaired = parseObjectLoose(current);
    if (repaired) return repaired;
  }
  return null;
}

/**
 * The one required argument given under another name ({"query": "https://…"} for read_url's "url"),
 * a common small-model slip: renamed when it's the only unknown key and the only one missing.
 */
export function fitArgs(args: Record<string, unknown>, parameters: ToolSchema["parameters"]): Record<string, unknown> {
  const allowed = parameters.properties ?? {};
  const missing = (parameters.required ?? []).filter((k) => !Object.prototype.hasOwnProperty.call(args, k));
  const stray = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(allowed, k));
  if (missing.length !== 1 || stray.length !== 1) return args;
  const { [stray[0]]: value, ...rest } = args;
  return { ...rest, [missing[0]]: value };
}

/**
 * {"name": "...", "arguments"|"args"|"parameters": {...}} → a call, if it names one of the tools.
 * Also the OpenAI-style shapes models copy: {"type": "function", "name": …} and {"function": {"name": …}}.
 */
function callFromRecord(record: Record<string, unknown>, tools: ToolSchema[]): ToolCall | undefined {
  const fn = record.function;
  const inner = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : record;
  const name = typeof inner.name === "string" ? inner.name : typeof record.tool === "string" ? record.tool : "";
  const schema = tools.find((t) => t.name === name);
  if (!schema) return undefined;
  const nested = inner.arguments ?? inner.args ?? inner.parameters;
  const candidate =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : typeof nested === "string"
        ? (parseObjectLoose(nested) ?? {})
        : Object.fromEntries(Object.entries(inner).filter(([k]) => !["name", "tool", "type", "function"].includes(k)));
  // Small models invent keys; only pass what the tool's schema advertises.
  const allowed = schema.parameters.properties ?? {};
  const args = Object.fromEntries(Object.entries(fitArgs(candidate, schema.parameters)).filter(([k]) => Object.prototype.hasOwnProperty.call(allowed, k)));
  return { id: `prompted_${crypto.randomUUID().slice(0, 12)}`, name, args };
}

/**
 * The name of a tool a call-shaped object asks for that isn't one of the tools ({"name": "write_order",
 * "parameters": {…}}), or "". Plain JSON in an answer ({"name": "Bob", "age": 3}) isn't call-shaped.
 */
function inventedTool(record: Record<string, unknown>, tools: ToolSchema[]): string {
  const fn = record.function;
  const inner = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : record;
  const name = typeof inner.name === "string" ? inner.name.trim() : "";
  const callShaped = inner !== record || record.type === "function" || ["parameters", "arguments", "args"].some((k) => k in inner);
  return name && callShaped && /^[\w.-]{1,64}$/.test(name) && !tools.some((t) => t.name === name) ? name : "";
}

/** How a bare JSON call starts (whitespace removed): Llama 3.x writes calls these ways when native parsing misses. */
const CALL_STARTS = ['{"name":', '{"type":"function","name":', '{"type":"function","function":{"name":', '{"function":{"name":'];

/** Whether text from a "{" on is the start of a call ("yes"), could still grow into one ("maybe"), or isn't ("no"). */
function callStart(text: string): "yes" | "maybe" | "no" {
  const squashed = text.slice(0, 120).replace(/\s+/g, "");
  if (CALL_STARTS.some((start) => squashed.startsWith(start))) return "yes";
  return CALL_STARTS.some((start) => start.startsWith(squashed)) ? "maybe" : "no";
}

/**
 * Some local models (notably Llama 3.x behind Ollama) sometimes print a tool call as plain JSON
 * instead of using the native tool_calls field. This holds back text from a call's opening
 * (`{"name":`, `{"type":"function",…`, maybe in a ``` fence) on, and at the end turns it into a
 * real call when it names one of the tools; otherwise the text is released.
 */
export class BareCallFilter {
  private full = "";
  private emitted = 0;
  private start = -1;

  push(text: string): string {
    this.full += text;
    if (this.start >= 0) return "";
    const rest = this.full.slice(this.emitted);
    for (let i = rest.indexOf("{"); i >= 0; i = rest.indexOf("{", i + 1)) {
      const state = callStart(rest.slice(i));
      if (state === "no") continue;
      // A ``` or ```json fence just before belongs to the call.
      const fence = /```(?:json)?\s*$/.exec(rest.slice(0, i));
      const at = fence ? fence.index : i;
      const out = rest.slice(0, at);
      this.emitted += out.length;
      if (state === "yes") this.start = this.emitted;
      // "maybe": held back from here until it's clear.
      return out;
    }
    // Hold back what could still become an opening fence ("`", "```js"…).
    const fenceTail = /`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?\s*$/.exec(rest);
    const out = fenceTail ? rest.slice(0, fenceTail.index) : rest;
    this.emitted += out.length;
    return out;
  }

  /**
   * The call (if the held text is one), plus any held text that should be shown after all.
   * `unknown`: the text is a call to a tool that doesn't exist (small models invent them).
   */
  finish(tools: ToolSchema[]): { tail: string; call?: ToolCall; before: string; unknown?: string } {
    const held = this.full.slice(this.emitted);
    if (this.start >= 0) {
      const body = held.replace(/^```(?:json)?/, "").replace(/```\s*$/, "");
      // A wrapper the model didn't close ({"type": "function", "function": {"name": …}} or): the call inside it.
      const inner = body.search(/\{\s*"name"\s*:/);
      const record = parseCallJson(body) ?? (inner > 0 ? parseCallJson(body.slice(inner)) : null);
      const call = record ? callFromRecord(record, tools) : undefined;
      if (call) return { tail: "", call, before: this.full.slice(0, this.start).trim() };
      const name = record ? inventedTool(record, tools) : "";
      if (name) return { tail: held, before: this.full.slice(0, this.start).trim(), unknown: name };
    }
    return { tail: held, before: this.full };
  }
}

/** A call printed as text, read against these tools (e.g. a tool that exists but wasn't listed this step). */
export function parseBareCall(text: string, tools: ToolSchema[]): ToolCall | undefined {
  const filter = new BareCallFilter();
  filter.push(text);
  return filter.finish(tools).call;
}

/**
 * Streams text through, except anything from the opening tag onward (held until the end) and a
 * trailing fragment that might be the start of the tag ("<tool").
 */
export class PromptedFilter {
  private full = "";
  private emitted = 0;
  private capturing = false;

  push(text: string): string {
    this.full += text;
    if (this.capturing) return "";
    const at = this.full.indexOf(OPEN, this.emitted);
    if (at >= 0) {
      this.capturing = true;
      const out = this.full.slice(this.emitted, at);
      this.emitted = at;
      return out;
    }
    // Hold back a suffix that could still become "<tool_call>".
    let hold = 0;
    for (let n = Math.min(OPEN.length - 1, this.full.length - this.emitted); n > 0; n--) {
      if (OPEN.startsWith(this.full.slice(this.full.length - n))) {
        hold = n;
        break;
      }
    }
    const out = this.full.slice(this.emitted, this.full.length - hold);
    this.emitted = this.full.length - hold;
    return out;
  }

  /** At the end of the stream: the call (if any), plus any text that was held back but isn't a call. */
  finish(tools: ToolSchema[]): { tail: string; call?: ToolCall; text: string } {
    const parsed = parsePromptedCall(this.full, tools);
    if (parsed.call) return { tail: "", call: parsed.call, text: this.full };
    const tail = this.full.slice(this.emitted);
    return { tail, text: this.full };
  }
}

/** How a finished tool call and its result are replayed to a model that uses the text protocol. */
export function promptedResult(name: string, content: string): string {
  return `<tool_result name="${name}">\n${content}\n</tool_result>`;
}
