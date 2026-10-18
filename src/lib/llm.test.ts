// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProxyHandler, isPrivateAddress, isPrivateHost } from "../../server/proxy.mjs";
import { listModels, splitThink, sseData, streamChat, withCustomHeaders, type StreamEvent } from "./llm";
import { PROVIDER_PRESETS, parseHeaders } from "./providers";
import type { Message, ProviderConfig } from "./types";

vi.mock("./transport", () => ({
  providerFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

const user = (content: string): Message => ({ id: "1", role: "user", content, createdAt: 0 });

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
}

/** A fake model server that speaks all three wire protocols. */
let server: Server;
let base = "";
const seen: { url: string; headers: Record<string, unknown>; body: any }[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "llama3.2" }, { id: "qwen2.5vl" }, { id: "nomic-embed-text" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions" && JSON.parse(raw).model === "missing") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: 'model "missing" not found, try pulling it first' } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (req.url === "/v1/chat/completions") {
      // Split mid-event to exercise buffering.
      const body = sse([
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        "[DONE]",
      ]);
      res.write(body.slice(0, 37));
      setTimeout(() => res.end(body.slice(37)), 5);
    } else if (req.url === "/v1/messages") {
      res.end(
        `event: message_start\n${sse([{ type: "message_start" }])}` +
          sse([
            { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "plan" } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "Hi from Claude" } },
            { type: "message_stop" },
          ]),
      );
    } else {
      res.end(
        sse([
          { candidates: [{ content: { parts: [{ text: "ponder", thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: "Hi from Gemini" }] } }] },
        ]),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => server.close());

const provider = (kind: ProviderConfig["kind"], baseUrl: string): ProviderConfig => ({
  id: "p",
  presetId: "custom",
  name: "test",
  kind,
  baseUrl,
  apiKey: "sk-test",
  models: [],
});

async function collect(gen: AsyncGenerator<StreamEvent>) {
  let text = "";
  let reasoning = "";
  for await (const e of gen) {
    if (e.type === "text") text += e.text;
    else reasoning += e.text;
  }
  return { text, reasoning };
}

const baseReq = { system: "Be brief", temperature: null, thinking: "off" as const, useProxy: false };

describe("streamChat", () => {
  it("streams OpenAI-compatible replies (local LLM servers, xAI, OpenRouter...)", async () => {
    const out = await collect(
      streamChat({ ...baseReq, provider: provider("openai", `${base}/v1`), model: "llama3.2", messages: [user("hi")] }),
    );
    expect(out).toEqual({ text: "Hello", reasoning: "hmm" });
    const req = seen.at(-1)!;
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.body.messages[0]).toEqual({ role: "system", content: "Be brief" });
    expect(req.body.stream).toBe(true);
    expect(req.body).not.toHaveProperty("temperature");
  });

  it("streams Anthropic replies with adaptive thinking on current models", async () => {
    const out = await collect(
      streamChat({
        ...baseReq,
        thinking: "high",
        temperature: 0.7,
        provider: provider("anthropic", base),
        model: "claude-sonnet-5-5",
        messages: [user("hi")],
      }),
    );
    expect(out).toEqual({ text: "Hi from Claude", reasoning: "plan" });
    const req = seen.at(-1)!;
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(req.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.body.output_config).toEqual({ effort: "high" });
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body.system).toBe("Be brief");
  });

  it("uses a thinking budget for older Claude models", async () => {
    await collect(
      streamChat({ ...baseReq, thinking: "low", provider: provider("anthropic", base), model: "claude-haiku-4-5", messages: [user("hi")] }),
    );
    expect(seen.at(-1)!.body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("streams Gemini replies and separates thoughts", async () => {
    const out = await collect(
      streamChat({ ...baseReq, provider: provider("gemini", `${base}/v1beta`), model: "gemini-3.8-flash", messages: [user("hi")] }),
    );
    expect(out).toEqual({ text: "Hi from Gemini", reasoning: "ponder" });
    expect(seen.at(-1)!.url).toBe("/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
    expect(seen.at(-1)!.body.systemInstruction.parts[0].text).toBe("Be brief");
  });

  it("sends images in each provider's format", async () => {
    const withImage: Message = {
      ...user("what is this"),
      attachments: [{ kind: "image", name: "a.png", dataUrl: "data:image/png;base64,AAAA" }],
    };
    await collect(streamChat({ ...baseReq, provider: provider("openai", `${base}/v1`), model: "m", messages: [withImage] }));
    expect(seen.at(-1)!.body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    await collect(streamChat({ ...baseReq, provider: provider("anthropic", base), model: "claude-opus-5-5", messages: [withImage] }));
    expect(seen.at(-1)!.body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("surfaces provider errors with a hint", async () => {
    await expect(
      collect(streamChat({ ...baseReq, provider: provider("openai", `${base}/v1`), model: "missing", messages: [user("hi")] })),
    ).rejects.toThrow(/404.*not found.*Check the model name/);
  });
});

describe("listModels", () => {
  it("reads /models and drops non-chat models", async () => {
    const models = await listModels(provider("openai", `${base}/v1`), false);
    expect(models.map((m) => m.id)).toEqual(["llama3.2", "qwen2.5vl"]);
  });
});

describe("sseData", () => {
  it("handles buffered bodies and CRLF", async () => {
    const res = new Response("data: a\r\n\r\ndata: b\r\n\r\n");
    const out: string[] = [];
    for await (const d of sseData(res)) out.push(d);
    expect(out).toEqual(["a", "b"]);
  });
});

describe("splitThink", () => {
  it("splits inline <think> reasoning from local models", () => {
    expect(splitThink("<think>step 1</think>\n\nAnswer")).toEqual({ reasoning: "step 1", text: "Answer", thinking: false });
    expect(splitThink("<think>still going")).toEqual({ reasoning: "still going", text: "", thinking: true });
    expect(splitThink("plain")).toEqual({ reasoning: "", text: "plain", thinking: false });
  });
});

async function listen(handler: ReturnType<typeof createProxyHandler>) {
  const proxy = createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  return { proxy, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/proxy` };
}

describe("proxy", () => {
  it("relays streams to private model servers and blocks public unknown hosts", async () => {
    const { proxy, url } = await listen(createProxyHandler({ allowPrivate: true }));

    const ok = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-adtbot-target": `${base}/v1/chat/completions` },
      body: JSON.stringify({ model: "llama3.2", messages: [] }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Hel");

    const blocked = await fetch(url, { headers: { "x-adtbot-target": "https://example.com/" } });
    expect(blocked.status).toBe(403);
    proxy.close();
  });

  it("keeps private servers off limits unless allowed", async () => {
    const { proxy, url } = await listen(createProxyHandler({}));
    const res = await fetch(url, { headers: { "x-adtbot-target": `${base}/v1/models` } });
    expect(res.status).toBe(403);
    proxy.close();
  });

  it("only serves localhost pages when bound to loopback (DNS-rebinding guard)", async () => {
    const { proxy, url } = await listen(createProxyHandler({ allowAllHosts: true, loopbackOnly: true }));
    const ok = await fetch(url, { headers: { "x-adtbot-target": `${base}/v1/models` } });
    expect(ok.status).toBe(200);
    const port = new URL(url).port;
    const rebound = await new Promise<number>((resolve) => {
      import("node:http").then(({ request }) => {
        const r = request(
          { host: "127.0.0.1", port, path: "/api/proxy", headers: { host: `evil.example.com:${port}`, "x-adtbot-target": `${base}/v1/models` } },
          (response) => resolve(response.statusCode ?? 0),
        );
        r.end();
      });
    });
    expect(rebound).toBe(403);
    proxy.close();
  });

  it("recognises private networks", async () => {
    for (const ip of ["10.0.0.5", "172.20.1.1", "192.168.1.50", "100.101.102.103", "127.0.0.1", "fd12::1", "::ffff:192.168.0.2"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860::8888"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    expect(await isPrivateHost("gpu-box")).toBe(true);
    expect(await isPrivateHost("llm.mycompany.internal")).toBe(true);
    expect(await isPrivateHost("my-pc.tailnet-1234.ts.net")).toBe(true);
    expect(await isPrivateHost("[fd00::5]")).toBe(true);
    expect(await isPrivateHost("93.184.215.14")).toBe(false);
  });
});

describe("custom headers", () => {
  it("parses header lines and lets them override built-in auth", () => {
    const headers = parseHeaders("Authorization: Basic abc\nCF-Access-Client-Id: id.access\nnot a header\n");
    expect(headers).toEqual({ Authorization: "Basic abc", "CF-Access-Client-Id": "id.access" });
    expect(withCustomHeaders({ authorization: "Bearer key", "content-type": "application/json" }, headers)).toEqual({
      "content-type": "application/json",
      Authorization: "Basic abc",
      "CF-Access-Client-Id": "id.access",
    });
  });

  it("sends them to the provider", async () => {
    await collect(
      streamChat({
        ...baseReq,
        provider: { ...provider("openai", `${base}/v1`), apiKey: "", headers: { "X-Team": "ml" } },
        model: "llama3.2",
        messages: [user("hi")],
      }),
    );
    expect(seen.at(-1)!.headers["x-team"]).toBe("ml");
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
  });
});

describe("presets", () => {
  it("have unique ids and a group", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROVIDER_PRESETS.every((p) => ["cloud", "local", "private"].includes(p.group))).toBe(true);
  });
});
