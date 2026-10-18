// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateImage, resolveImageModel } from "./imagine";
import { messageText, streamChat } from "./llm";
import { linkCitations, splitBlocks } from "./markdown-utils";
import { extractText, findUrls, parseDuckDuckGo, sourcesPrompt } from "./search";
import type { Message, ProviderConfig } from "./types";

vi.mock("./transport", () => ({
  providerFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

let server: Server;
let base = "";
const seen: { url: string; body: any }[] = [];
const PNG = Buffer.from("fake-png").toString("base64");

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url ?? "", body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/or/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "Here you go", images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] }));
    } else if (req.url?.includes(":generateContent")) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A cat" }, { inlineData: { mimeType: "image/png", data: PNG } }] } }] }));
    } else if (req.url === "/anthropic/v1/messages") {
      res.setHeader("content-type", "text/event-stream");
      const events = [
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search" } },
        { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example/a", title: "Story A" }] } },
        { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://news.example/a", title: "Story A", cited_text: "x" } } },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "It rained." } },
        { type: "content_block_stop", index: 2 },
      ];
      res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    } else if (req.url?.includes(":streamGenerateContent")) {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Sunny." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example/r", title: "weather.com" } }] } }] })}\n\n`);
    } else if (req.url === "/pplx/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ search_results: [{ title: "P1", url: "https://p.example/1" }], choices: [{ delta: { content: "Answer [1]" } }] })}\n\ndata: [DONE]\n\n`);
    } else if (req.url === "/v1/images/generations") {
      res.end(JSON.stringify({ data: [{ b64_json: PNG, revised_prompt: "a cat, detailed" }] }));
    } else {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => server.close());

const provider = (kind: ProviderConfig["kind"], baseUrl: string, presetId = "custom"): ProviderConfig => ({
  id: presetId,
  presetId,
  name: presetId,
  kind,
  baseUrl,
  apiKey: "k",
  models: [],
});

describe("files", () => {
  it("inlines attached documents into the message text for every provider", async () => {
    const m: Message = {
      id: "1",
      role: "user",
      content: "Summarize this",
      attachments: [{ kind: "file", name: "notes.pdf", size: 10, text: "--- Page 1 ---\nHello" }],
      createdAt: 0,
    };
    expect(messageText(m)).toBe('<file name="notes.pdf">\n--- Page 1 ---\nHello\n</file>\n\nSummarize this');
    for await (const _ of streamChat({
      provider: provider("openai", `${base}/v1`),
      model: "m",
      system: "",
      messages: [m],
      temperature: null,
      thinking: "off",
      useProxy: false,
    })) {
      // drain
    }
    expect(seen.at(-1)!.body.messages[0].content).toContain("<file name=\"notes.pdf\">");
  });

  it("never sends generated images back on assistant turns", () => {
    const reply: Message = {
      id: "2",
      role: "assistant",
      content: "",
      attachments: [{ kind: "image", name: "a.png", dataUrl: "data:image/png;base64,AA" }],
      createdAt: 0,
    };
    expect(messageText(reply)).toBe("(no text)");
  });
});

describe("imagine", () => {
  it("uses OpenRouter's image modality", async () => {
    const out = await generateImage(provider("openai", `${base}/or`, "openrouter"), "google/gemini-3.1-flash-image", "a cat", false);
    expect(out.images[0]).toBe(`data:image/png;base64,${PNG}`);
    expect(out.text).toBe("Here you go");
    expect(seen.at(-1)!.body.modalities).toEqual(["image", "text"]);
  });

  it("uses Gemini's image output", async () => {
    const out = await generateImage(provider("gemini", `${base}/v1beta`, "google"), "gemini-3.1-flash-image", "a cat", false);
    expect(out.images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(seen.at(-1)!.body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });

  it("uses the OpenAI-style images endpoint elsewhere", async () => {
    const out = await generateImage(provider("openai", `${base}/v1`, "openai"), "gpt-image-2", "a cat", false);
    expect(out.images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(seen.at(-1)!.body).toEqual({ model: "gpt-image-2", prompt: "a cat", n: 1 });
  });

  it("picks a sensible image model automatically", () => {
    const providers = [provider("anthropic", "x", "anthropic"), provider("openai", "y", "openrouter")];
    expect(resolveImageModel(providers, { providerId: "", model: "" })?.provider.presetId).toBe("openrouter");
    expect(resolveImageModel([providers[0]], { providerId: "", model: "" })).toBeNull();
  });
});

describe("built-in provider search", () => {
  const run = async (p: ProviderConfig, model: string) => {
    const events: any[] = [];
    for await (const e of streamChat({ provider: p, model, system: "", messages: [{ id: "u", role: "user", content: "weather?", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, nativeSearch: true })) events.push(e);
    return events;
  };

  it("Anthropic: adds the web search tool, collects results and turns citations into [n]", async () => {
    const events = await run(provider("anthropic", `${base}/anthropic`, "anthropic"), "claude-sonnet-5-5");
    expect(seen.at(-1)!.body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("It rained. [1]");
    expect(events.find((e) => e.type === "status")?.text).toBe("Searching the web…");
    expect(events.filter((e) => e.type === "sources").at(-1).sources[0]).toMatchObject({ url: "https://news.example/a", title: "Story A" });
  });

  it("Anthropic: older models get the basic search tool", async () => {
    await run(provider("anthropic", `${base}/anthropic`, "anthropic"), "claude-haiku-4-5");
    expect(seen.at(-1)!.body.tools[0].type).toBe("web_search_20250305");
  });

  it("Gemini: grounds with Google Search and reports grounding sources", async () => {
    const events = await run(provider("gemini", `${base}/v1beta`, "google"), "gemini-3.8-flash");
    expect(seen.at(-1)!.body.tools).toEqual([{ google_search: {} }]);
    expect(events.filter((e) => e.type === "sources").at(-1).sources[0]).toMatchObject({ url: "https://g.example/r", title: "weather.com" });
  });

  it("OpenRouter: enables the web plugin", async () => {
    await run(provider("openai", `${base}/v1`, "openrouter"), "x-ai/grok-4.7");
    expect(seen.at(-1)!.body.plugins).toEqual([{ id: "web", max_results: 5 }]);
  });

  it("Perplexity: maps its [1] markers to search results", async () => {
    const events = await run(provider("openai", `${base}/pplx`, "perplexity"), "sonar-pro");
    expect(events.find((e) => e.type === "sources").sources[0]).toMatchObject({ url: "https://p.example/1", title: "P1" });
  });
});

describe("search", () => {
  it("parses DuckDuckGo results and skips ads", () => {
    const html = `
      <div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example &amp; Co</a></h2>
        <a class="result__snippet" href="#">The <b>best</b> example</a>
      </div>`;
    expect(parseDuckDuckGo(html)).toEqual([{ title: "Example & Co", url: "https://example.com/a", snippet: "The best example" }]);
  });

  it("extracts readable page text", () => {
    const html = "<html><head><title>x</title><script>var a=1</script></head><body><nav>Menu</nav><p>Hello&nbsp;world</p><footer>c</footer></body></html>";
    expect(extractText(html)).toBe("Hello world");
  });

  it("finds pasted links", () => {
    expect(findUrls("read https://a.com/x, and (https://b.org/y).")).toEqual(["https://a.com/x", "https://b.org/y"]);
  });

  it("builds a cited context block", () => {
    const prompt = sourcesPrompt("q", [{ title: "T", url: "https://t.com", snippet: "s" }], []);
    expect(prompt).toContain("[1] T\nURL: https://t.com\ns");
    expect(prompt).toContain("Cite them inline");
  });
});

describe("markdown", () => {
  it("splits blocks but keeps code fences and indented continuations together", () => {
    const text = "Intro\n\n```js\na\n\nb\n```\n\n- item\n\n  more\n\nEnd";
    expect(splitBlocks(text)).toEqual(["Intro", "", "```js\na\n\nb\n```", "", "- item\n\n  more", "", "End"].filter((b) => b !== ""));
  });

  it("links [n] citations to sources", () => {
    const sources = [
      { title: "A", url: "https://a.com", snippet: "" },
      { title: "B", url: "https://b.com", snippet: "" },
    ];
    expect(linkCitations("Fact [1]. Not [3]. Link [x](y)", sources)).toBe('Fact [1](https://a.com "A"). Not [3]. Link [x](y)');
    expect(linkCitations("Both[1][2].", sources)).toBe('Both[1](https://a.com "A")[2](https://b.com "B").');
  });
});
