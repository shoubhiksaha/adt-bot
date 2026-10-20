// @vitest-environment node
// Voice mode: a tool that needs the user's OK is asked aloud instead of refused.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Bot, ProviderConfig, ToolCallRecord } from "../types";
import { askAloudDetail, askAloudText } from "./asks";
import { runToolLoop } from "./loop";
import { yesOrNo } from "../voice-commands";
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

async function run(tools: AgentTool[], onCalls?: (c: ToolCallRecord[]) => void, extra: Record<string, unknown> = {}) {
  const controller = new AbortController();
  let records: ToolCallRecord[] = [];
  await runToolLoop({
    request: { provider: provider(), model: "m", system: "sys", messages: [{ id: "u", role: "user", content: "Go", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, signal: controller.signal },
    tools,
    context: { bot, conversationId: "c", settings: useStore.getState().settings, providers: [provider()], platform: "web", signal: controller.signal, progress: () => undefined, ...extra },
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

describe("approvals in voice mode", () => {
  it("asks aloud and runs the tool when the user says yes", async () => {
    calls([{ name: "save_note", q: "groceries" }]);
    const asked: string[] = [];
    const records = await run([write], undefined, {
      unattended: true,
      askAloud: async ({ summary }: { summary: string }) => {
        asked.push(summary);
        return "allow";
      },
    });
    expect(asked).toEqual(["Can I use save note? Say yes or no."]);
    expect(runs["save_note:groceries"]).toBe(1);
    expect(records[0].status).toBe("done");
  });

  it("doesn't run it when the user says no, and tells the model", async () => {
    calls([{ name: "save_note", q: "x" }]);
    const records = await run([write], undefined, { unattended: true, askAloud: async () => "deny" });
    expect(runs["save_note:x"]).toBeUndefined();
    expect(records[0].status).toBe("denied");
    expect(bodies[1].messages.find((m: any) => m.role === "tool").content).toMatch(/declined/);
  });

  it("still refuses when nobody can be asked (routines, bot-to-bot)", async () => {
    calls([{ name: "save_note", q: "y" }]);
    const records = await run([write], undefined, { unattended: true });
    expect(runs["save_note:y"]).toBeUndefined();
    expect(records[0].result).toMatch(/not possible in voice mode/);
  });
});

describe("spoken answers and questions", () => {
  it("understands yes and no, in a few languages, and nothing else", () => {
    for (const yes of ["Yes", "yeah sure", "OK go ahead", "do it.", "haan", "ha ji", "theek hai", "allow it"]) expect(yesOrNo(yes), yes).toBe("allow");
    for (const no of ["No", "nope", "don't", "cancel that", "nahi", "na", "never mind"]) expect(yesOrNo(no), no).toBe("deny");
    for (const neither of ["what is the weather", "", "yes no", "tell me more about the routine before I decide anything at all please"]) expect(yesOrNo(neither), neither).toBeNull();
  });

  it("words the question to be spoken", () => {
    // A routine is asked about by what it will do on every run, not only its name.
    expect(askAloudText({ name: "create_routine", args: { name: "Morning AI news", instruction: "summarise AI news" } })).toBe(
      "Can I create a routine: Morning AI news, which will: summarise AI news? Say yes or no.",
    );
    expect(askAloudText({ name: "run_command", args: { command: "npm test" } })).toBe("Can I run a command: npm test? Say yes or no.");
    // A long command isn't cut off silently: the rest is pointed to on screen, where it's shown in full.
    const long = `echo checking your calendar and then tidying up the downloads folder for you right away; ${"x ".repeat(40)}rm -rf ~/Documents`;
    const spoken = askAloudText({ name: "run_command", args: { command: long } });
    expect(spoken).toMatch(/The rest is on your screen\. Say yes or no\.$/);
    expect(askAloudDetail({ name: "run_command", args: { command: long } })).toContain("rm -rf ~/Documents");
  });
});
