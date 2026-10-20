// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../llm";
import { useStore } from "../store";
import type { Bot, ProviderConfig } from "../types";
import { claimsSuccess, runToolLoop, unseenAction, verifyNote } from "./loop";
import { type AgentTool, registerTool } from "./tools";

vi.mock("../transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const sse = (events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
const say = (text: string) => sse([{ choices: [{ delta: { content: text } }] }, "[DONE]"]);
const callTool = (name: string, args: Record<string, unknown> = {}, id = `call_${name}`) =>
  sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }, "[DONE]"]);

let server: Server;
let base = "";
const bodies: any[] = [];
let replies: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(replies.shift() ?? say("(no more replies)"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  // Full access: screen actions run without approval cards.
  useStore.setState((s) => ({ settings: { ...s.settings, agent: { ...s.settings.agent, enabled: true, access: "full" } } }));
});
afterAll(() => server.close());

const bot: Bot = {
  id: "b1", name: "ADT", avatar: "⚡", description: "", systemPrompt: "", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0,
};
const provider: ProviderConfig = { id: "p", presetId: "custom", name: "P", kind: "openai", baseUrl: "", apiKey: "k", models: [] };

const tap: AgentTool = {
  name: "mac_click",
  group: "mac",
  risk: "write",
  description: "Click",
  parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
  run: async () => "Clicked.",
};
const press: AgentTool = {
  name: "mac_press",
  group: "mac",
  risk: "write",
  description: "Press",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  run: async () => ({ content: "Pressed Send.\n\nNow:\n[1] row \"hello\"", observed: true }),
};
const look: AgentTool = {
  name: "mac_ui",
  group: "mac",
  risk: "read",
  description: "Look",
  parameters: { type: "object", properties: {} },
  run: async () => '[1] row "hello" (sent)',
};
const lookup: AgentTool = {
  name: "lookup_order",
  group: "test",
  risk: "read",
  description: "Look up an order",
  parameters: { type: "object", properties: { id: { type: "string" } } },
  run: async () => "Order 42 shipped.",
};
for (const t of [tap, press, look, lookup]) registerTool(t);

async function run(script: string[], tools: AgentTool[] = [tap, press, look]) {
  bodies.length = 0;
  replies = script;
  const events: StreamEvent[] = [];
  const controller = new AbortController();
  await runToolLoop({
    request: { provider: { ...provider, baseUrl: base }, model: "m", system: "sys", messages: [{ id: "u", role: "user", content: "Send hello to Sam", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, signal: controller.signal },
    tools,
    context: { bot, conversationId: "c", settings: useStore.getState().settings, providers: [provider], platform: "desktop", signal: controller.signal, progress: () => undefined },
    mode: "native",
    maxSteps: 8,
    callbacks: { onEvent: (e) => events.push(e), onCalls: () => undefined },
  });
  return events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
}

const lastToolMessage = (body: any) => body.messages.filter((m: any) => m.role === "tool").at(-1)?.content ?? "";

describe("verify before done (screen tasks)", () => {
  it("sends a 'done' after an unchecked click back for one look, and never shows it", async () => {
    const text = await run([callTool("mac_click", { x: 1, y: 2 }), say("Done, sent!"), callTool("mac_ui"), say("Your message now shows in the chat with Sam.")]);
    expect(bodies).toHaveLength(4);
    expect(lastToolMessage(bodies[1])).not.toContain("ADT Bot: nothing has looked");
    expect(lastToolMessage(bodies[2])).toContain(verifyNote("mac_click"));
    expect(text).not.toContain("Done, sent!");
    expect(text).toContain("now shows in the chat with Sam");
  });

  it("doesn't ask again when the model already looked after its last action", async () => {
    const text = await run([callTool("mac_click"), callTool("mac_ui"), say("Done: it shows as sent.")]);
    expect(bodies).toHaveLength(3);
    expect(text).toBe("Done: it shows as sent.");
  });

  it("counts an action that returns the window afterwards as a look", async () => {
    const text = await run([callTool("mac_press", { text: "Send" }), say("Sent: it's in the chat.")]);
    expect(bodies).toHaveLength(2);
    expect(text).toBe("Sent: it's in the chat.");
  });

  it("an action after the last look needs a new look", async () => {
    await run([callTool("mac_ui"), callTool("mac_click"), say("Done."), say("Done (checked).")]);
    expect(bodies).toHaveLength(4);
    expect(lastToolMessage(bodies[3])).toContain(verifyNote("mac_click"));
  });

  it("asks at most once: a second 'done' without looking is shown", async () => {
    const text = await run([callTool("mac_click"), say("Done."), say("Done, really.")]);
    expect(bodies).toHaveLength(3);
    expect(text).toBe("Done, really.");
  });

  it("lets an answer that doesn't claim success through", async () => {
    const text = await run([callTool("mac_click"), say("I clicked it but couldn't confirm the message went out.")]);
    expect(bodies).toHaveLength(2);
    expect(text).toContain("couldn't confirm");
  });

  it("leaves turns without screen actions alone", async () => {
    const text = await run([callTool("lookup_order", { id: "42" }), say("Done: it shipped.")], [lookup, look]);
    expect(bodies).toHaveLength(2);
    expect(text).toBe("Done: it shipped.");
  });

  it("still streams narration that comes with tool calls", async () => {
    const narrated = sse([
      { choices: [{ delta: { content: "Checking the chat. " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c_ui", function: { name: "mac_ui", arguments: "{}" } }] } }] },
      "[DONE]",
    ]);
    const text = await run([callTool("mac_click"), narrated, say("Done: sent.")]);
    expect(bodies).toHaveLength(3);
    expect(text).toContain("Checking the chat.");
    expect(text).toContain("Done: sent.");
  });
});

describe("verify helpers", () => {
  it("recognises claims of success, not admissions or questions", () => {
    expect(claimsSuccess("Done — your message now shows in the chat.")).toBe(true);
    expect(claimsSuccess("I've sent it to Sam.")).toBe(true);
    expect(claimsSuccess("The playlist should now be playing.")).toBe(true);
    expect(claimsSuccess("I couldn't find the Send button.")).toBe(false);
    expect(claimsSuccess("I clicked it, but I haven't confirmed it went through.")).toBe(false);
    expect(claimsSuccess("Which chat do you mean, Sam or Sami?")).toBe(false);
  });

  it("tracks the latest unseen screen action", () => {
    expect(unseenAction(null, tap, {})).toBe("mac_click");
    expect(unseenAction("mac_click", look, {})).toBeNull();
    expect(unseenAction(null, press, {}, true)).toBeNull();
    expect(unseenAction("mac_click", lookup, {})).toBe("mac_click");
    expect(unseenAction("mac_click", { name: "mac_recipes", group: "mac", risk: "read" }, {})).toBe("mac_click");
    // A browser read (risk "read" for this call) is a look.
    expect(unseenAction("mac_key", { name: "mac_browser", group: "mac", risk: "write", riskFor: (a) => (a.action === "read" ? "read" : "write") }, { action: "read" })).toBeNull();
  });
});
