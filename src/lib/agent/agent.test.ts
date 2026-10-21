// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../llm";
import { useStore } from "../store";
import type { Bot, ProviderConfig, ToolCallRecord } from "../types";
import { decide } from "./approvals";
import { calculate } from "./builtin";
import { runToolLoop, toolsForMessage } from "./loop";
import { BareCallFilter, fitArgs, parsePromptedCall, PromptedFilter } from "./prompted";
import type { ToolSchema } from "./vendor/openbot/types";
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

  it("gives a local model the core tools, the tool its message names, and find_tools", async () => {
    // "Where is order 42?" names lookup_order; the 30 extra tools stay behind find_tools.
    expect(await exposedNames(provider("openai", base, "ollama"))).toEqual(["lookup_order", "find_tools"]);
  });

  it("also lists the tools the user's message names", () => {
    const tool = (name: string, description: string) => ({ name, description });
    const catalog = [
      tool("save_skill", "Save steps as a skill bots reuse later."),
      tool("use_skill", "Follow one of the saved skills."),
      tool("create_routine", "Schedule a task to run later."),
      tool("email_search", "Search the user's email."),
      tool("email_send", "Send an email."),
      tool("list_files", "List files in a folder."),
      tool("calculate", "Do math."),
    ];
    expect(toolsForMessage(catalog, "Please save this as a skill called weekly-check")).toEqual(["save_skill", "use_skill"]);
    expect(toolsForMessage(catalog, "check my emails")).toEqual(expect.arrayContaining(["email_search", "email_send"]));
    // Only generic words of a name ("list", "create") or core tools: nothing extra.
    expect(toolsForMessage(catalog, "list three wins and create a plan, then calculate it")).toEqual([]);
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

  it("repairs a quoted list inside the call", () => {
    const filter = new BareCallFilter();
    filter.push('{"name": "lookup_order", "parameters": {"id": "["42"]"}}');
    expect(filter.finish([echo]).call?.args).toEqual({ id: ["42"] });
  });

  it("repairs quotes escaped as if inside a string (seen from llama3.2)", () => {
    const filter = new BareCallFilter();
    filter.push('{"name":"lookup_order","parameters\\":{\\"id\\":\\"17\\"}}');
    expect(filter.finish([echo]).call?.args).toEqual({ id: "17" });
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

describe("small-model call repairs", () => {
  const readUrl: ToolSchema = { name: "read_url", description: "Read a page", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } };
  const visualize: ToolSchema = { name: "visualize", description: "Chart", parameters: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" } } } };

  it("quotes a bare link and puts it under the argument the tool needs", () => {
    const filter = new BareCallFilter();
    filter.push('{"name":"read_url","parameters":{"query":https://slack.com/}} \n{"type":"function-call"}');
    expect(filter.finish([readUrl]).call).toMatchObject({ name: "read_url", args: { url: "https://slack.com/" } });
  });

  it("repairs escaped quotes and a trailing comma together, inside a fence", () => {
    const filter = new BareCallFilter();
    filter.push('```\n{"name":"visualize","parameters":{"kind":"bar","title":\\"Tools\\",}}\n```');
    expect(filter.finish([visualize]).call?.args).toEqual({ kind: "bar", title: "Tools" });
  });

  it("renames only when it's clear which argument was meant", () => {
    expect(fitArgs({ query: "https://a.example" }, readUrl.parameters)).toEqual({ url: "https://a.example" });
    expect(fitArgs({ query: "a", page: 2 }, readUrl.parameters)).toEqual({ query: "a", page: 2 });
    expect(fitArgs({ url: "https://a.example", extra: 1 }, readUrl.parameters)).toEqual({ url: "https://a.example", extra: 1 });
  });
});

describe("bare calls in the shapes llama3.2 writes", () => {
  it("catches {\"type\": \"function\", \"name\": …} in a fence, without flashing any of it", () => {
    const filter = new BareCallFilter();
    let shown = "";
    for (const piece of ["```", "\n{\"ty", "pe\":\"function\",", "\"name\":\"lookup_order\",\"parameters\":{\"id\":\"9\"}}", "\n```"]) shown += filter.push(piece);
    const end = filter.finish([echo]);
    expect(shown).toBe("");
    expect(end.call).toMatchObject({ name: "lookup_order", args: { id: "9" } });
  });

  it("catches the nested OpenAI shape", () => {
    const filter = new BareCallFilter();
    filter.push('{"type": "function", "function": {"name": "lookup_order", "arguments": "{\\"id\\": \\"5\\"}"}}');
    expect(filter.finish([echo]).call?.args).toEqual({ id: "5" });
  });

  it("lets ordinary braces through once it's clear they aren't a call", () => {
    const filter = new BareCallFilter();
    const shown = filter.push("Use {x} or {\"type\": \"bar\"}") + filter.push(" here.");
    const end = filter.finish([echo]);
    expect(end.call).toBeUndefined();
    expect(shown + end.tail).toBe('Use {x} or {"type": "bar"} here.');
  });

  it("ignores joining words and the app's added context when picking tools", () => {
    const catalog = [{ name: "discuss_with_bots", description: "Have bots discuss" }, { name: "email_search", description: "Search email" }];
    expect(toolsForMessage(catalog, "Check my email. What does Priya want?")).toEqual(["email_search"]);
  });
});

describe("calls to tools that don't exist", () => {
  it("tells the model once and shows its plain answer", async () => {
    bodies.length = 0;
    ran.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([{ choices: [{ delta: { content: '{"name":"write_order", "parameters":{"who":"Meera"}}' } }] }, "[DONE]"])
        : sse([{ choices: [{ delta: { content: "Meera ordered 1 cold coffee for 3.20 EUR." } }] }, "[DONE]"]);
    const { text } = await run(provider("openai", base, "ollama"), [echo], "native");
    expect(text).toBe("Meera ordered 1 cold coffee for 3.20 EUR.");
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].messages.at(-1))).toContain('there\'s no tool called \\"write_order\\"');
  });

  it("shows what it wrote if it does it again, and leaves ordinary JSON alone", async () => {
    bodies.length = 0;
    script = () => sse([{ choices: [{ delta: { content: '{"name":"write_order","parameters":{}}' } }] }, "[DONE]"]);
    expect((await run(provider("openai", base, "ollama"), [echo], "native")).text).toContain("write_order");
    bodies.length = 0;
    script = () => sse([{ choices: [{ delta: { content: 'Here: {"name": "Bob", "age": 3}' } }] }, "[DONE]"]);
    expect((await run(provider("openai", base, "ollama"), [echo], "native")).text).toBe('Here: {"name": "Bob", "age": 3}');
    expect(bodies).toHaveLength(1);
  });
});

describe("a call inside a wrapper the model didn't close", () => {
  it("still finds the call (seen from llama3.2)", () => {
    const filter = new BareCallFilter();
    filter.push('{"type":"function","function":{"name":"lookup_order","description":"Look up","parameters":{"id":"77"}} or {"type":"function","name":"other"');
    expect(filter.finish([echo]).call).toMatchObject({ name: "lookup_order", args: { id: "77" } });
  });
});

describe("a call to one of the bot's tools that wasn't listed this step", () => {
  it("runs it (approvals still apply) instead of calling it made up", async () => {
    bodies.length = 0;
    ran.length = 0;
    const many: AgentTool[] = Array.from({ length: 30 }, (_, i) => ({ ...echo, name: `extra_tool_${i}` }));
    script = (_b, n) => (n === 1 ? sse([{ choices: [{ delta: { content: '{"type":"function","name":"lookup_order","parameters":{"id":"8"}}' } }] }, "[DONE]"]) : sse([{ choices: [{ delta: { content: "Order 8 shipped." } }] }, "[DONE]"]));
    // A message that doesn't name it, so only find_tools would have listed it.
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    const p = provider("openai", base, "ollama");
    await runToolLoop({
      request: { provider: p, model: "m", system: "sys", messages: [{ id: "u", role: "user", content: "Is my parcel on its way?", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, signal: controller.signal },
      tools: [...many, echo],
      context: { bot, conversationId: "c", settings: useStore.getState().settings, providers: [p], platform: "web", signal: controller.signal, progress: () => undefined },
      mode: "native",
      maxSteps: 4,
      callbacks: { onEvent: (e) => events.push(e), onCalls: () => undefined },
    });
    expect((bodies[0].tools ?? []).map((t: any) => t.function.name)).not.toContain("lookup_order");
    expect(ran).toEqual([{ id: "8" }]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Order 8 shipped.");
  });
});
