import { BareCallFilter, OPEN as PROMPTED_OPEN, PromptedFilter, promptedProtocol, promptedResult } from "./agent/prompted";
import { ToolCallAccumulator, parseToolArgs } from "./agent/vendor/openbot/toolCallAccumulator";
import { cliModels, streamCliChat } from "./cli-agents/provider";
import type { ToolCall, ToolSchema } from "./agent/vendor/openbot/types";
import { guessVision, presetById } from "./providers";
import { providerFetch, type FetchInit } from "./transport";
import type { Message, ModelInfo, ProviderConfig, Source, ThinkingLevel } from "./types";

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Web pages the provider's own search used (cumulative list). */
  | { type: "sources"; sources: Source[] }
  | { type: "status"; text: string }
  /** The model asked for tools. `raw` is its turn in the provider's own format, replayed on the next step. */
  | { type: "tool_calls"; calls: ToolCall[]; raw: unknown; text: string }
  /**
   * Claude summarised the conversation so far (server-side compaction). Keep the block with the
   * reply: sent back on later turns, everything before it is replaced by the summary.
   */
  | { type: "compaction"; block: Record<string, unknown> }
  /**
   * The model wrote a call, as text, to a tool that doesn't exist (small local models invent them).
   * The tool loop tells it once; `text` is what it wrote, shown if it does it again.
   */
  | { type: "bad_call"; name: string; text: string; before: string };

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
 * `thinking` block"). Other providers get the newest few, and so does Claude once a long turn had
 * to be shortened to fit (its thinking is left out then; see fitToContext).
 */
function toolImages(req: ChatRequest, keepAll = req.provider.kind === "anthropic"): Map<string, ToolImage> {
  const kept = new Map<string, ToolImage>();
  const info = req.provider.models.find((m) => m.id === req.model);
  if (req.provider.kind === "openai" && !(info?.vision ?? guessVision(req.model))) return kept;
  const withImages = (req.toolTurns ?? []).flatMap((t) => t.results).filter((r) => r.image);
  for (const r of keepAll ? withImages : withImages.slice(-TOOL_IMAGES_KEPT)) kept.set(r.id, r.image!);
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

/** An HTTP error from a provider, with what's needed to decide whether to try again. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

async function providerError(res: Response): Promise<ProviderError> {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  const at = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : NaN;
  const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(at) ? Math.max(0, at) : undefined;
  return new ProviderError(await describeHttpError(res), res.status, retryAfterMs);
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const MAX_RETRIES = 3;

/**
 * How long to wait before trying a failed request again, or null when it shouldn't be retried:
 * busy or briefly failing services and dropped connections are retried; bad keys, bad requests and
 * exhausted credit are not.
 */
export function retryDelay(error: unknown, attempt: number): number | null {
  if (attempt >= MAX_RETRIES) return null;
  const e = error as Partial<ProviderError> & Error;
  if ((e as Error)?.name === "AbortError") return null;
  const message = String(e?.message ?? "");
  const network = !e?.status && /fetch failed|network|ECONNRESET|ETIMEDOUT|socket hang up|Failed to fetch|Load failed|terminated/i.test(message);
  const overloaded = /overloaded/i.test(message);
  if (!network && !overloaded && !(e?.status && RETRY_STATUS.has(e.status))) return null;
  if (/insufficient_quota|credit balance|billing|exceeded your current quota/i.test(message)) return null;
  if (e?.retryAfterMs !== undefined) return e.retryAfterMs <= 30_000 ? e.retryAfterMs : null;
  return 800 * 2 ** attempt + Math.round(Math.random() * 400);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("Stopped", "AbortError"))), { once: true });
  });
}

/** A Claude content block, as streamed and as replayed. */
type Block = Record<string, any>;

/** How a request is shaped beyond the ChatRequest itself; streamChat adjusts it when retrying. */
type Shape = {
  /** Leave out the optional Claude betas (fallbacks, compaction, thinking binding) after a request rejected them. */
  lean?: boolean;
  /** Replay tool steps without their thinking blocks: the documented recovery when history no longer matches them. */
  stripThinking?: boolean;
  /** An assistant turn the server paused (pause_turn), sent back unchanged so it carries on. */
  resume?: Block[];
  /** Send no reasoning settings: the model said it can't think (Ollama's llama3.2, for one). */
  noThinking?: boolean;
};

/** Provider + model pairs that rejected an optional beta this session; they get plain requests. */
const leanTargets = new Set<string>();
/** Provider + model pairs (OpenAI-compatible) that rejected thinking this session: asked without it. */
const noThinkingTargets = new Set<string>();

/** A 400 because the model can't reason, not because of the conversation (e.g. Ollama: "does not support thinking"). */
export function thinkingUnsupportedError(error: unknown): boolean {
  const e = error as Partial<ProviderError>;
  return e?.status === 400 && /does not support (thinking|reasoning)|(thinking|reasoning)(_effort)? (is )?not supported|unsupported (parameter|value)[^.]{0,40}reasoning|unrecognized[^.]{0,40}reasoning_effort/i.test(String(e.message ?? ""));
}

/** A paused server-side search is resumed this many times before the reply says so. */
const MAX_CONTINUATIONS = 3;

/** A 400 caused by one of the optional Claude features rather than by the conversation itself. */
function optionalFeatureError(error: unknown): boolean {
  const e = error as Partial<ProviderError>;
  return e?.status === 400 && /anthropic-beta|\bbeta\b|fallbacks|context_management|compact|block_binding|citations|Extra inputs are not permitted|web_search_2026|allowed_callers/i.test(String(e.message ?? ""));
}

/** Replayed thinking that no longer matches the conversation before it (preserved thinking). */
function thinkingBindingError(error: unknown): boolean {
  const e = error as Partial<ProviderError>;
  return e?.status === 400 && /Invalid `?signature`? in `?thinking`? block|bound to a different conversation/i.test(String(e.message ?? ""));
}

/**
 * Stream a reply from any supported provider as text and reasoning deltas. A request that fails
 * before anything arrived (busy service, rate limit, dropped connection) is tried again; so is one
 * that only failed on an optional feature, without it. A web search the server paused is resumed.
 */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  if (req.provider.kind === "cli") return yield* streamCliChat(req);
  const key = `${req.provider.id}::${req.model}`;
  const shape: Shape = { lean: leanTargets.has(key), noThinking: noThinkingTargets.has(key) };
  for (let continuation = 0; ; continuation++) {
    const paused = yield* streamWithRetries(req, shape, key);
    if (!paused) return;
    if (continuation >= MAX_CONTINUATIONS) {
      yield { type: "text", text: "\n\n_The web search took too long to finish. Ask again to continue._" };
      return;
    }
    shape.resume = paused;
  }
}

async function* streamWithRetries(req: ChatRequest, shape: Shape, key: string): AsyncGenerator<StreamEvent, Block[] | undefined> {
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      const stream = streamOnce(req, shape);
      for (;;) {
        const next = await stream.next();
        if (next.done) return next.value;
        started = true;
        yield next.value;
      }
    } catch (error) {
      if (!started && !req.signal?.aborted && req.provider.kind === "openai" && !shape.noThinking && req.thinking !== "off" && thinkingUnsupportedError(error)) {
        // The bot's thinking setting asks more than this model can do: answer without it.
        shape.noThinking = true;
        noThinkingTargets.add(key);
        attempt--;
        continue;
      }
      if (!started && !req.signal?.aborted && req.provider.kind === "anthropic") {
        if (!shape.stripThinking && thinkingBindingError(error)) {
          shape.stripThinking = true;
          attempt--;
          continue;
        }
        if (!shape.lean && optionalFeatureError(error)) {
          shape.lean = true;
          leanTargets.add(key);
          attempt--;
          continue;
        }
      }
      const wait = started || req.signal?.aborted ? null : retryDelay(error, attempt);
      if (wait === null) throw error;
      yield { type: "status", text: attempt ? `The service is busy. Trying again (${attempt + 1})…` : "The service is busy. Trying again…" };
      await sleep(wait, req.signal);
    }
  }
}

/** One request. Returns the assistant turn so far when the server paused it (pause_turn). */
async function* streamOnce(req: ChatRequest, shape: Shape = {}): AsyncGenerator<StreamEvent, Block[] | undefined> {
  const { url, init } = buildRequest(req, shape);
  init.headers = withCustomHeaders(init.headers, req.provider.headers);
  const res = await providerFetch(url, { ...init, signal: req.signal }, req.useProxy);
  if (!res.ok) throw await providerError(res);

  const parser = createParser(req.provider, req, shape);
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
    if (json.error || json.type === "error") {
      const error = json.error ?? json;
      const type = String(error?.type ?? error?.error?.type ?? "");
      throw new ProviderError(errorText(error), /overloaded/.test(type) ? 529 : /rate_limit/.test(type) ? 429 : /api_error/.test(type) ? 500 : 0);
    }
    for (const event of parser.parse(json)) yield* route(event);
  }
  for (const event of parser.finish()) yield* route(event);
  if (prompted && req.tools) {
    const { tail, call, text } = prompted.finish(req.tools);
    if (tail) yield { type: "text", text: tail };
    if (call) yield { type: "tool_calls", calls: [call], raw: text, text: text.slice(0, text.indexOf(PROMPTED_OPEN)).trim() };
  }
  if (bare && req.tools) {
    const { tail, call, before, unknown } = bare.finish(req.tools);
    if (call && !nativeCalls) yield { type: "tool_calls", calls: [call], raw: {}, text: before };
    else if (unknown && !nativeCalls) yield { type: "bad_call", name: unknown, text: tail, before };
    else if (tail) yield { type: "text", text: tail };
  }
  return parser.paused?.();
}

/** Gemini accepts an OpenAPI subset: drop JSON-Schema keywords it rejects. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (["additionalProperties", "$schema", "default", "examples", "$defs", "definitions", "$ref", "const"].includes(key)) continue;
    out[key] = geminiSchema(value);
  }
  return out;
}

/**
 * Runs a short request to completion and returns only the answer text (titles, search queries).
 * Light reasoning by default: models that always think (Claude Opus 5.5…) would otherwise spend
 * their default effort on a chat title.
 */
export async function complete(
  req: Omit<ChatRequest, "temperature" | "thinking"> & Partial<Pick<ChatRequest, "temperature" | "thinking">>,
): Promise<string> {
  let text = "";
  for await (const event of streamChat({ temperature: null, thinking: "off", fast: true, ...req })) {
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

/** Share of the model's context window a request may fill before older material is shortened. */
const CONTEXT_SHARE = 0.7;
/** Roughly what one screenshot costs (a ~1 megapixel image on Claude; OpenAI and Gemini cost less). */
const IMAGE_TOKENS = 1600;
/** The newest tool steps always go in full, screenshots included. */
const STEPS_KEPT = 2;
/** Older steps are shortened this many at a time, so the shortened part stays the same for a few steps (prompt caches). */
const STEP_CHUNK = 4;

/** A rough token count, on the high side for safety (~3.5 characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 3.5);

/**
 * The model's context window in tokens: what its /models entry or the catalog says, else a cautious
 * guess (local servers often run with small windows).
 */
export function contextLimit(req: Pick<ChatRequest, "provider" | "model">): number {
  const known = req.provider.models.find((m) => m.id === req.model)?.context;
  if (known && known > 0) return known;
  if (req.provider.kind === "anthropic" && /claude/.test(req.model)) return isLegacyClaude(req.model) ? 200_000 : 1_000_000;
  const preset = presetById(req.provider.presetId);
  return preset?.local || preset?.group === "local" || preset?.group === "private" ? 32_000 : 128_000;
}

/** A tool step with its results replaced by short notes (screenshots dropped). */
function shortenTurn(turn: ToolTurn): ToolTurn {
  return {
    ...turn,
    results: turn.results.map((r) => {
      if (r.content.length <= 400 && !r.image) return r;
      const start = r.content.slice(0, 200).replace(/\s+/g, " ").trim();
      const { image: _image, ...rest } = r;
      return { ...rest, content: `[Shortened to save space: this earlier result had ${r.content.length} characters${r.image ? " and an image" : ""}. It began: "${start}…"]` };
    }),
  };
}

/**
 * Keeps a request inside the model's context window when the provider can't compact it itself.
 * Under ~70% of the window nothing changes. Above it, older tool results in this turn become short
 * notes (the newest steps and the latest screenshot stay whole), then the oldest chat messages are
 * left out with a note; the latest user message always stays.
 */
export function fitToContext(req: ChatRequest): { messages: Message[]; toolTurns: ToolTurn[]; trimmed: boolean } {
  const turns = req.toolTurns ?? [];
  const budget = Math.floor(contextLimit(req) * CONTEXT_SHARE);
  const shown = toolImages(req);
  const messageCost = (m: Message) => tokensOf(messageText(m)) + imagesOf(m).length * IMAGE_TOKENS;
  const turnCost = (t: ToolTurn) =>
    tokensOf(t.text) +
    tokensOf(JSON.stringify(t.calls)) +
    t.results.reduce((n, r) => n + tokensOf(r.content) + (r.image && shown.has(r.id) ? IMAGE_TOKENS : 0), 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const fixed = tokensOf(req.system) + tokensOf(JSON.stringify(req.tools ?? [])) + tokensOf(req.finalNote ?? "");
  const messageCosts = req.messages.map(messageCost);
  let toolTurns = turns;
  let turnTotal = sum(turns.map(turnCost));
  if (fixed + sum(messageCosts) + turnTotal <= budget) return { messages: req.messages, toolTurns: turns, trimmed: false };

  const shortenable = Math.max(0, turns.length - STEPS_KEPT);
  for (let shortened = 0; shortened < shortenable && fixed + sum(messageCosts) + turnTotal > budget; ) {
    shortened = Math.min(shortenable, shortened + STEP_CHUNK);
    toolTurns = turns.map((t, i) => (i < shortened ? shortenTurn(t) : t));
    turnTotal = sum(toolTurns.map(turnCost));
  }

  let lastUser = req.messages.length - 1;
  while (lastUser > 0 && req.messages[lastUser].role !== "user") lastUser--;
  let start = 0;
  let total = fixed + sum(messageCosts) + turnTotal;
  while (total > budget && start < lastUser) {
    total -= messageCosts[start];
    start++;
    // Start on a user message, so roles still alternate.
    while (start < lastUser && req.messages[start].role !== "user") total -= messageCosts[start++];
  }
  const messages = start
    ? [
        { ...req.messages[start], content: `[Earlier messages in this chat were left out to fit the model's context window.]\n\n${req.messages[start].content}` },
        ...req.messages.slice(start + 1),
      ]
    : req.messages;
  return { messages, toolTurns, trimmed: true };
}

/**
 * Claude models whose thinking blocks are bound to the exact conversation before them ("preserved
 * thinking", Claude 5.1 and later): after any change to earlier turns, replayed thinking is invalid.
 */
function bindsThinking(model: string): boolean {
  return /claude-(?:(?:opus|sonnet|haiku)-(?:5-[5-9]|[6-9])|(?:fable|mythos)-(?:5-[1-9]|[6-9]))/.test(model);
}

/** Claude models that can compact the conversation on the server (beta compact-2026-01-12). */
function compactsOnServer(model: string): boolean {
  return /claude-(?:(?:opus|sonnet)-4-[6-9]|(?:opus|sonnet)-[5-9]|haiku-[5-9]|fable|mythos)/.test(model);
}

/**
 * Claude models that take the server-side refusal fallback (`fallbacks: "default"`): a request a
 * safety classifier declines is answered by another Claude model instead of stopping.
 */
function fallsBackOnServer(model: string): boolean {
  return /^claude-(?:opus-5(?:-5)?|sonnet-5-5|fable-5(?:-1)?)$/.test(model);
}

/**
 * A Claude turn as replayed: unchanged, or without thinking (see `strip` below), or in the plain
 * form (no citations) when the API turned an optional feature down.
 */
function replayed(raw: unknown, strip: boolean, lean: boolean): unknown {
  if (!Array.isArray(raw)) return raw;
  const kept = strip ? raw.filter((b: Block) => b?.type !== "thinking" && b?.type !== "redacted_thinking") : raw;
  return lean ? kept.map((b: Block) => (b?.type === "text" ? { type: "text", text: b.text ?? "" } : b)) : kept;
}

function buildRequest(original: ChatRequest, shape: Shape = {}): { url: string; init: FetchInit } {
  const { provider } = original;
  // Claude (native tools) keeps its tools and system prompt unchanged on the last step, because its
  // thinking blocks are bound to them; it gets tool_choice "none" and the note as an appended
  // message instead. Elsewhere the step simply has no tools and the note joins the system prompt.
  const claudeFinal = Boolean(original.finalNote) && provider.kind === "anthropic" && original.toolMode !== "prompted";
  let req: ChatRequest =
    original.finalNote && !claudeFinal ? { ...original, tools: [], system: `${original.system}\n\n${original.finalNote}` } : original;
  if (shape.noThinking) req = { ...req, thinking: "off" };
  // Anthropic's API summarises long conversations itself; everything else is kept to size here.
  const official = provider.kind === "anthropic" && provider.presetId === "anthropic";
  const serverCompaction = official && !shape.lean && compactsOnServer(req.model);
  let trimmed = false;
  if (!serverCompaction) {
    const fitted = fitToContext(req);
    trimmed = fitted.trimmed;
    if (trimmed) req = { ...req, messages: fitted.messages, toolTurns: fitted.toolTurns };
  }
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const history = req.messages.filter((m) => !m.error && (m.content || m.attachments?.length));
  const images = toolImages(req, provider.kind === "anthropic" && !trimmed);
  // Text-protocol steps are replayed by applyPrompted instead.
  const nativeTurns = req.toolMode === "prompted" ? [] : (req.toolTurns ?? []);

  if (provider.kind === "anthropic") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    const legacy = isLegacyClaude(req.model);
    const betas: string[] = [];
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: legacy ? 32000 : 64000,
      stream: true,
      messages: history.map((m) => ({
        role: m.role,
        content: [
          // A summary from an earlier turn: the API replaces everything before it with the summary.
          ...(serverCompaction && m.role === "assistant" && m.compaction ? [m.compaction] : []),
          ...imagesOf(m).map((a) => {
            const { mediaType, data } = splitDataUrl(a.dataUrl);
            return { type: "image", source: { type: "base64", media_type: mediaType, data } };
          }),
          { type: "text", text: messageText(m) },
        ],
      })),
    };
    if (req.system) body.system = req.system;
    let thinking: Record<string, unknown> | undefined;
    if (legacy) {
      // Claude 4.5 and older: fixed thinking budget, and sampling params are still accepted.
      if (req.thinking !== "off") {
        thinking = { type: "enabled", budget_tokens: { low: 2048, medium: 8192, high: 24000 }[req.thinking] };
      } else if (req.temperature !== null) {
        body.temperature = req.temperature;
      }
    } else if (req.thinking !== "off") {
      // Current Claude models: adaptive thinking steered by effort; temperature is rejected.
      thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: req.thinking };
    } else if (req.fast) {
      // "Off" is never sent as thinking: {type: "disabled"} (Opus 5.5, Fable and Sonnet 5.5 reject
      // it). Current models think by default, and low effort answers much sooner.
      body.output_config = { effort: "low" };
    } else if (thinksByDefault(req.model) && req.tools?.some((t) => t.name.startsWith("mac_"))) {
      // Thinking "off" with screen control: each step is a small decision, and a high default
      // effort (most models; Opus 5.5 and Haiku 5.5 default to medium) makes every click wait.
      // Same for every step of the turn.
      body.output_config = { effort: "medium" };
    }
    if (official && !legacy && !shape.lean) {
      // Replayed tool steps carry thinking blocks bound to the conversation before them. History is
      // replayed unchanged, but if anything before a block ever differs, drop that block for this
      // request instead of failing it with a 400. Sent from the first step so the thinking settings
      // (part of the prompt cache key) stay the same for the whole turn.
      const thinks = thinking ?? (thinksByDefault(req.model) ? { type: "adaptive" } : undefined);
      if (thinks) {
        thinking = { ...thinks, block_binding: { prefix_mismatch_behavior: "drop_block" } };
        betas.push("thinking-binding-controls-2026-08-01");
      }
    }
    if (thinking) body.thinking = thinking;
    if (official) {
      // Cache the history as it grows (top-level automatic caching); the system prompt gets its
      // own breakpoint below, so it stays cached across compactions and changes later in the chat.
      body.cache_control = { type: "ephemeral" };
    }
    if (serverCompaction) {
      // Long turns (screen tasks with screenshots) and long chats: past ~150k tokens Claude
      // summarises the earlier conversation instead of running out of room.
      body.context_management = { edits: [{ type: "compact_20260112" }] };
      betas.push("compact-2026-01-12");
    }
    if (official && !shape.lean && fallsBackOnServer(req.model)) {
      // A false positive from a safety classifier is answered by another Claude model instead of a refusal.
      body.fallbacks = "default";
      betas.push("server-side-fallback-2026-07-01");
    }
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    const anthropicTools: unknown[] = [];
    if (req.nativeSearch) {
      // Server-side web search; the dynamic-filtering version needs Claude 4.6 or newer.
      anthropicTools.push({ type: legacy || shape.lean ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: 5 });
    }
    if (req.tools?.length && req.toolMode !== "prompted") {
      // Claude's own search is named web_search too; ours steps aside when it's on.
      const own = req.nativeSearch ? req.tools.filter((t) => t.name !== "web_search") : req.tools;
      anthropicTools.push(...own.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })));
    }
    if (anthropicTools.length) body.tools = anthropicTools;
    // Thinking is left out of the replay only when earlier turns had to change (shortened to fit,
    // or the API said they no longer match): removing all of it is allowed, editing around it isn't.
    const strip = shape.stripThinking || (trimmed && bindsThinking(req.model));
    // Earlier steps of this turn, replayed exactly (thinking blocks included, as the API requires).
    for (const turn of nativeTurns) {
      (body.messages as unknown[]).push(
        { role: "assistant", content: replayed(turn.raw, strip, Boolean(shape.lean)) },
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
    applyPrompted(req, body, "anthropic", images);
    // A search the server paused goes back as the last (assistant) message, unchanged, so it resumes.
    if (shape.resume?.length) (body.messages as unknown[]).push({ role: "assistant", content: replayed(shape.resume, strip, Boolean(shape.lean)) });
    if (official && typeof body.system === "string" && body.system) {
      body.system = [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }];
    }
    return { url: `${base}/v1/messages`, init: { method: "POST", headers, body: JSON.stringify(body) } };
  }

  if (provider.kind === "gemini") {
    headers["x-goog-api-key"] = provider.apiKey;
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== null) generationConfig.temperature = req.temperature;
    const gemini3 = Number(/gemini-(\d+)/.exec(req.model)?.[1] ?? 0) >= 3;
    if (req.thinking !== "off") {
      // Gemini 3 takes a thinking level (a budget is only kept for older models; sending both is a 400).
      generationConfig.thinkingConfig = gemini3
        ? { includeThoughts: true, thinkingLevel: req.thinking }
        : { includeThoughts: true, thinkingBudget: { low: 1024, medium: 8192, high: 24576 }[req.thinking] };
    } else if (req.fast && gemini3) {
      // Gemini 3 always thinks (high by default); voice and short requests want it quick.
      generationConfig.thinkingConfig = { thinkingLevel: "low" };
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
    applyPrompted(req, body, "gemini", images);
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
  const info = provider.models.find((m) => m.id === req.model);
  // reasoning_effort only goes to models that may reason: OpenAI rejects it for GPT-4o and GPT-4.1.
  // low/medium/high are the values every reasoning model accepts (none/minimal/xhigh vary by model).
  if (req.thinking !== "off" && info?.reasoning !== false) body.reasoning_effort = req.thinking;
  else if (req.fast && info?.reasoning && /openai|xai|openrouter|groq/.test(provider.presetId)) {
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
  applyPrompted(req, body, "openai", images);
  return { url: `${base}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

/**
 * Text-protocol tools: describe the tools in the system prompt and replay earlier steps as plain
 * messages (assistant: the call markup; user: the result), so any chat model can use tools.
 */
function applyPrompted(req: ChatRequest, body: Record<string, any>, kind: "openai" | "anthropic" | "gemini", images: Map<string, ToolImage>) {
  if (req.toolMode !== "prompted") return;
  // On the last step there are no tools left to describe, but earlier steps are still replayed.
  const protocol = req.tools?.length ? promptedProtocol(req.tools) : "";
  const turns = req.toolTurns ?? [];
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
type Parser = {
  parse: (json: any) => Generator<StreamEvent>;
  finish: () => Generator<StreamEvent>;
  /** Claude: the assistant turn so far when the server paused it (pause_turn), to send back. */
  paused?: () => Block[] | undefined;
};

function createParser(provider: ProviderConfig, req: ChatRequest, shape: Shape = {}): Parser {
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
    // The full assistant turn, block by block, so a tool step can be replayed exactly. A turn the
    // server paused and resumed continues from the blocks already received.
    const prior = shape.resume ?? [];
    const blocks: Block[] = [];
    const partialJson = new Map<number, string>();
    let stop = "";
    let text = prior.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    const parse = function* (json: any): Generator<StreamEvent> {
      if (json.type === "content_block_start") {
        const block = json.content_block ?? {};
        blocks[json.index] = { ...block };
        if (block.type === "tool_use" || block.type === "server_tool_use") partialJson.set(json.index, "");
        if (block.type === "server_tool_use") yield { type: "status", text: "Searching the web…" };
        if (block.type === "compaction") yield { type: "status", text: "Summarising the earlier conversation to make room…" };
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
        if (delta.type === "citations_delta" && delta.citation) {
          // Kept on the block: web search citations go back exactly as received on the next step.
          if (block) block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
          if (delta.citation.url) {
            const n = addSource(delta.citation.url, delta.citation.title, delta.citation.cited_text ?? "");
            if (!blockCitations.has(json.index)) blockCitations.set(json.index, new Set());
            blockCitations.get(json.index)!.add(n + 1);
          }
        }
        if (delta.type === "compaction_delta" && block) block.content = (typeof block.content === "string" ? block.content : "") + (delta.content ?? "");
      } else if (json.type === "content_block_stop" && blockCitations.has(json.index)) {
        const marks = [...blockCitations.get(json.index)!].map((n) => `[${n}]`).join("");
        blockCitations.delete(json.index);
        yield { type: "sources", sources: [...sources] };
        yield { type: "text", text: ` ${marks}` };
      } else if (json.type === "message_delta" && json.delta?.stop_reason) {
        stop = json.delta.stop_reason;
        if (stop === "refusal") yield { type: "text", text: "\n\n_The model declined to answer this request._" };
      }
      if (json.type === "content_block_stop" && partialJson.has(json.index)) {
        blocks[json.index].input = parseToolArgs(partialJson.get(json.index) ?? "");
        partialJson.delete(json.index);
      }
      if (json.type === "content_block_stop" && blocks[json.index]?.type === "compaction") {
        yield { type: "compaction", block: blocks[json.index] };
      }
    };
    /**
     * The turn as it goes back to the API. After a mid-reply fallback to another model, the
     * declined part keeps only its text and finished server-tool results (the API's echo rules).
     */
    const replay = (): Block[] => {
      const list = blocks.filter(Boolean).map((b) =>
        b.type === "text" ? { type: "text", text: b.text ?? "", ...(b.citations?.length ? { citations: b.citations } : {}) } : b,
      );
      const boundary = list.findLastIndex((b) => b.type === "fallback");
      const answered = new Set(list.filter((b) => /_tool_result$/.test(b.type)).map((b) => b.tool_use_id));
      const kept = list.filter(
        (b, i) =>
          i >= boundary ||
          ["text", "compaction", "fallback"].includes(b.type) ||
          /_tool_result$/.test(b.type) ||
          (b.type === "server_tool_use" && answered.has(b.id)),
      );
      return [...prior, ...kept];
    };
    const finish = function* (): Generator<StreamEvent> {
      const raw = replay();
      const calls = raw.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
        const full = stop === "model_context_window_exceeded";
        // A tool call cut off mid-way has incomplete arguments: never run it.
        if (calls.length) {
          throw new Error(
            full
              ? "The conversation filled the model's context window while it was asking to use a tool. Start a new chat, or remove large attachments."
              : "The reply hit the model's output limit while asking to use a tool. Try again, or raise the output limit in the bot's settings.",
          );
        }
        yield { type: "text", text: full ? "\n\n_(Stopped: the conversation filled the model's context window. Start a new chat to continue.)_" : "\n\n_(Cut off at the output limit.)_" };
        return;
      }
      // A declined reply or a paused search never runs tools: the turn isn't finished.
      if (stop === "refusal" || stop === "pause_turn" || !native || !calls.length) return;
      yield { type: "tool_calls", calls, raw, text };
    };
    return { parse, finish, paused: () => (stop === "pause_turn" ? replay() : undefined) };
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

/** Claude models that think even when the request leaves `thinking` out (Opus 5+, Sonnet 5+, Haiku 5.5+, Fable, Mythos). */
function thinksByDefault(model: string): boolean {
  return /claude-(opus-[5-9]|sonnet-[5-9]|haiku-[5-9]|fable|mythos)/.test(model);
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
