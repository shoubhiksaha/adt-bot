// @vitest-environment node
// What each provider is sent, per model: thinking and effort, caching, compaction, betas, and the
// replies that need special handling (paused searches, refusals, fallbacks, full context windows).
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, contextLimit, fitToContext, streamChat, type ChatRequest, type StreamEvent, type ToolTurn } from "./llm";
import type { Message, ProviderConfig } from "./types";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init) }));

const sse = (events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

let server: Server;
let base = "";
const seen: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
/** What the fake server answers: an SSE body, or a status with a JSON error. */
let reply: (body: any, n: number) => string | { status: number; error: string } = () => "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ headers: req.headers, body });
    const out = reply(body, seen.length);
    if (typeof out !== "string") {
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: out.error } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(out);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen.length = 0;
  reply = () => claudeText("ok");
});

let ids = 0;
const provider = (kind: ProviderConfig["kind"], presetId: string, models: ProviderConfig["models"] = []): ProviderConfig => ({
  // A fresh id each time: providers that turned a beta down are remembered by id.
  id: `p${++ids}`,
  presetId,
  name: "P",
  kind,
  baseUrl: kind === "gemini" ? `${base}/v1beta` : kind === "openai" ? `${base}/v1` : base,
  apiKey: "k",
  models,
});
const user = (content: string, extra: Partial<Message> = {}): Message => ({ id: `m${++ids}`, role: "user", content, createdAt: 0, ...extra });
const request = (p: ProviderConfig, model: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: p,
  model,
  system: "Be brief.",
  messages: [user("hi")],
  temperature: null,
  thinking: "off",
  useProxy: false,
  ...extra,
});

async function collect(req: ChatRequest) {
  const events: StreamEvent[] = [];
  for await (const e of streamChat(req)) events.push(e);
  return {
    events,
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.find((e) => e.type === "tool_calls") as Extract<StreamEvent, { type: "tool_calls" }> | undefined,
  };
}

const claudeText = (text: string, stop = "end_turn") =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop } },
  ]);
const claudeToolUse = (id: string, extraBefore: unknown[] = [], stop = "tool_use") =>
  sse([
    ...extraBefore,
    { type: "content_block_start", index: 9, content_block: { type: "tool_use", id, name: "lookup", input: {} } },
    { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
    { type: "content_block_stop", index: 9 },
    { type: "message_delta", delta: { stop_reason: stop } },
  ]);
const lookup = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } } } };

const CURRENT = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"];
const betasOf = (h: Record<string, unknown>) => String(h["anthropic-beta"] ?? "").split(",").filter(Boolean);

describe("Claude: thinking and effort are valid for every current model", () => {
  it("never sends disabled thinking or a budget; 'off' becomes low effort for voice and short requests", async () => {
    for (const model of CURRENT) {
      for (const extra of [{}, { fast: true }, { thinking: "high" as const }, { thinking: "low" as const, fast: true }]) {
        seen.length = 0;
        await collect(request(provider("anthropic", "anthropic"), model, extra));
        const body = seen[0].body;
        expect(body.thinking?.type ?? "adaptive", `${model} ${JSON.stringify(extra)}`).toBe("adaptive");
        expect(body.thinking?.budget_tokens).toBeUndefined();
        expect(body).not.toHaveProperty("temperature");
        if ("thinking" in extra) {
          expect(body.thinking).toMatchObject({ type: "adaptive", display: "summarized" });
          expect(body.output_config).toEqual({ effort: extra.thinking });
        } else if ("fast" in extra) {
          expect(body.output_config).toEqual({ effort: "low" });
        }
      }
    }
  });

  it("models that always think state it explicitly, with the thinking safety net, from the first step", async () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"]) {
      seen.length = 0;
      await collect(request(provider("anthropic", "anthropic"), model));
      expect(seen[0].body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(betasOf(seen[0].headers)).toContain("thinking-binding-controls-2026-08-01");
    }
    // Opus 4.8 with thinking off doesn't think, so there's nothing to bind.
    seen.length = 0;
    await collect(request(provider("anthropic", "anthropic"), "claude-opus-4-8"));
    expect(seen[0].body).not.toHaveProperty("thinking");
  });

  it("older models keep a thinking budget and accept temperature", async () => {
    await collect(request(provider("anthropic", "anthropic"), "claude-haiku-4-5", { thinking: "medium" }));
    expect(seen[0].body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    seen.length = 0;
    await collect(request(provider("anthropic", "anthropic"), "claude-haiku-4-5", { temperature: 0.3 }));
    expect(seen[0].body.temperature).toBe(0.3);
    expect(seen[0].body).not.toHaveProperty("context_management");
    expect(betasOf(seen[0].headers)).toEqual([]);
  });

  it("titles and search queries (complete) ask for low effort", async () => {
    await complete({ provider: provider("anthropic", "anthropic"), model: "claude-opus-5-5", system: "Title", messages: [user("hi")], useProxy: false });
    expect(seen[0].body.output_config).toEqual({ effort: "low" });
  });
});

describe("Claude on Anthropic's API: caching, compaction and fallbacks", () => {
  it("caches the system prompt and the growing history, compacts long conversations, and falls back on refusals", async () => {
    await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { tools: [lookup] }));
    const { body, headers } = seen[0];
    expect(body.system).toEqual([{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.context_management).toEqual({ edits: [{ type: "compact_20260112" }] });
    expect(body.fallbacks).toBe("default");
    expect(betasOf(headers).sort()).toEqual(["compact-2026-01-12", "server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"]);
    expect(body.max_tokens).toBe(64000);
  });

  it("compaction and fallbacks only where the model supports them", async () => {
    await collect(request(provider("anthropic", "anthropic"), "claude-sonnet-4-6"));
    expect(seen[0].body.context_management).toBeDefined();
    expect(seen[0].body).not.toHaveProperty("fallbacks");
    expect(betasOf(seen[0].headers)).toEqual(["compact-2026-01-12"]);
  });

  it("Anthropic-compatible servers get none of the betas", async () => {
    await collect(request(provider("anthropic", "custom"), "claude-opus-5-5", { tools: [lookup] }));
    const { body, headers } = seen[0];
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBe("Be brief.");
    for (const key of ["cache_control", "context_management", "fallbacks", "thinking"]) expect(body).not.toHaveProperty(key);
  });

  it("web search: dynamic filtering on current models, the basic tool on older ones", async () => {
    await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { nativeSearch: true }));
    await collect(request(provider("anthropic", "anthropic"), "claude-haiku-4-5", { nativeSearch: true }));
    expect(seen[0].body.tools[0]).toMatchObject({ type: "web_search_20260209", name: "web_search" });
    expect(seen[1].body.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search" });
  });

  it("a rejected optional feature is retried without the betas, and remembered", async () => {
    const p = provider("anthropic", "anthropic");
    reply = (body) => (body.context_management ? { status: 400, error: "context_management: Extra inputs are not permitted" } : claudeText("ok"));
    const out = await collect(request(p, "claude-opus-5-5", { nativeSearch: true }));
    expect(out.text).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[1].headers["anthropic-beta"]).toBeUndefined();
    for (const key of ["context_management", "fallbacks"]) expect(seen[1].body).not.toHaveProperty(key);
    expect(seen[1].body.tools[0].type).toBe("web_search_20250305");
    await collect(request(p, "claude-opus-5-5"));
    expect(seen).toHaveLength(3);
    expect(seen[2].body).not.toHaveProperty("context_management");
  });

  it("history that no longer matches its thinking: retried once without the thinking blocks", async () => {
    const turn: ToolTurn = {
      raw: [
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
      text: "",
      calls: [{ id: "toolu_1", name: "lookup", args: { q: "x" } }],
      results: [{ id: "toolu_1", name: "lookup", content: "found" }],
    };
    reply = (_b, n) =>
      n === 1
        ? { status: 400, error: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." }
        : claudeText("done");
    const out = await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { tools: [lookup], toolTurns: [turn] }));
    expect(out.text).toBe("done");
    expect(seen[0].body.messages.at(-2).content[0].type).toBe("thinking");
    expect(seen[1].body.messages.at(-2).content).toEqual([{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }]);
  });
});

describe("Claude replies that need special handling", () => {
  it("a paused web search is resumed by sending the paused turn back unchanged", async () => {
    reply = (_b, n) =>
      n === 1
        ? sse([
            { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"news"}' } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://a.example", title: "A", encrypted_content: "enc" }] } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "pause_turn" } },
          ])
        : claudeText("Here's the news.");
    const out = await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { nativeSearch: true }));
    expect(out.text).toBe("Here's the news.");
    expect(seen).toHaveLength(2);
    const last = seen[1].body.messages.at(-1);
    expect(last.role).toBe("assistant");
    expect(last.content[0]).toEqual({ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "news" } });
    expect(last.content[1]).toMatchObject({ type: "web_search_tool_result", content: [{ encrypted_content: "enc" }] });
  });

  it("a refused reply never runs the tool it started", async () => {
    reply = () => claudeToolUse("toolu_r", [], "refusal");
    const out = await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { tools: [lookup] }));
    expect(out.calls).toBeUndefined();
    expect(out.text).toContain("declined");
  });

  it("after a mid-reply fallback, only the new model's tool calls run, and the declined part is replayed as the API asks", async () => {
    reply = () =>
      claudeToolUse("toolu_new", [
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "old" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me " } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_old", name: "lookup", input: {} } },
        { type: "content_block_stop", index: 2 },
        { type: "content_block_start", index: 3, content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } } },
        { type: "content_block_stop", index: 3 },
      ]);
    const out = await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { tools: [lookup] }));
    expect(out.calls?.calls.map((c) => c.id)).toEqual(["toolu_new"]);
    expect((out.calls?.raw as { type: string }[]).map((b) => b.type)).toEqual(["text", "fallback", "tool_use"]);
  });

  it("a full context window is reported, and a cut-off tool call isn't run", async () => {
    reply = () => claudeText("Partial", "model_context_window_exceeded");
    const out = await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5"));
    expect(out.text).toContain("filled the model's context window");
    reply = () => claudeToolUse("toolu_x", [], "max_tokens");
    await expect(collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { tools: [lookup] }))).rejects.toThrow(/output limit/);
  });

  it("citations from Claude's web search go back with their text", async () => {
    const citation = { type: "web_search_result_location", url: "https://a.example", title: "A", encrypted_index: "ix", cited_text: "c" };
    reply = () =>
      claudeToolUse("toolu_c", [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fact" } },
        { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } },
        { type: "content_block_stop", index: 0 },
      ]);
    const out = await collect(request(provider("anthropic", "anthropic"), "claude-opus-5-5", { tools: [lookup], nativeSearch: true }));
    expect((out.calls?.raw as unknown[])[0]).toEqual({ type: "text", text: "Fact", citations: [citation] });
  });

  it("a compaction block is reported, replayed within the turn, and sent back first on later turns", async () => {
    const summary = { type: "compaction", content: "Summary of earlier work." };
    reply = () =>
      claudeToolUse("toolu_k", [
        { type: "content_block_start", index: 0, content_block: { type: "compaction", content: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: summary.content } },
        { type: "content_block_stop", index: 0 },
      ]);
    const p = provider("anthropic", "anthropic");
    const out = await collect(request(p, "claude-opus-5-5", { tools: [lookup] }));
    expect(out.events).toContainEqual({ type: "compaction", block: summary });
    expect((out.calls?.raw as unknown[])[0]).toEqual(summary);

    reply = () => claudeText("ok");
    const history = [user("first"), { id: "a", role: "assistant" as const, content: "Answer", createdAt: 0, compaction: summary }, user("next")];
    seen.length = 0;
    await collect(request(p, "claude-opus-5-5", { messages: history }));
    expect(seen[0].body.messages[1].content).toEqual([summary, { type: "text", text: "Answer" }]);
    // Elsewhere (no server compaction) the summary isn't sent; the full history is.
    seen.length = 0;
    await collect(request(provider("anthropic", "custom"), "claude-opus-5-5", { messages: history }));
    expect(seen[0].body.messages[1].content).toEqual([{ type: "text", text: "Answer" }]);
  });
});

describe("Gemini and OpenAI-compatible", () => {
  const geminiText = () => sse([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]);

  it("Gemini 3 takes a thinking level (low for voice); older Gemini keeps a budget", async () => {
    reply = geminiText;
    await collect(request(provider("gemini", "google"), "gemini-3-pro-preview", { thinking: "medium" }));
    await collect(request(provider("gemini", "google"), "gemini-3.1-flash", { fast: true }));
    await collect(request(provider("gemini", "google"), "gemini-2.5-flash", { thinking: "low" }));
    expect(seen[0].body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "medium" });
    expect(seen[1].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(seen[2].body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
  });

  it("OpenAI-compatible: no reasoning_effort for models known not to reason", async () => {
    reply = () => sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
    await collect(request(provider("openai", "openai", [{ id: "gpt-4o", reasoning: false }]), "gpt-4o", { thinking: "high" }));
    await collect(request(provider("openai", "openai", [{ id: "o4-mini", reasoning: true }]), "o4-mini", { thinking: "high" }));
    await collect(request(provider("openai", "ollama"), "qwen3", { thinking: "low" }));
    expect(seen[0].body).not.toHaveProperty("reasoning_effort");
    expect(seen[1].body.reasoning_effort).toBe("high");
    expect(seen[2].body.reasoning_effort).toBe("low");
    for (const s of seen) expect(s.body).not.toHaveProperty("service_tier");
  });
});

describe("keeping requests inside the context window (providers without server-side compaction)", () => {
  const shot = (n: number) => ({ mediaType: "image/png", data: `IMG${n}` });
  const step = (n: number, size: number, image = false): ToolTurn => ({
    raw: [
      { type: "thinking", thinking: "t", signature: `s${n}` },
      { type: "tool_use", id: `t${n}`, name: "lookup", input: {} },
    ],
    text: "",
    calls: [{ id: `t${n}`, name: "lookup", args: {} }],
    results: [{ id: `t${n}`, name: "lookup", content: `result ${n} `.padEnd(size, "x"), ...(image ? { image: shot(n) } : {}) }],
  });
  const small = (kind: ProviderConfig["kind"], presetId: string) => provider(kind, presetId, [{ id: "m", context: 10_000 }, { id: "claude-opus-5-5", context: 10_000 }]);

  it("leaves requests that fit alone", () => {
    const req = request(small("openai", "custom"), "m", { toolTurns: [step(1, 1000), step(2, 1000)] });
    const fit = fitToContext(req);
    expect(fit.trimmed).toBe(false);
    expect(fit.toolTurns).toBe(req.toolTurns);
    expect(fit.messages).toBe(req.messages);
  });

  it("shortens older tool results first, keeping the newest steps and the latest screenshot", () => {
    const turns = Array.from({ length: 8 }, (_, i) => step(i + 1, 4000, true));
    const fit = fitToContext(request(small("openai", "custom"), "m", { toolTurns: turns }));
    expect(fit.trimmed).toBe(true);
    expect(fit.toolTurns[0].results[0].content).toMatch(/^\[Shortened to save space/);
    expect(fit.toolTurns[0].results[0].image).toBeUndefined();
    expect(fit.toolTurns.at(-1)!.results[0]).toEqual(turns.at(-1)!.results[0]);
    expect(fit.toolTurns.at(-2)!.results[0]).toEqual(turns.at(-2)!.results[0]);
    // Shortened a few steps at a time, so the shortened part changes rarely (prompt caches).
    expect(fit.toolTurns.filter((t) => t.results[0].content.startsWith("[Shortened")).length % 4).toBe(0);
  });

  it("then leaves out the oldest chat messages, keeping the latest question", () => {
    const history: Message[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(user(`question ${i} `.padEnd(4000, "q")));
      history.push({ id: `a${i}`, role: "assistant", content: `answer ${i} `.padEnd(4000, "a"), createdAt: 0 });
    }
    history.push(user("latest question"));
    const fit = fitToContext(request(small("openai", "custom"), "m", { messages: history }));
    expect(fit.trimmed).toBe(true);
    expect(fit.messages.at(-1)!.content).toBe("latest question");
    expect(fit.messages[0].role).toBe("user");
    expect(fit.messages[0].content).toMatch(/^\[Earlier messages in this chat were left out/);
    expect(fit.messages.length).toBeLessThan(history.length);
  });

  it("uses known context sizes, else a cautious default", () => {
    expect(contextLimit({ provider: small("openai", "custom"), model: "m" })).toBe(10_000);
    expect(contextLimit({ provider: provider("openai", "ollama"), model: "llama3.2" })).toBe(32_000);
    expect(contextLimit({ provider: provider("anthropic", "custom"), model: "claude-haiku-4-5" })).toBe(200_000);
  });

  it("on the wire: older results are shortened for OpenAI-compatible servers", async () => {
    reply = () => sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
    const turns = Array.from({ length: 8 }, (_, i) => step(i + 1, 4000));
    await collect(request(small("openai", "custom"), "m", { toolTurns: turns, tools: [lookup] }));
    const toolMessages = seen[0].body.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages[0].content).toMatch(/^\[Shortened/);
    expect(toolMessages.at(-1).content).toMatch(/^result 8/);
  });

  it("Claude elsewhere: shortening drops the replayed thinking (it's bound to the unshortened history)", async () => {
    const turns = Array.from({ length: 8 }, (_, i) => step(i + 1, 4000));
    await collect(request(small("anthropic", "custom"), "claude-opus-5-5", { toolTurns: turns, tools: [lookup] }));
    const assistants = seen[0].body.messages.filter((m: any) => m.role === "assistant");
    expect(assistants.every((m: any) => m.content.every((b: any) => b.type !== "thinking"))).toBe(true);
  });

  it("Claude on Anthropic's API is left to server-side compaction: history and thinking go unchanged", async () => {
    const turns = Array.from({ length: 8 }, (_, i) => step(i + 1, 4000));
    await collect(request(small("anthropic", "anthropic"), "claude-opus-5-5", { toolTurns: turns, tools: [lookup] }));
    const assistants = seen[0].body.messages.filter((m: any) => m.role === "assistant");
    expect(assistants[0].content[0]).toEqual({ type: "thinking", thinking: "t", signature: "s1" });
    expect(seen[0].body.messages.at(-1).content[0].content).toMatch(/^result 8/);
    expect(seen[0].body.messages[2].content[0].content).toMatch(/^result 1/);
  });
});
