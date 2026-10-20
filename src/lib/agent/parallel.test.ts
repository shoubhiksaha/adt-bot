// @vitest-environment node
// One model step asking for several tools: lookups run together, everything else in order.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Bot, ProviderConfig, ToolCallRecord } from "../types";
import { decide } from "./approvals";
import { COMPUTER_GUIDANCE, runToolLoop } from "./loop";
import { type AgentTool, registerTool } from "./tools";

vi.mock("../transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const sse = (events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

let server: Server;
let base = "";
const bodies: any[] = [];
let script: (n: number) => string = () => "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(script(bodies.length));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => server.close());

/** When each tool call started and ended, to see what overlapped. */
let log: { name: string; arg: string; start: number; end: number }[] = [];
let runs: Record<string, number> = {};
beforeEach(() => {
  bodies.length = 0;
  log = [];
  runs = {};
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    group: "test",
    risk: "read",
    description: name,
    parameters: { type: "object", properties: { q: { type: "string" }, ms: { type: "number" } } },
    async run(args) {
      const entry = { name, arg: String(args.q), start: performance.now(), end: 0 };
      log.push(entry);
      runs[`${name}:${args.q}`] = (runs[`${name}:${args.q}`] ?? 0) + 1;
      await sleep(Number(args.ms ?? 40));
      entry.end = performance.now();
      return `${name} result for ${args.q}`;
    },
    ...extra,
  };
}
const lookA = tool("look_a");
const lookB = tool("look_b");
const write = tool("save_note", { risk: "write" });
const screen = tool("mac_peek", { group: "mac" });
// A test stand-in for the built-in page reader (same name, so same-turn reuse applies).
const readUrl = tool("read_url");
for (const t of [lookA, lookB, write, screen, readUrl]) registerTool(t);

const bot: Bot = {
  id: "b1", name: "ADT", avatar: "⚡", description: "", systemPrompt: "", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0,
};
const provider: () => ProviderConfig = () => ({ id: "p", presetId: "custom", name: "P", kind: "openai", baseUrl: base, apiKey: "k", models: [] });

/** One step asking for these calls (in this order), then a plain answer. */
function calls(list: { name: string; q: string; ms?: number }[], steps = 1) {
  script = (n) =>
    n <= steps
      ? sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: list.map((c, i) => ({ index: i, id: `call_${n}_${i}`, function: { name: c.name, arguments: JSON.stringify({ q: c.q, ms: c.ms ?? 40 }) } })),
                },
              },
            ],
          },
          "[DONE]",
        ])
      : sse([{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"]);
}

async function run(tools: AgentTool[], onCalls?: (c: ToolCallRecord[]) => void) {
  const controller = new AbortController();
  let records: ToolCallRecord[] = [];
  await runToolLoop({
    request: { provider: provider(), model: "m", system: "sys", messages: [{ id: "u", role: "user", content: "Go", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, signal: controller.signal },
    tools,
    context: { bot, conversationId: "c", settings: useStore.getState().settings, providers: [provider()], platform: "web", signal: controller.signal, progress: () => undefined },
    mode: "native",
    maxSteps: 4,
    callbacks: {
      onEvent: () => undefined,
      onCalls: (c) => {
        records = c;
        onCalls?.(c);
      },
    },
  });
  return records;
}

const overlap = (a: (typeof log)[number], b: (typeof log)[number]) => a.start < b.end && b.start < a.end;

describe("parallel tool calls", () => {
  it("runs neighbouring lookups at the same time and keeps results in the model's order", async () => {
    // The first call is the slow one, so it finishes last.
    calls([
      { name: "look_a", q: "1", ms: 80 },
      { name: "look_b", q: "2", ms: 10 },
    ]);
    const records = await run([lookA, lookB]);
    expect(overlap(log[0], log[1])).toBe(true);
    expect(records.map((r) => r.id)).toEqual(["call_1_0", "call_1_1"]);
    const replies = bodies[1].messages.filter((m: any) => m.role === "tool");
    expect(replies.map((m: any) => m.tool_call_id)).toEqual(["call_1_0", "call_1_1"]);
    expect(replies[0].content).toContain("look_a result for 1");
  });

  it("screen and app tools run one at a time", async () => {
    calls([
      { name: "mac_peek", q: "1" },
      { name: "mac_peek", q: "2" },
    ]);
    // Read-only, so it runs without asking; still one at a time.
    await run([screen]);
    expect(log).toHaveLength(2);
    expect(overlap(log[0], log[1])).toBe(false);
  });

  it("calls that need approval wait their turn: one card at a time, and lookups after them don't jump ahead", async () => {
    calls([
      { name: "save_note", q: "1" },
      { name: "save_note", q: "2" },
      { name: "look_a", q: "3" },
    ]);
    let mostWaiting = 0;
    const records = await run([write, lookA], (c) => {
      const waiting = c.filter((x) => x.status === "awaiting");
      mostWaiting = Math.max(mostWaiting, waiting.length);
      for (const w of waiting) setTimeout(() => decide(write, { id: w.id, name: w.name, args: w.args }, "once"), 15);
    });
    expect(mostWaiting).toBe(1);
    expect(log.map((l) => l.arg)).toEqual(["1", "2", "3"]);
    expect(log[2].start).toBeGreaterThanOrEqual(log[1].end);
    expect(records.every((r) => r.status === "done")).toBe(true);
  });
});

describe("same-turn reuse of lookups", () => {
  it("an identical page read later in the turn reuses the first result", async () => {
    calls(
      [
        { name: "read_url", q: "https://a.example", ms: 5 },
        { name: "read_url", q: "https://a.example", ms: 5 },
        { name: "read_url", q: "https://b.example", ms: 5 },
      ],
      2,
    );
    const records = await run([readUrl]);
    // Two steps of three calls: a.example and b.example are each read once.
    expect(runs).toEqual({ "read_url:https://a.example": 1, "read_url:https://b.example": 1 });
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.status === "done")).toBe(true);
    const replies = bodies[2].messages.filter((m: any) => m.role === "tool");
    expect(replies[1].content).toContain("read_url result for https://a.example");
    expect(replies[1].content).toContain("Same call as earlier");
  });

  it("screen tools are never reused", async () => {
    calls([{ name: "mac_peek", q: "1" }], 2);
    await run([screen]);
    expect(runs["mac_peek:1"]).toBe(2);
  });
});

describe("computer guidance", () => {
  it("asks for the evidence before calling a task done", () => {
    expect(COMPUTER_GUIDANCE).toMatch(/what you saw that shows it/);
  });
});
