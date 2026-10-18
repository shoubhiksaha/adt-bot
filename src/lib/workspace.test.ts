// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { colorsInText, pickAccent } from "./brand-import";
import { buildSystemPrompt } from "./chat";
import { chunk, knowledgeContext, rank, saveKnowledgeText } from "./knowledge";
import { streamChat } from "./llm";
import { contrast, normalizeHex, preferredMode, readableOn, themeCss } from "./theme";
import type { Bot, ProviderConfig } from "./types";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init) }));

describe("theme engine", () => {
  it("parses colours in any common format", () => {
    expect(normalizeHex("#0af")).toBe("#00aaff");
    expect(normalizeHex("rgb(255, 99, 71)")).toBe("#ff6347");
    expect(normalizeHex("hsl(210, 100%, 50%)")).toBe("#0080ff");
    expect(normalizeHex("banana")).toBeNull();
  });

  it("keeps links readable on both light and dark pages", () => {
    for (const bg of ["#0b0c0e", "#fafaf8"]) {
      for (const accent of ["#ffeb3b", "#1e3a8a", "#22d3ee"]) expect(contrast(readableOn(accent, bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("derives the mode from a brand background and emits both palettes", () => {
    expect(preferredMode({ preset: "x", accent: "#f00", background: "#f6f0e6", font: "system", radius: 12 })).toBe("light");
    expect(preferredMode({ preset: "x", accent: "#f00", background: "#0b1020", font: "system", radius: 12 })).toBe("dark");
    const css = themeCss({ preset: "x", accent: "#e11d48", background: "#f6f0e6", font: "serif", radius: 4 });
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain("--background: #f6f0e6");
    expect(css).toContain("--radius: 4px");
    expect(css).toMatch(/--font: ui-serif/);
  });
});

describe("brand import", () => {
  it("prefers brand-named variables in CSS and design tokens", () => {
    const css = ":root { --gray-100: #f4f4f5; --brand-primary: #6d28d9; --page-background: #fffaf0; } body { font-family: 'Inter', sans-serif; color: #111; }";
    const found = colorsInText(css);
    expect(found.accent).toBe("#6d28d9");
    expect(found.background).toBe("#fffaf0");
    expect(found.font).toBe("Inter");
    expect(colorsInText('{"color": {"primary": {"value": "#0ea5e9"}}}').palette).toContain("#0ea5e9");
  });

  it("picks a usable accent, not white, black or grey", () => {
    expect(pickAccent(["#ffffff", "#111111", "#9ca3af", "#e11d48"])).toBe("#e11d48");
  });
});

describe("knowledge", () => {
  it("splits long documents into overlapping passages", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"Lorem ipsum dolor sit amet. ".repeat(8)}`).join("\n\n");
    const parts = chunk(text);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 1500)).toBe(true);
  });

  it("ranks the passage that answers the question first (BM25)", () => {
    const passages = [
      { text: "Our office is open Monday to Friday, 9am to 6pm." },
      { text: "Refunds are processed within 14 days of receiving the returned item." },
      { text: "We ship to India, Nepal and Sri Lanka." },
    ];
    expect(rank(passages, "How long do refunds take?")[0].text).toMatch(/Refunds/);
  });

  it("includes small files whole and large ones as relevant excerpts", async () => {
    const small = await saveKnowledgeText("about.md", "Acme Dental is a clinic in Pune founded in 2019.");
    const whole = await knowledgeContext([small], "where is acme");
    expect(whole.prompt).toContain('<document name="about.md">');
    expect(whole.used).toEqual(["about.md"]);

    const filler = Array.from({ length: 60 }, (_, i) => `Section ${i}: general policy text about scheduling and forms. ${"Details. ".repeat(40)}`).join("\n\n");
    const big = await saveKnowledgeText("handbook.pdf", `${filler}\n\nThe emergency phone number for after-hours dental pain is 98765 43210.\n\n${filler}`);
    const excerpts = await knowledgeContext([big], "What is the emergency phone number for dental pain?");
    expect(excerpts.prompt).toContain("<excerpt");
    expect(excerpts.prompt).toContain("98765 43210");
    expect(excerpts.prompt.length).toBeLessThan(12_000);
  });
});

const bot = (patch: Partial<Bot> = {}): Bot => ({
  id: "b",
  name: "ADT",
  avatar: "⚡",
  description: "",
  systemPrompt: "You are ADT.",
  providerId: "p",
  model: "m",
  temperature: null,
  thinking: "off",
  memory: [],
  autoMemory: false,
  createdAt: 0,
  ...patch,
});

describe("system prompt", () => {
  it("includes the nickname, the user's name, the organisation and knowledge", () => {
    const prompt = buildSystemPrompt(bot({ nickname: "Jarvis" }), {
      userName: "Sam",
      about: "We run Acme Dental in Pune.",
      knowledge: "Reference knowledge: X",
    });
    expect(prompt).toContain('the user also calls you "Jarvis"');
    expect(prompt).toContain("The user's name is Sam");
    expect(prompt).toContain("Acme Dental");
    expect(prompt).toContain("Reference knowledge: X");
    expect(prompt).not.toContain("voice conversation");
  });

  it("asks for short spoken answers in voice mode", () => {
    expect(buildSystemPrompt(bot(), { voice: true })).toContain("live voice conversation");
  });
});

let server: Server;
let base = "";
const seen: any[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => server.close());

describe("voice requests", () => {
  it("uses low effort and prompt caching for Claude", async () => {
    const provider: ProviderConfig = { id: "a", presetId: "anthropic", name: "A", kind: "anthropic", baseUrl: base, apiKey: "k", models: [] };
    for await (const _ of streamChat({ provider, model: "claude-sonnet-5-5", system: "s", messages: [{ id: "1", role: "user", content: "hi", createdAt: 0 }], temperature: null, thinking: "off", useProxy: false, fast: true })) {
      // drain
    }
    expect(seen.at(-1).output_config).toEqual({ effort: "low" });
    expect(seen.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(seen.at(-1)).not.toHaveProperty("thinking");
  });
});
