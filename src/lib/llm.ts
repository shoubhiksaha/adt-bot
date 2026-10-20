import { BareCallFilter, OPEN as PROMPTED_OPEN, PromptedFilter, promptedProtocol, promptedResult } from "./agent/prompted";
import { ToolCallAccumulator, parseToolArgs } from "./agent/vendor/openbot/toolCallAccumulator";
import { cliModels, streamCliChat } from "./cli-agents/provider";
import type { ToolCall, ToolSchema } from "./agent/vendor/openbot/types";
import { guessVision } from "./providers";
import { providerFetch, type FetchInit } from "./transport";
import type { Message, ModelInfo, ProviderConfig, Source, ThinkingLevel } from "./types";

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Web pages the provider's own search used (cumulative list). */
  | { type: "sources"; sources: Source[] }
  | { type: "status"; text: string }
  /** The model asked for tools. `raw` is its turn in the provider's own format, replayed on the next step. */
  | { type: "tool_calls"; calls: ToolCall[]; raw: unknown; text: string };

/** One completed step of a tool loop: what the model said/asked, and what the tools answered. */
export type ToolTurn = {
  raw: unknown;
  text: string;
  calls: ToolCall[];
  results: { id: string; name: string; content: string; isError?: boolean; image?: ToolImage }[];
};

/** An image a tool returned for the model to look at, e.g. a screenshot (base64 without the data: prefix). */
export type ToolImage = { mediaType: string; data: string };

/** Only the newest tool images are replayed (they're large); older ones are replaced by a note. */
const TOOL_IMAGES_KEPT = 2;

/**
 * Tool images to send this step, by call id: only to models that can see images. Claude gets every
 * one, unchanged: its thinking blocks are bound to the exact conversation before them, so swapping
 * an older screenshot for a note made the next request fail ("400 … Invalid `signature` in
 * `thinking` block"). Other providers get the newest few.
 */
function toolImages(req: ChatRequest): Map<string, ToolImage> {
  const kept = new Map<string, ToolImage>();
  const info = req.provider.models.find((m) => m.id === req.model);
  if (req.provider.kind === "openai" && !(info?.vision ?? guessVision(req.model))) return kept;
  const withImages = (req.toolTurns ?? []).flatMap((t) => t.results).filter((r) => r.image);
  for (const r of req.provider.kind === "anthropic" ? withImages : withImages.slice(-TOOL_IMAGES_KEPT)) kept.set(r.id, r.image!);
  return kept;
}

/** A tool result's text, saying where its image is (or that it was left out). */
function resultText(r: ToolTurn["results"][number], images: Map<string, ToolImage>, attached: string): string {
  const text = r.content || "(empty)";
  if (!r.image) return text;
  const note = images.has(r.id) ? attached : "[This tool's image isn't included: only the latest images are kept, and only for models that can view images.]";
  return note ? `${text}\n\n${note}` : text;
}

const imageBlock = (image: ToolImage) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
const imagePart = (image: ToolImage) => ({ inlineData: { mimeType: image.mediaType, data: image.data } });
const imageUrlPart = (image: ToolImage) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } });

/**
 * Providers whose API can search the web itself: Gemini (Google Search grounding), Anthropic
 * (server-side web search tool) and OpenRouter (web plugin). Perplexity always searches.
 */
export function supportsNativeSearch(provider: ProviderConfig): boolean {
  return (
    provider.kind === "gemini" ||
    provider.presetId === "anthropic" ||
    provider.presetId === "openrouter" ||
    provider.presetId === "perplexity"
  );
}

export type ChatRequest = {
  provider: ProviderConfig;
  model: string;
  system: string;
  messages: Message[];
  temperature: number | null;
  thinking: ThinkingLevel;
  useProxy: boolean;
  /** Ask the provider to search the web itself (see supportsNativeSearch). */
  nativeSearch?: boolean;
  /** Favour speed (voice conversations): lighter reasoning on models that reason by default. */
  fast?: boolean;
  /** Tools the model may call this step, and the steps of the current turn so far. */
  tools?: ToolSchema[];
  toolTurns?: ToolTurn[];
  /** "native" uses the provider's tool calling; "prompted" a text protocol for models without it. */
  toolMode?: "native" | "prompted";
  /** Last step of a tool turn: no more tool calls; this note tells the model to answer now. */
  finalNote?: string;
  signal?: AbortSignal;
};

/** Stream a reply from any supported provider as text and reasoning deltas. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  if (req.provider.kind === "cli") return yield* streamCliChat(req);
  const { url, init } = buildRequest(req);
  init.headers = withCustomHeaders(init.headers, req.provider.headers);
  const res = await providerFetch(url, { ...init, signal: req.signal }, req.useProxy);
  if (!res.ok) throw new Error(await describeHttpError(res));

  const parser = createParser(req.provider, req);
  const prompted = req.toolMode === "prompted" && req.tools?.length ? new PromptedFilter() : null;
  // OpenAI-compatible servers (Ollama, LM Studio…) sometimes hand back a call as plain JSON text.
  const bare = !prompted && req.tools?.length && req.provider.kind === "openai" ? new BareCallFilter() : null;
  let nativeCalls = false;
  const route = function* (event: StreamEvent): Generator<StreamEvent> {
    if (prompted && event.type === "text") {
      const visible = prompted.push(event.text);
      if (visible) yield { type: "text", text: visible };
    } else if (bare && event.type === "text") {
      const visible = bare.push(event.text);
      if (visible) yield { type: "text", text: visible };
    } else {
      if (event.type === "tool_calls") nativeCalls = true;
      yield event;
    }
  };
  for await (const data of sseData(res)) {
    if (data === "[DONE]") break;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error || json.type === "error") throw new Error(errorText(json.error ?? json));
    for (const event of parser.parse(json)) yield* route(event);
  }
  for (const event of parser.finish()) yield* route(event);
  if (prompted && req.tools) {
    const { tail, call, text } = prompted.finish(req.tools);
    if (tail) yield { type: "text", text: tail };
    if (call) yield { type: "tool_calls", calls: [call], raw: text, text: text.slice(0, text.indexOf(PROMPTED_OPEN)).trim() };
  }
  if (bare && req.tools) {
    const { tail, call, before } = bare.finish(req.tools);
    if (call && !nativeCalls) yield { type: "tool_calls", calls: [call], raw: {}, text: before };
    else if (tail) yield { type: "text", text: tail };
  }
}

/** Gemini accepts an OpenAPI subset: drop JSON-Schema keywords it rejects. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (["additionalProperties", "$schema", "default", "examples", "$defs", "definitions", "$ref", "const"].includes(key)) continue;
    out[key] = geminiSchema(value);
  }
  return out;
}

/** Runs a short request to completion and returns only the answer text (titles, search queries). */
export async function complete(
  req: Omit<ChatRequest, "temperature" | "thinking"> & Partial<Pick<ChatRequest, "temperature" | "thinking">>,
): Promise<string> {
  let text = "";
  for await (const event of streamChat({ temperature: null, thinking: "off", ...req })) {
    if (event.type === "text") text += event.text;
  }
  return splitThink(text).text.trim();
}

/** Images only travel on user turns; assistant-generated images stay in the chat UI. */
function imagesOf(m: Message) {
  return m.role === "user" ? (m.attachments ?? []).flatMap((a) => (a.kind === "image" ? [a] : [])) : [];
}

/** Message text with attached documents inlined, so every provider (and local models) can read them. */
export function messageText(m: Message): string {
  const text = stripThink(m.content);
  const files = (m.attachments ?? []).flatMap((a) => (a.kind === "file" ? [a] : []));
  if (!files.length) return text || (imagesOf(m).length ? "(image)" : m.role === "assistant" ? "(no text)" : "");
  const blocks = files.map(
    (f) => `<file name="${f.name}"${f.truncated ? ' note="truncated to fit"' : ""}>\n${f.text}\n</file>`,
  );
  return `${blocks.join("\n\n")}\n\n${text}`.trim();
}

function buildRequest(original: ChatRequest): { url: string; init: FetchInit } {
  const { provider } = original;
  // Claude (native tools) keeps its tools and system prompt unchanged on the last step, because its
  // thinking blocks are bound to them; it gets tool_choice "none" and the note as an appended
  // message instead. Elsewhere the step simply has no tools and the note joins the system prompt.
  const claudeFinal = Boolean(original.finalNote) && provider.kind === "anthropic" && original.toolMode !== "prompted";
  const req: ChatRequest =
    original.finalNote && !claudeFinal ? { ...original, tools: [], system: `${original.system}\n\n${original.finalNote}` } : original;
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const history = req.messages.filter((m) => !m.error && (m.content || m.attachments?.length));
  const images = toolImages(req);
  // Text-protocol steps are replayed by applyPrompted instead.
  const nativeTurns = req.toolMode === "prompted" ? [] : (req.toolTurns ?? []);

  if (provider.kind === "anthropic") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    const legacy = isLegacyClaude(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: legacy ? 32000 : 64000,
      stream: true,
      messages: history.map((m) => ({
        role: m.role,
        content: [
          ...imagesOf(m).map((a) => {
            const { mediaType, data } = splitDataUrl(a.dataUrl);
            return { type: "image", source: { type: "base64", media_type: mediaType, data } };
          }),
          { type: "text", text: messageText(m) },
        ],
      })),
    };
    if (req.system) body.system = req.system;
    if (legacy) {
      // Claude 4.5 and older: fixed thinking budget, and sampling params are still accepted.
      if (req.thinking !== "off") {
        body.thinking = { type: "enabled", budget_tokens: { low: 2048, medium: 8192, high: 24000 }[req.thinking] };
      } else if (req.temperature !== null) {
        body.temperature = req.temperature;
      }
    } else if (req.thinking !== "off") {
      // Current Claude models: adaptive thinking steered by effort; temperature is rejected.
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: req.thinking };
    } else if (req.fast) {
      // Current Claude models think by default; low effort answers much sooner.
      body.output_config = { effort: "low" };
    }
    if (provider.presetId === "anthropic") {
      // Cache the system prompt and history so long chats and knowledge files are cheaper and faster.
      body.cache_control = { type: "ephemeral" };
    }
    if (provider.presetId === "anthropic" && !legacy && nativeTurns.some((t) => Array.isArray(t.raw) && t.raw.some((b: { type?: string }) => b?.type === "thinking"))) {
      // Replayed tool steps carry thinking blocks bound to the conversation before them. History is
      // replayed unchanged, but if anything before a block ever differs, drop that block for this
      // request instead of failing it with a 400.
      headers["anthropic-beta"] = "thinking-binding-controls-2026-08-01";
      const thinking = (body.thinking as Record<string, unknown> | undefined) ?? (thinksByDefault(req.model) ? { type: "adaptive" } : undefined);
      if (thinking) body.thinking = { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } };
    }
    const anthropicTools: unknown[] = [];
    if (req.nativeSearch) {
      // Server-side web search; the dynamic-filtering version needs Claude 4.6 or newer.
      anthropicTools.push({ type: legacy ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: 5 });
    }
    if (req.tools?.length && req.toolMode !== "prompted") {
      // Claude's own search is named web_search too; ours steps aside when it's on.
      const own = req.nativeSearch ? req.tools.filter((t) => t.name !== "web_search") : req.tools;
      anthropicTools.push(...own.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })));
    }
    if (anthropicTools.length) body.tools = anthropicTools;
    // Earlier steps of this turn, replayed exactly (thinking blocks included, as the API requires).
    for (const turn of nativeTurns) {
      (body.messages as unknown[]).push(
        { role: "assistant", content: turn.raw },
        {
          role: "user",
          content: turn.results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            // Screenshots and other tool images ride inside the tool_result itself.
            content: images.has(r.id) ? [{ type: "text", text: r.content || "(empty)" }, imageBlock(images.get(r.id)!)] : resultText(r, images, ""),
            ...(r.isError ? { is_error: true } : {}),
          })),
        },
      );
    }
    if (claudeFinal) {
      body.tool_choice = { type: "none" };
      const last = (body.messages as { role: string; content: unknown[] }[]).at(-1);
      if (last?.role === "user") last.content = [...last.content, { type: "text", text: req.finalNote! }];
      else (body.messages as unknown[]).push({ role: "user", content: [{ type: "text", text: req.finalNote! }] });
    }
    applyPrompted(req, body, "anthropic");
    return { url: `${base}/v1/messages`, init: { method: "POST", headers, body: JSON.stringify(body) } };
  }

  if (provider.kind === "gemini") {
    headers["x-goog-api-key"] = provider.apiKey;
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== null) generationConfig.temperature = req.temperature;
    if (req.thinking !== "off") {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: { low: 1024, medium: 8192, high: 24576 }[req.thinking],
      };
    }
    const body: { contents: { role: string; parts: unknown[] }[]; [key: string]: unknown } = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          ...imagesOf(m).map((a) => {
            const { mediaType, data } = splitDataUrl(a.dataUrl);
            return { inlineData: { mimeType: mediaType, data } };
          }),
          { text: messageText(m) },
        ],
      })),
      generationConfig,
      ...(req.tools?.length && req.toolMode !== "prompted"
        ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }] }
        : req.nativeSearch
          ? { tools: [{ google_search: {} }] }
          : {}),
    };
    for (const turn of nativeTurns) {
      body.contents.push(
        { role: "model", parts: turn.raw as never },
        {
          role: "user",
          parts: [
            ...turn.results.map((r) => ({
              functionResponse: { name: r.name, ...(r.id.startsWith("gem_") ? {} : { id: r.id }), response: { content: resultText(r, images, "[The image follows.]") } },
            })),
            ...turn.results.flatMap((r) => (images.has(r.id) ? [imagePart(images.get(r.id)!)] : [])),
          ],
        },
      );
    }
    applyPrompted(req, body, "gemini");
    const model = req.model.replace(/^models\//, "");
    return {
      url: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      init: { method: "POST", headers, body: JSON.stringify(body) },
    };
  }

  // OpenAI-compatible: OpenAI, xAI, OpenRouter, Groq, DeepSeek, Mistral, Ollama, LM Studio, ...
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  if (base.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/elie222/rakazo";
    headers["X-Title"] = "ADT Bot";
  }
  const messages: unknown[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of history) {
    const images = imagesOf(m);
    if (images.length) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: messageText(m) },
          ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } })),
        ],
      });
    } else {
      messages.push({ role: m.role, content: messageText(m) });
    }
  }
  const body: Record<string, unknown> = { model: req.model, messages, stream: true };
  if (req.temperature !== null) body.temperature = req.temperature;
  if (req.thinking !== "off") body.reasoning_effort = req.thinking;
  else if (req.fast && provider.models.find((m) => m.id === req.model)?.reasoning && /openai|xai|openrouter|groq/.test(provider.presetId)) {
    body.reasoning_effort = "low";
  }
  if (req.nativeSearch && (provider.presetId === "openrouter" || base.includes("openrouter.ai"))) {
    body.plugins = [{ id: "web", max_results: 5 }];
  }
  if (req.tools?.length && req.toolMode !== "prompted") {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  for (const turn of nativeTurns) {
    const raw = (turn.raw ?? {}) as { reasoning?: string };
    messages.push({
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      // DeepSeek's thinking mode needs its reasoning replayed during tool calls.
      ...(provider.presetId === "deepseek" && raw.reasoning ? { reasoning_content: raw.reasoning } : {}),
    });
    for (const r of turn.results) messages.push({ role: "tool", tool_call_id: r.id, content: resultText(r, images, "[The image is in the next message.]") });
    // Tool messages are text-only, so images follow as a user message.
    const shown = turn.results.filter((r) => images.has(r.id));
    if (shown.length) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Image from ${shown.map((r) => r.name).join(", ")}:` }, ...shown.map((r) => imageUrlPart(images.get(r.id)!))],
      });
    }
  }
  applyPrompted(req, body, "openai");
  return { url: `${base}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

/**
 * Text-protocol tools: describe the tools in the system prompt and replay earlier steps as plain
 * messages (assistant: the call markup; user: the result), so any chat model can use tools.
 */
function applyPrompted(req: ChatRequest, body: Record<string, any>, kind: "openai" | "anthropic" | "gemini") {
  if (req.toolMode !== "prompted") return;
  // On the last step there are no tools left to describe, but earlier steps are still replayed.
  const protocol = req.tools?.length ? promptedProtocol(req.tools) : "";
  const turns = req.toolTurns ?? [];
  const images = toolImages(req);
  const replies = (turn: ToolTurn) => ({
    text: turn.results.map((r) => promptedResult(r.name, resultText(r, images, "[Image attached.]"))).join("\n\n"),
    shown: turn.results.flatMap((r) => (images.has(r.id) ? [images.get(r.id)!] : [])),
  });
  if (kind === "anthropic") {
    body.system = [body.system, protocol].filter(Boolean).join("\n\n");
    for (const turn of turns) {
      const { text, shown } = replies(turn);
      body.messages.push({ role: "assistant", content: String(turn.raw) });
      body.messages.push({ role: "user", content: shown.length ? [{ type: "text", text }, ...shown.map(imageBlock)] : text });
    }
  } else if (kind === "gemini") {
    const system = body.systemInstruction?.parts?.[0]?.text ?? "";
    if (protocol) body.systemInstruction = { parts: [{ text: [system, protocol].filter(Boolean).join("\n\n") }] };
    for (const turn of turns) {
      const { text, shown } = replies(turn);
      body.contents.push({ role: "model", parts: [{ text: String(turn.raw) }] });
      body.contents.push({ role: "user", parts: [{ text }, ...shown.map(imagePart)] });
    }
  } else {
    const messages = body.messages as { role: string; content: unknown }[];
    if (protocol) {
      if (messages[0]?.role === "system") messages[0] = { role: "system", content: `${messages[0].content}\n\n${protocol}` };
      else messages.unshift({ role: "system", content: protocol });
    }
    for (const turn of turns) {
      const { text, shown } = replies(turn);
      messages.push({ role: "assistant", content: String(turn.raw) });
      messages.push({ role: "user", content: shown.length ? [{ type: "text", text }, ...shown.map(imageUrlPart)] : text });
    }
  }
}

/** Turns provider stream chunks into events. Stateful: sources and citations build up over the stream. */
type Parser = { parse: (json: any) => Generator<StreamEvent>; finish: () => Generator<StreamEvent> };

function createParser(provider: ProviderConfig, req: ChatRequest): Parser {
  const native = Boolean(req.tools?.length) && req.toolMode !== "prompted";
  const sources: Source[] = [];
  const addSource = (url: string | undefined, title?: string, snippet = ""): number => {
    if (!url) return -1;
    const existing = sources.findIndex((s) => s.url === url);
    if (existing >= 0) return existing;
    sources.push({ url, title: title || url, snippet });
    return sources.length - 1;
  };
  // Anthropic: which sources each text block cites, emitted as [n] when the block ends.
  const blockCitations = new Map<number, Set<number>>();

  if (provider.kind === "anthropic") {
    // The full assistant turn, block by block, so a tool step can be replayed exactly.
    const blocks: Record<string, any>[] = [];
    const partialJson = new Map<number, string>();
    let text = "";
    const parse = function* (json: any): Generator<StreamEvent> {
      if (json.type === "content_block_start") {
        const block = json.content_block ?? {};
        blocks[json.index] = { ...block };
        if (block.type === "tool_use" || block.type === "server_tool_use") partialJson.set(json.index, "");
        if (block.type === "server_tool_use") yield { type: "status", text: "Searching the web…" };
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) addSource(r.url, r.title, r.page_age ? `Updated ${r.page_age}` : "");
          yield { type: "sources", sources: [...sources] };
        }
      } else if (json.type === "content_block_delta") {
        const delta = json.delta ?? {};
        const block = blocks[json.index];
        if (delta.type === "text_delta" && delta.text) {
          text += delta.text;
          if (block) block.text = (block.text ?? "") + delta.text;
          yield { type: "text", text: delta.text };
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          if (block) block.thinking = (block.thinking ?? "") + delta.thinking;
          yield { type: "reasoning", text: delta.thinking };
        }
        if (delta.type === "signature_delta" && block) block.signature = (block.signature ?? "") + (delta.signature ?? "");
        if (delta.type === "input_json_delta") partialJson.set(json.index, (partialJson.get(json.index) ?? "") + (delta.partial_json ?? ""));
        if (delta.type === "citations_delta" && delta.citation?.url) {
          const n = addSource(delta.citation.url, delta.citation.title, delta.citation.cited_text ?? "");
          if (!blockCitations.has(json.index)) blockCitations.set(json.index, new Set());
          blockCitations.get(json.index)!.add(n + 1);
        }
      } else if (json.type === "content_block_stop" && blockCitations.has(json.index)) {
        const marks = [...blockCitations.get(json.index)!].map((n) => `[${n}]`).join("");
        blockCitations.delete(json.index);
        yield { type: "sources", sources: [...sources] };
        yield { type: "text", text: ` ${marks}` };
      } else if (json.type === "message_delta" && json.delta?.stop_reason === "refusal") {
        yield { type: "text", text: "\n\n_The model declined to answer this request._" };
      }
      if (json.type === "content_block_stop" && partialJson.has(json.index)) {
        blocks[json.index].input = parseToolArgs(partialJson.get(json.index) ?? "");
        partialJson.delete(json.index);
      }
    };
    const finish = function* (): Generator<StreamEvent> {
      const calls = blocks.filter((b) => b?.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      if (!native || !calls.length) return;
      // Citations aren't needed on replay and some fields aren't accepted back.
      const raw = blocks.filter(Boolean).map((b) => {
        const { citations: _c, ...rest } = b;
        return b.type === "text" ? { type: "text", text: b.text ?? "" } : rest;
      });
      yield { type: "tool_calls", calls, raw, text };
    };
    return { parse, finish };
  }

  if (provider.kind === "gemini") {
    // Every part, kept as sent: function calls carry thought signatures that must be replayed.
    const parts: Record<string, any>[] = [];
    let text = "";
    const parse = function* (json: any): Generator<StreamEvent> {
      const candidate = json.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (typeof part.text !== "string" || !part.text) continue;
        if (!part.thought) text += part.text;
        yield { type: part.thought ? "reasoning" : "text", text: part.text };
      }
      const chunks: any[] = candidate?.groundingMetadata?.groundingChunks ?? [];
      if (chunks.length) {
        for (const c of chunks) addSource(c.web?.uri, c.web?.title);
        yield { type: "sources", sources: [...sources] };
      }
    };
    const finish = function* (): Generator<StreamEvent> {
      const calls = parts
        .filter((p) => p.functionCall?.name)
        .map((p, i) => ({ id: p.functionCall.id ?? `gem_${i}_${crypto.randomUUID().slice(0, 8)}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
      if (!native || !calls.length) return;
      yield { type: "tool_calls", calls, raw: parts, text };
    };
    return { parse, finish };
  }

  const accumulator = new ToolCallAccumulator();
  let text = "";
  let reasoningText = "";
  const parse = function* (json: any): Generator<StreamEvent> {
    // Perplexity lists the pages behind its [1], [2] markers on the chunk itself.
    const listed: any[] = json.search_results ?? (json.citations ?? []).map((url: string) => ({ url }));
    if (listed.length > sources.length) {
      for (const r of listed) addSource(r.url, r.title, r.snippet ?? "");
      yield { type: "sources", sources: [...sources] };
    }
    const delta = json.choices?.[0]?.delta ?? json.choices?.[0]?.message;
    if (!delta) return;
    const annotations: any[] = delta.annotations ?? [];
    if (annotations.length) {
      // OpenRouter web plugin citations.
      for (const a of annotations) addSource(a.url_citation?.url, a.url_citation?.title, a.url_citation?.content ?? "");
      yield { type: "sources", sources: [...sources] };
    }
    if (delta.tool_calls) accumulator.push(delta.tool_calls);
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      reasoningText += reasoning;
      yield { type: "reasoning", text: reasoning };
    }
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      yield { type: "text", text: delta.content };
    }
  };
  const finish = function* (): Generator<StreamEvent> {
    if (!native || !accumulator.size) return;
    yield { type: "tool_calls", calls: accumulator.finish(), raw: { reasoning: reasoningText }, text };
  };
  return { parse, finish };
}

/** Yields the `data:` payload of each server-sent event. Also copes with fully buffered bodies. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  let buffer = "";
  const flush = function* (final: boolean) {
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (events.pop() ?? "");
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  };

  if (!res.body) {
    buffer = await res.text();
    yield* flush(true);
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    yield* flush(false);
  }
  yield* flush(true);
}

/** Models a provider offers, read from its own /models endpoint. */
export async function listModels(provider: ProviderConfig, useProxy: boolean, signal?: AbortSignal): Promise<ModelInfo[]> {
  if (provider.kind === "cli") return cliModels(provider);
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  let url = `${base}/models`;
  if (provider.kind === "anthropic") {
    url = `${base}/v1/models?limit=1000`;
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (provider.kind === "gemini") {
    url = `${base}/models?pageSize=1000`;
    headers["x-goog-api-key"] = provider.apiKey;
  } else if (provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }

  const res = await providerFetch(url, { method: "GET", headers: withCustomHeaders(headers, provider.headers), signal }, useProxy);
  if (!res.ok) throw new Error(await describeHttpError(res));
  const json: any = await res.json();

  if (provider.kind === "gemini") {
    return (json.models ?? [])
      .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: any) => ({
        id: String(m.name).replace(/^models\//, ""),
        name: m.displayName,
        vision: true,
        reasoning: Boolean(m.thinking),
        context: m.inputTokenLimit ?? null,
      }));
  }
  const rows: any[] = json.data ?? json.models ?? [];
  return rows
    .map((m) => {
      const id = String(m.id ?? m.name ?? "");
      const modalities: string[] | undefined = m.architecture?.input_modalities ?? m.input_modalities;
      return {
        id,
        name: m.display_name ?? m.name ?? id,
        vision: modalities ? modalities.includes("image") : guessVision(id),
        reasoning: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("reasoning") : undefined,
        context: m.context_length ?? m.context_window ?? m.max_input_tokens ?? null,
      };
    })
    .filter((m) => m.id && !/embed|whisper|tts|dall-e|moderation|transcribe|rerank/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The user's extra headers win over built-in ones (e.g. their own Authorization for a private server). */
export function withCustomHeaders(
  headers: Record<string, string>,
  custom: Record<string, string> | undefined,
): Record<string, string> {
  if (!custom) return headers;
  const overridden = new Set(Object.keys(custom).map((name) => name.toLowerCase()));
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => !overridden.has(name.toLowerCase()))),
    ...custom,
  };
}

/** Claude models that think even when the request leaves `thinking` out (Opus 5+, Sonnet 5+, Fable, Mythos). */
function thinksByDefault(model: string): boolean {
  return /claude-(opus-[5-9]|sonnet-[5-9]|fable|mythos)/.test(model);
}

/** Claude models from before adaptive thinking still use a fixed budget and accept temperature. */
function isLegacyClaude(model: string): boolean {
  return /claude-(3|haiku-4|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4-2|sonnet-4-2)|claude-(sonnet|opus)-4-20/.test(
    model,
  );
}

export function splitDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: "image/png", data: dataUrl };
}

/**
 * Local reasoning models (DeepSeek-R1, Qwen3 on Ollama, ...) put their reasoning inline in
 * <think> tags. Split it out for display and drop it from history sent back to the model.
 */
export function splitThink(content: string): { reasoning: string; text: string; thinking: boolean } {
  const match = /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(content);
  if (!match) return { reasoning: "", text: content, thinking: false };
  return {
    reasoning: match[1].trim(),
    text: content.slice(match[0].length).trimStart(),
    thinking: match[2] === "",
  };
}

function stripThink(content: string): string {
  return splitThink(content).text;
}

export async function describeHttpError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 500);
  try {
    const json = JSON.parse(text);
    detail = errorText(json.error ?? json) || detail;
  } catch {
    // Not JSON; keep the raw text.
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " Check the API key in Settings → Providers."
      : res.status === 404
        ? " Check the model name and base URL."
        : res.status === 429
          ? " Rate limited or out of credits."
          : "";
  return `${res.status} ${res.statusText}: ${detail || "request failed"}.${hint}`;
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (Array.isArray(error) && error[0]) return errorText(error[0]);
    if (e.error) return errorText(e.error);
  }
  return "";
}
