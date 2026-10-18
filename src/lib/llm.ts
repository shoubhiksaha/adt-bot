import { guessVision } from "./providers";
import { providerFetch, type FetchInit } from "./transport";
import type { Message, ModelInfo, ProviderConfig, Source, ThinkingLevel } from "./types";

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Web pages the provider's own search used (cumulative list). */
  | { type: "sources"; sources: Source[] }
  | { type: "status"; text: string };

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
  signal?: AbortSignal;
};

/** Stream a reply from any supported provider as text and reasoning deltas. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const { url, init } = buildRequest(req);
  init.headers = withCustomHeaders(init.headers, req.provider.headers);
  const res = await providerFetch(url, { ...init, signal: req.signal }, req.useProxy);
  if (!res.ok) throw new Error(await describeHttpError(res));

  const parse = createParser(req.provider);
  for await (const data of sseData(res)) {
    if (data === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error || json.type === "error") throw new Error(errorText(json.error ?? json));
    yield* parse(json);
  }
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

function buildRequest(req: ChatRequest): { url: string; init: FetchInit } {
  const { provider } = req;
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const history = req.messages.filter((m) => !m.error && (m.content || m.attachments?.length));

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
    if (req.nativeSearch) {
      // Server-side web search; the dynamic-filtering version needs Claude 4.6 or newer.
      body.tools = [{ type: legacy ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: 5 }];
    }
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
    const body = {
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
      ...(req.nativeSearch ? { tools: [{ google_search: {} }] } : {}),
    };
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
  return { url: `${base}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

/** Turns provider stream chunks into events. Stateful: sources and citations build up over the stream. */
function createParser(provider: ProviderConfig): (json: any) => Generator<StreamEvent> {
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
    return function* (json) {
      if (json.type === "content_block_start") {
        const block = json.content_block ?? {};
        if (block.type === "server_tool_use") yield { type: "status", text: "Searching the web…" };
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) addSource(r.url, r.title, r.page_age ? `Updated ${r.page_age}` : "");
          yield { type: "sources", sources: [...sources] };
        }
      } else if (json.type === "content_block_delta") {
        const delta = json.delta ?? {};
        if (delta.type === "text_delta" && delta.text) yield { type: "text", text: delta.text };
        if (delta.type === "thinking_delta" && delta.thinking) yield { type: "reasoning", text: delta.thinking };
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
    };
  }

  if (provider.kind === "gemini") {
    return function* (json) {
      const candidate = json.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text !== "string" || !part.text) continue;
        yield { type: part.thought ? "reasoning" : "text", text: part.text };
      }
      const chunks: any[] = candidate?.groundingMetadata?.groundingChunks ?? [];
      if (chunks.length) {
        for (const c of chunks) addSource(c.web?.uri, c.web?.title);
        yield { type: "sources", sources: [...sources] };
      }
    };
  }

  return function* (json) {
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
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
    if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
  };
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
