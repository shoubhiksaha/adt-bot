// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../llm";
import { useStore } from "../store";
import type { Bot, ProviderConfig, ToolCallRecord } from "../types";
import { decide } from "./approvals";
import { calculate } from "./builtin";
import { runToolLoop } from "./loop";
import { BareCallFilter, parsePromptedCall, PromptedFilter } from "./prompted";
import { type AgentTool, registerTool } from "./tools";

vi.mock("../transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const sse = (events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

let server: Server;
let base = "";
const bodies: any[] = [];
let script: (body: any, n: number) => string = () => "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(script(body, bodies.length));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => server.close());

const bot: Bot = {
  id: "b1", name: "ADT", avatar: "⚡", description: "", systemPrompt: "Be helpful.", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0,
};
const provider = (kind: ProviderConfig["kind"], baseUrl: string, presetId = "custom"): ProviderConfig => ({ id: "p", presetId, name: "P", kind, baseUrl, apiKey: "k", models: [] });

const ran: Record<string, unknown>[] = [];
const echo: AgentTool = {
  name: "lookup_order",
  group: "test",
  risk: "read",
  description: "Look up an order",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async run(args) {
    ran.push(args);
    return `Order ${args.id} shipped on Monday.`;
  },
};
const refund: AgentTool = {
  name: "refund_order",
  group: "test",
  risk: "write",
  description: "Refund an order",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async run(args) {
    ran.push({ refunded: args.id });
    return "Refunded.";
  },
};
registerTool(echo);
registerTool(refund);

async function run(p: ProviderConfig, tools: AgentTool[], mode: "auto" | "native" | "prompted" = "auto", onCalls?: (c: ToolCallRecord[]) => void) {
  const events: StreamEvent[] = [];
  let calls: ToolCallRecord[] = [];
  const controller = new AbortController();
  await runToolLoop({
    request: { provider: p, model: "m", system: "sys", messages: [{ id: "u", role: "user", content: "Where is order 42?", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, signal: controller.signal },
    tools,
    context: { bot, conversationId: "c", settings: useStore.getState().settings, providers: [p], platform: "web", signal: controller.signal, progress: () => undefined },
    mode,
    maxSteps: 4,
    callbacks: {
      onEvent: (e) => events.push(e),
      onCalls: (c) => {
        calls = c;
        onCalls?.(c);
      },
    },
  });
  return { text: events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""), calls };
}

describe("tool loop: OpenAI-compatible (native)", () => {
  it("runs the tool and replays assistant tool_calls + tool results", async () => {
    bodies.length = 0;
    ran.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([
            { choices: [{ delta: { content: "Checking. " } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup_order", arguments: '{"id":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"42"}' } }] } }] },
            "[DONE]",
          ])
        : sse([{ choices: [{ delta: { content: "It shipped Monday." } }] }, "[DONE]"]);
    const { text, calls } = await run(provider("openai", base), [echo]);
    expect(ran).toEqual([{ id: "42" }]);
    expect(calls[0]).toMatchObject({ name: "lookup_order", status: "done" });
    expect(text).toContain("It shipped Monday.");
    expect(bodies[0].tools[0].function.name).toBe("lookup_order");
    const replay = bodies[1].messages.slice(-2);
    expect(replay[0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1", function: { name: "lookup_order", arguments: '{"id":"42"}' } }] });
    expect(replay[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(replay[1].content).toContain("shipped on Monday");
    expect(bodies[1].messages[0].content).toContain("untrusted data");
  });
});

describe("tool loop: Anthropic", () => {
  it("replays thinking blocks (with signature) and tool_use exactly, then sends tool_result", async () => {
    bodies.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Need the order." } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup_order", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"id": "42"}' } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "tool_use" } },
          ])
        : sse([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Shipped." } }]);
    const { text } = await run(provider("anthropic", base, "anthropic"), [echo]);
    expect(text).toBe("Shipped.");
    expect(bodies[0].tools.at(-1)).toMatchObject({ name: "lookup_order", input_schema: { type: "object" } });
    const [assistant, user] = bodies[1].messages.slice(-2);
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "Need the order.", signature: "sig123" });
    expect(assistant.content[1]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "lookup_order", input: { id: "42" } });
    expect(user.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
  });
});

describe("tool loop: Gemini", () => {
  it("replays the model's parts (thought signatures) and sends functionResponse", async () => {
    bodies.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "lookup_order", args: { id: "42" } }, thoughtSignature: "ts1" }] } }] }])
        : sse([{ candidates: [{ content: { parts: [{ text: "Shipped Monday." }] } }] }]);
    const { text } = await run(provider("gemini", base, "google"), [echo]);
    expect(text).toBe("Shipped Monday.");
    expect(bodies[0].tools[0].functionDeclarations[0].name).toBe("lookup_order");
    const [model, user] = bodies[1].contents.slice(-2);
    expect(model).toEqual({ role: "model", parts: [{ functionCall: { name: "lookup_order", args: { id: "42" } }, thoughtSignature: "ts1" }] });
    expect(user.parts[0].functionResponse).toMatchObject({ name: "lookup_order", response: { content: expect.stringContaining("Monday") } });
  });
});

describe("tool loop: text protocol for models without native tools", () => {
  it("falls back automatically when the model rejects tools, and hides the markup", async () => {
    bodies.length = 0;
    ran.length = 0;
    script = (b, n) => {
      if (b.tools) return ""; // never reached: native attempt fails below
      return n === 2
        ? sse([{ choices: [{ delta: { content: 'Let me check.<tool_' } }] }, { choices: [{ delta: { content: 'call>{"name": "lookup_order", "arguments": {"id": "42", "junk": 1}}</tool_call>' } }] }, "[DONE]"])
        : sse([{ choices: [{ delta: { content: "Shipped Monday." } }] }, "[DONE]"]);
    };
    const failing = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      if (body.tools) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "registry.ollama.ai/library/tiny does not support tools" } }));
        return;
      }
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(script(body, bodies.length + 1));
    });
    await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
    const a = failing.address();
    const url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const { text, calls } = await run(provider("openai", url, "ollama"), [echo]);
    failing.close();
    expect(ran).toEqual([{ id: "42" }]);
    expect(calls[0].status).toBe("done");
    expect(text).not.toContain("<tool_call>");
    expect(text).toContain("Let me check.");
    expect(text).toContain("Shipped Monday.");
    expect(bodies[0].messages[0].content).toContain("<tool_call>");
    expect(bodies[1].messages.at(-1).content).toContain('<tool_result name="lookup_order">');
  });

  it("parses calls leniently and keeps only schema arguments", () => {
    expect(parsePromptedCall('<tool_call>{"name":"lookup_order","id":"7"}</tool_call>', [echo]).call?.args).toEqual({ id: "7" });
    expect(parsePromptedCall("<tool_call>{bad json", [echo]).call).toBeUndefined();
    const filter = new PromptedFilter();
    expect(filter.push("Hello <to")).toBe("Hello ");
    expect(filter.push("day")).toBe("<today");
  });
});

describe("approvals", () => {
  it("asks before risky tools and runs after approval", async () => {
    ran.length = 0;
    let n = 0;
    script = () =>
      ++n === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_r", function: { name: "refund_order", arguments: '{"id":"42"}' } }] } }] }, "[DONE]"])
        : sse([{ choices: [{ delta: { content: "Refunded." } }] }, "[DONE]"]);
    const { calls } = await run(provider("openai", base), [refund], "native", (c) => {
      const waiting = c.find((x) => x.status === "awaiting");
      if (waiting) setTimeout(() => decide(refund, { id: waiting.id, name: waiting.name, args: waiting.args }, "once"), 10);
    });
    expect(ran).toEqual([{ refunded: "42" }]);
    expect(calls[0].status).toBe("done");
  });

  it("refuses anything on the deny list without asking", async () => {
    ran.length = 0;
    const settings = useStore.getState().settings;
    useStore.setState({ settings: { ...settings, agent: { ...settings.agent, denylist: ["42"] } } });
    let n = 0;
    script = () =>
      ++n === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_d", function: { name: "refund_order", arguments: '{"id":"42"}' } }] } }] }, "[DONE]"])
        : sse([{ choices: [{ delta: { content: "I can't do that." } }] }, "[DONE]"]);
    const { calls } = await run(provider("openai", base), [refund], "native");
    useStore.setState({ settings });
    expect(ran).toEqual([]);
    expect(calls[0].status).toBe("denied");
  });
});

describe("calculator", () => {
  it("evaluates safely", () => {
    expect(calculate("2 + 3 * 4")).toBe(14);
    expect(calculate("(1+2)^2 / 3")).toBe(3);
    expect(calculate("sqrt(16) + max(1, 5)")).toBe(9);
    expect(() => calculate("process.exit()")).toThrow();
  });
});

describe("tool discovery", () => {
  const many: AgentTool[] = Array.from({ length: 30 }, (_, i) => ({ ...echo, name: `extra_tool_${i}` }));
  const exposedNames = async (p: ProviderConfig) => {
    bodies.length = 0;
    script = () => sse([{ choices: [{ delta: { content: "Hi." } }] }, "[DONE]"]);
    await run(p, [echo, ...many], "native");
    return (bodies[0].tools ?? []).map((t: any) => t.function.name) as string[];
  };

  it("shows a large cloud model every tool", async () => {
    expect(await exposedNames(provider("openai", base, "openai"))).toHaveLength(31);
  });

  it("gives a local model the core tools plus find_tools", async () => {
    expect(await exposedNames(provider("openai", base, "ollama"))).toEqual(["find_tools"]);
  });
});

describe("bare JSON calls (Llama 3.x via Ollama)", () => {
  it("runs a call the model printed as text, and hides the JSON", async () => {
    bodies.length = 0;
    ran.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([{ choices: [{ delta: { content: "Let me look. {\"name\": \"lookup_" } }] }, { choices: [{ delta: { content: 'order", "parameters": {"id": "42"}}' } }] }, "[DONE]"])
        : sse([{ choices: [{ delta: { content: "Shipped Monday." } }] }, "[DONE]"]);
    const { text, calls } = await run(provider("openai", base, "ollama"), [echo], "native");
    expect(ran).toEqual([{ id: "42" }]);
    expect(calls[0]).toMatchObject({ name: "lookup_order", status: "done" });
    expect(text).not.toContain('"name"');
    expect(text).toContain("Let me look.");
    expect(text).toContain("Shipped Monday.");
    expect(bodies[1].messages.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "lookup_order" } }] });
  });

  it("releases JSON that isn't a tool call", () => {
    const filter = new BareCallFilter();
    const shown = filter.push('Here: {"name": "Bob", "age": 3}') + filter.push(" done");
    const end = filter.finish([echo]);
    expect(end.call).toBeUndefined();
    expect(shown + end.tail).toBe('Here: {"name": "Bob", "age": 3} done');
  });

  it("holds back only what could start a call", () => {
    const filter = new BareCallFilter();
    expect(filter.push("Total {")).toBe("Total ");
    expect(filter.push("x}")).toBe("{x}");
    expect(filter.push(" ```js")).toBe(" ");
    expect(filter.push("\nlet a")).toBe("```js\nlet a");
  });
});
