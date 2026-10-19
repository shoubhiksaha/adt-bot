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
  const record = parseObjectLoose(raw);
  if (!record) return { text };
  const call = callFromRecord(record, tools);
  if (!call) return { text };
  const before = text.slice(0, start).trim();
  const after = endAt < 0 ? "" : text.slice(endAt + CLOSE.length).trim();
  return { text: [before, after].filter(Boolean).join("\n"), call };
}

/** {"name": "...", "arguments"|"args"|"parameters": {...}} → a call, if it names one of the tools. */
function callFromRecord(record: Record<string, unknown>, tools: ToolSchema[]): ToolCall | undefined {
  const name = typeof record.name === "string" ? record.name : typeof record.tool === "string" ? record.tool : "";
  const schema = tools.find((t) => t.name === name);
  if (!schema) return undefined;
  const nested = record.arguments ?? record.args ?? record.parameters;
  const candidate =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : typeof nested === "string"
        ? (parseObjectLoose(nested) ?? {})
        : Object.fromEntries(Object.entries(record).filter(([k]) => !["name", "tool"].includes(k)));
  // Small models invent keys; only pass what the tool's schema advertises.
  const allowed = schema.parameters.properties ?? {};
  const args = Object.fromEntries(Object.entries(candidate).filter(([k]) => Object.prototype.hasOwnProperty.call(allowed, k)));
  return { id: `prompted_${crypto.randomUUID().slice(0, 12)}`, name, args };
}

/** Where a bare JSON call starts: `{"name":` (Llama 3.x writes calls this way when native parsing misses). */
const BARE_START = /(?:```(?:json)?\s*)?\{\s*"name"\s*:/;

/**
 * Some local models (notably Llama 3.x behind Ollama) sometimes print a tool call as plain JSON
 * instead of using the native tool_calls field. This holds back text from `{"name":` on, and at the
 * end turns it into a real call when it names one of the tools; otherwise the text is released.
 */
export class BareCallFilter {
  private full = "";
  private emitted = 0;
  private start = -1;

  push(text: string): string {
    this.full += text;
    if (this.start >= 0) return "";
    const rest = this.full.slice(this.emitted);
    const match = BARE_START.exec(rest);
    if (match) {
      this.start = this.emitted + match.index;
      const out = this.full.slice(this.emitted, this.start);
      this.emitted = this.start;
      return out;
    }
    // Hold back a tail that could still grow into `{"name":` (or an opening ``` fence).
    const tail = rest.search(/(?:`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?\s*)?(?:\{\s*(?:"(?:n(?:a(?:m(?:e(?:"\s*)?)?)?)?)?)?)?$/);
    const hold = tail >= 0 && tail < rest.length ? rest.length - tail : 0;
    const out = rest.slice(0, rest.length - hold);
    this.emitted += out.length;
    return out;
  }

  /** The call (if the held text is one), plus any held text that should be shown after all. */
  finish(tools: ToolSchema[]): { tail: string; call?: ToolCall; before: string } {
    const held = this.full.slice(this.emitted);
    if (this.start >= 0) {
      const record = parseObjectLoose(held.replace(/^```(?:json)?/, "").replace(/```\s*$/, ""));
      const call = record ? callFromRecord(record, tools) : undefined;
      if (call) return { tail: "", call, before: this.full.slice(0, this.start).trim() };
    }
    return { tail: held, before: this.full };
  }
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
