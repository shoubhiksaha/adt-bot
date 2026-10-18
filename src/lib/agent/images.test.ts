// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Bot, ProviderConfig } from "../types";
import { runToolLoop } from "./loop";
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
  id: "b1", name: "ADT", avatar: "⚡", description: "", systemPrompt: "", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0,
};
const provider = (kind: ProviderConfig["kind"], presetId = "custom", models: ProviderConfig["models"] = []): ProviderConfig => ({
  id: "p", presetId, name: "P", kind, baseUrl: base, apiKey: "k", models,
});

let shots = 0;
const screenshot: AgentTool = {
  name: "take_screenshot",
  group: "test",
  risk: "read",
  description: "Screenshot",
  parameters: { type: "object", properties: {} },
  async run() {
    shots++;
    return { content: `Screenshot ${shots}`, image: { mediaType: "image/jpeg", data: `SHOT${shots}` }, display: { kind: "image", src: "data:image/jpeg;base64,x" } };
  },
};

registerTool(screenshot);

async function run(p: ProviderConfig, model: string, mode: "native" | "prompted" = "native") {
  const controller = new AbortController();
  await runToolLoop({
    request: { provider: p, model, system: "sys", messages: [{ id: "u", role: "user", content: "What's on screen?", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, signal: controller.signal },
    tools: [screenshot],
    context: { bot, conversationId: "c", settings: useStore.getState().settings, providers: [p], platform: "web", signal: controller.signal, progress: () => undefined },
    mode,
    maxSteps: 4,
    callbacks: { onEvent: () => undefined, onCalls: () => undefined },
  });
}

const openaiCall = (id: string) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "take_screenshot", arguments: "{}" } }] } }] }, "[DONE]"]);
const openaiText = sse([{ choices: [{ delta: { content: "A desktop." } }] }, "[DONE]"]);

describe("tool images reach the model", () => {
  it("OpenAI-compatible: tool message text, then a user message with the image", async () => {
    bodies.length = 0;
    script = (_b, n) => (n === 1 ? openaiCall("call_1") : openaiText);
    await run(provider("openai"), "gpt-4o");
    const [tool, user] = bodies[1].messages.slice(-2);
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(tool.content).toContain("Screenshot 1");
    expect(tool.content).toContain("next message");
    expect(user.role).toBe("user");
    expect(user.content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,SHOT1" } });
  });

  it("OpenAI-compatible: models that can't see images get a note instead", async () => {
    bodies.length = 0;
    script = (_b, n) => (n === 1 ? openaiCall("call_2") : openaiText);
    await run(provider("openai", "ollama", [{ id: "llama3.1", vision: false }]), "llama3.1");
    const last = bodies[1].messages.at(-1);
    expect(last.role).toBe("tool");
    expect(last.content).toContain("image isn't included");
    expect(JSON.stringify(bodies[1])).not.toContain("SHOT");
  });

  it("only the newest images are replayed", async () => {
    bodies.length = 0;
    script = (_b, n) => (n <= 3 ? openaiCall(`call_k${n}`) : openaiText);
    await run(provider("openai"), "gpt-4o");
    expect(JSON.stringify(bodies[3])).not.toContain(`base64,SHOT${shots - 2}"`);
    const images = bodies[3].messages.filter((m: any) => Array.isArray(m.content)).flatMap((m: any) => m.content).filter((c: any) => c.type === "image_url");
    expect(images).toHaveLength(2);
    expect(bodies[3].messages.find((m: any) => m.tool_call_id === "call_k1").content).toContain("image isn't included");
  });

  it("Anthropic: the image goes inside the tool_result", async () => {
    bodies.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "take_screenshot", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
            { type: "content_block_stop", index: 0 },
          ])
        : sse([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A desktop." } }]);
    await run(provider("anthropic", "anthropic"), "claude-opus-4-7");
    const user = bodies[1].messages.at(-1);
    expect(user.content[0].type).toBe("tool_result");
    expect(user.content[0].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Screenshot") });
    expect(user.content[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: `SHOT${shots}` } });
  });

  it("Gemini: inlineData follows the functionResponse", async () => {
    bodies.length = 0;
    script = (_b, n) =>
      n === 1
        ? sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "take_screenshot", args: {} } }] } }] }])
        : sse([{ candidates: [{ content: { parts: [{ text: "A desktop." }] } }] }]);
    await run(provider("gemini", "google"), "gemini-2.5-flash");
    const user = bodies[1].contents.at(-1);
    expect(user.parts[0].functionResponse.response.content).toContain("Screenshot");
    expect(user.parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: `SHOT${shots}` } });
  });

  it("text protocol: the image rides on the user message with the result, and turns aren't replayed twice", async () => {
    bodies.length = 0;
    script = (_b, n) =>
      n === 1 ? sse([{ choices: [{ delta: { content: '<tool_call>{"name": "take_screenshot", "arguments": {}}</tool_call>' } }] }, "[DONE]"]) : openaiText;
    await run(provider("openai"), "gpt-4o", "prompted");
    const messages = bodies[1].messages;
    const last = messages.at(-1);
    expect(last.role).toBe("user");
    expect(last.content[0].text).toContain('<tool_result name="take_screenshot">');
    expect(last.content[0].text).toContain("[Image attached.]");
    expect(last.content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/jpeg;base64,SHOT${shots}` } });
    expect(messages.some((m: any) => m.role === "tool" || m.tool_calls)).toBe(false);
  });

  it("text protocol (Anthropic and Gemini formats)", async () => {
    for (const kind of ["anthropic", "gemini"] as const) {
      bodies.length = 0;
      const call = '<tool_call>{"name": "take_screenshot", "arguments": {}}</tool_call>';
      script = (_b, n) =>
        kind === "anthropic"
          ? sse([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: n === 1 ? call : "Done." } }])
          : sse([{ candidates: [{ content: { parts: [{ text: n === 1 ? call : "Done." }] } }] }]);
      await run(provider(kind, kind === "anthropic" ? "anthropic" : "google"), kind === "anthropic" ? "claude-opus-4-7" : "gemini-2.5-flash", "prompted");
      if (kind === "anthropic") {
        const last = bodies[1].messages.at(-1);
        expect(last.content[1]).toMatchObject({ type: "image", source: { data: `SHOT${shots}` } });
        expect(bodies[1].messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
      } else {
        const last = bodies[1].contents.at(-1);
        expect(last.parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: `SHOT${shots}` } });
        expect(bodies[1].contents.filter((c: any) => c.role === "model")).toHaveLength(1);
      }
    }
  });
});
