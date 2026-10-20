// @vitest-environment node
// Early voice replies: the answer starts during a pause that probably ends the user's turn, and is
// kept only if the turn ends with the same words. Until then nothing shows, is saved or runs.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, useStore } from "./store";
import type { Bot, ProviderConfig } from "./types";
import { type AgentTool, registerTool } from "./agent/tools";
import { startEarlyReply } from "./chat";
import { VoiceSession } from "./voice-session";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

// The microphone side: a stand-in listener whose events each test sends.
const mic = vi.hoisted(() => ({ emit: (_event: Record<string, unknown>) => undefined as unknown, early: false as boolean | undefined }));
vi.mock("./whisper", async () => {
  const models = await vi.importActual<typeof import("./speech-models")>("./speech-models");
  return {
    SPEECH_MODELS: models.SPEECH_MODELS,
    localSpeechModel: (m: string) => m,
    onWhisperProgress: () => () => undefined,
    toWav: () => new Blob(),
    Listener: {
      open: async (options: { early?: boolean; onEvent: (event: Record<string, unknown>) => void }) => {
        mic.emit = options.onEvent;
        mic.early = options.early;
        return { setPartials: () => undefined, setSensitivity: () => undefined, setMuted: () => undefined, flush: () => undefined, close: () => undefined };
      },
    },
  };
});

// The bot's voice: records what it says; every sentence "plays" instantly.
const out = vi.hoisted(() => ({ said: [] as string[], speaking: false }));
vi.mock("./tts", async () => {
  const { takeSentences } = await vi.importActual<typeof import("./tts")>("./tts");
  return {
    takeSentences,
    chime: () => undefined,
    duckSpeech: () => undefined,
    createSpeaker: (_context: unknown, hooks: { onSentence?: (s: string) => void } = {}) => {
      let spoken = "";
      return {
        say(text: string) {
          out.said.push(text);
          spoken += `${text} `;
          hooks.onSentence?.(text);
        },
        idle: async () => {
          while (out.speaking) await sleep(5);
        },
        stop: () => undefined,
        get speaking() {
          return out.speaking;
        },
        get spoken() {
          return spoken;
        },
        inPageAudio: true,
      };
    },
  };
});
vi.mock("./local-tts", () => ({ localChoice: () => null, localVoiceReady: () => false }));
vi.mock("./voice", () => ({
  END_SILENCE_MS: { fast: 450, normal: 700, patient: 1200 },
  ENGINE_LABELS: { "whisper-local": "Whisper on this device" },
  resolveEngine: () => "whisper-local",
  listen: vi.fn(),
  transcribe: vi.fn(),
  stopReadAloud: () => undefined,
  speak: () => true,
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

// A model server: each request gets the next planned reply.
type Plan = { delay?: number; chunks?: string[]; gap?: number; tool?: string; fail?: boolean };
const sse = (e: unknown) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`;
let server: Server;
let base = "";
let plans: Plan[] = [];
let requests: { body: any; aborted: boolean }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const entry = { body: JSON.parse(raw), aborted: false };
    requests.push(entry);
    const plan = plans.shift() ?? { chunks: ["Okay."] };
    let finished = false;
    res.on("close", () => (entry.aborted = !finished));
    if (plan.fail) {
      finished = true;
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "overloaded" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    await sleep(plan.delay ?? 0);
    if (plan.tool) {
      res.write(sse({ choices: [{ delta: { content: "On it." } }] }));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: plan.tool, arguments: '{"q":"x"}' } }] } }] }));
    }
    for (const chunk of plan.chunks ?? []) {
      if (res.destroyed) return;
      res.write(sse({ choices: [{ delta: { content: chunk } }] }));
      await sleep(plan.gap ?? 2);
    }
    finished = true;
    res.end(sse("[DONE]"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => server.close());

// A lookup the bot may use in voice mode (read-only, so it runs without asking). Counts its runs.
let toolRuns = 0;
const lookup: AgentTool = {
  name: "early_lookup",
  group: "early-test",
  risk: "read",
  description: "Looks something up",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  async run() {
    toolRuns++;
    return "Looked it up.";
  },
};
registerTool(lookup);

const bot: Bot = {
  id: "b1", name: "ADT", avatar: "⚡", description: "", systemPrompt: "", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0, toolGroups: ["early-test"],
};

let session: VoiceSession | null = null;
beforeEach(() => {
  session?.close(false);
  session = null;
  plans = [];
  requests = [];
  toolRuns = 0;
  out.said = [];
  out.speaking = false;
  const provider: ProviderConfig = { id: "p", presetId: "custom", name: "P", kind: "openai", baseUrl: base, apiKey: "k", models: [] };
  useStore.setState({
    hydrated: true,
    bots: [bot],
    providers: [provider],
    activeBotId: "b1",
    activeConversationId: null,
    conversations: {},
    streamingId: null,
    settings: { ...defaultSettings, smartTitles: false, voice: { ...defaultSettings.voice, wakeWord: false } },
  });
});

const chat = () => Object.values(useStore.getState().conversations)[0]?.messages ?? [];
const said = () => out.said.join(" ");
const userWords = (n: number) => requests[n].body.messages.filter((m: any) => m.role === "user").at(-1).content;

async function open() {
  session = new VoiceSession({ onState: () => undefined, onClose: () => undefined });
  await session.start();
  expect(session.state.phase).toBe("listening");
  return session;
}

/** The user starts talking, then pauses in a way that probably ends the turn. */
async function pause(text: string) {
  mic.emit({ type: "start" });
  mic.emit({ type: "speech" });
  mic.emit({ type: "tentative", text });
}

describe("early replies in voice mode", () => {
  it("asks the speech detector for probable turn ends when the setting is on", async () => {
    await open();
    expect(mic.early).toBe(true);
    session!.close(false);
    useStore.setState((s) => ({ settings: { ...s.settings, voice: { ...s.settings.voice, earlyReply: false } } }));
    await open();
    expect(mic.early).toBe(false);
  });

  it("starts the answer during the pause and keeps it when the turn ends with the same words", async () => {
    await open();
    plans = [{ delay: 150, chunks: ["Paris is the capital of France."] }];
    await pause("What's the capital of France?");
    await until(() => requests.length === 1);
    // Nothing is shown or said yet: the user may still carry on.
    await sleep(40);
    expect(chat()).toHaveLength(0);
    expect(out.said).toHaveLength(0);
    expect(session!.state.phase).toBe("hearing");
    expect(useStore.getState().streamingId).toBeNull();

    // Same words, different punctuation and case.
    mic.emit({ type: "utterance", text: "what's the capital of france", ms: 3, waitMs: 1500 });
    await until(() => session!.state.phase === "listening" && out.said.length);
    expect(requests).toHaveLength(1);
    expect(requests[0].aborted).toBe(false);
    expect(said()).toContain("Paris is the capital of France.");
    const messages = chat();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].content).toBe("What's the capital of France?");
    expect(messages[1].content).toBe("Paris is the capital of France.");
    expect(useStore.getState().streamingId).toBeNull();
    // The head start is recorded in the timing breakdown.
    expect(session!.state.timing?.early).toBeGreaterThan(0);
  });

  it("drops the early answer when the user keeps talking, without a trace", async () => {
    await open();
    plans = [{ delay: 300, chunks: ["Booked."] }, { chunks: ["A table for two at eight."] }];
    await pause("Book a table");
    await until(() => requests.length === 1);
    mic.emit({ type: "resume" });
    await until(() => requests[0].aborted);
    expect(chat()).toHaveLength(0);

    mic.emit({ type: "utterance", text: "Book a table for two at eight", ms: 3, waitMs: 400 });
    await until(() => session!.state.phase === "listening" && out.said.length);
    expect(requests).toHaveLength(2);
    expect(userWords(1)).toBe("Book a table for two at eight");
    expect(said()).not.toContain("Booked.");
    expect(chat().map((m) => m.content)).toEqual(["Book a table for two at eight", "A table for two at eight."]);
  });

  it("sends the final words instead when they differ from what the early answer heard", async () => {
    await open();
    plans = [{ delay: 300, chunks: ["Wrong answer."] }, { chunks: ["Right answer."] }];
    await pause("What's the weather");
    await until(() => requests.length === 1);
    // No "resume" this time: the final transcript simply came out different.
    mic.emit({ type: "utterance", text: "What's the weather in Lisbon", ms: 3, waitMs: 400 });
    await until(() => session!.state.phase === "listening" && out.said.length);
    expect(requests[0].aborted).toBe(true);
    expect(requests).toHaveLength(2);
    expect(said()).toBe("Right answer.");
    expect(chat().map((m) => m.content)).toEqual(["What's the weather in Lisbon", "Right answer."]);
  });

  it("holds tool calls until the turn is over, and never runs them if the answer is dropped", async () => {
    await open();
    plans = [{ tool: "early_lookup" }];
    await pause("Where is my order");
    await until(() => requests.length === 1);
    await sleep(80);
    expect(toolRuns).toBe(0);
    mic.emit({ type: "resume" });
    await sleep(80);
    expect(toolRuns).toBe(0);
    // The model wasn't asked again with a tool result either.
    expect(requests).toHaveLength(1);

    plans = [{ tool: "early_lookup" }, { chunks: ["Your order ships tomorrow."] }];
    await pause("Where is my order now");
    await until(() => requests.length === 2);
    await sleep(80);
    expect(toolRuns).toBe(0);
    mic.emit({ type: "utterance", text: "Where is my order now", ms: 3, waitMs: 1500 });
    await until(() => session!.state.phase === "listening" && said().includes("ships"));
    expect(toolRuns).toBe(1);
    expect(requests).toHaveLength(3);
    // The tool ran once the turn was over, and its result went back to the model.
    expect(requests[2].body.messages.some((m: any) => m.role === "tool" && m.content.includes("Looked it up."))).toBe(true);
    expect(chat().at(-1)?.toolCalls?.[0]).toMatchObject({ name: "early_lookup", status: "done" });
  });

  it("doesn't start early while the bot is talking (a barge-in is checked for echo first)", async () => {
    await open();
    plans = [{ delay: 20, chunks: ["First answer is here."] }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Tell me something", ms: 3, waitMs: 300 });
    out.speaking = true;
    await until(() => session!.state.phase === "speaking");
    // The user (or the bot's echo) talks over it and pauses.
    mic.emit({ type: "start" });
    mic.emit({ type: "tentative", text: "Stop and tell me about Rome" });
    await sleep(60);
    expect(requests).toHaveLength(1);
    out.speaking = false;
  });

  it("a kept early answer can be interrupted like any other", async () => {
    await open();
    plans = [{ delay: 20, chunks: ["One. ", "Two. ", "Three. ", "Four. ", "Five."], gap: 120 }];
    await pause("Count to five");
    await until(() => requests.length === 1);
    mic.emit({ type: "utterance", text: "Count to five", ms: 3, waitMs: 1500 });
    await until(() => useStore.getState().streamingId);
    session!.tap();
    await until(() => requests[0].aborted && !useStore.getState().streamingId);
    expect(session!.state.phase).toBe("listening");
    expect(said()).not.toContain("Five.");
  });

  it("falls back to a normal request when the early one failed", async () => {
    await open();
    plans = [{ fail: true }, { chunks: ["Here you go."] }];
    await pause("Give me a fun fact");
    await until(() => requests.length === 1);
    await sleep(40);
    mic.emit({ type: "utterance", text: "Give me a fun fact", ms: 3, waitMs: 1500 });
    await until(() => session!.state.phase === "listening" && out.said.length);
    expect(requests).toHaveLength(2);
    expect(said()).toBe("Here you go.");
    expect(chat().map((m) => m.error)).toEqual([undefined, undefined]);
  });

  it("leaves commands and noise to the end of the turn", async () => {
    await open();
    await pause("stop");
    await pause("Thank you.");
    await sleep(40);
    expect(requests).toHaveLength(0);
  });
});

describe("startEarlyReply", () => {
  it("can't be kept once the chat has changed", async () => {
    plans = [{ delay: 100, chunks: ["Hi."] }];
    const early = startEarlyReply("Hello there", { voice: true })!;
    await until(() => requests.length === 1);
    useStore.setState({ activeBotId: "other" });
    expect(early.keep()).toBe(false);
    await early.done;
    await until(() => requests[0].aborted);
    expect(useStore.getState().conversations).toEqual({});
  });

  it("isn't started for slash commands, images or linked pages", () => {
    expect(startEarlyReply("/remember I like tea")).toBeNull();
    expect(startEarlyReply("Draw a cat", { imagine: true })).toBeNull();
    expect(startEarlyReply("Summarise https://example.com/a")).toBeNull();
    useStore.setState({ streamingId: "c" });
    expect(startEarlyReply("Hello")).toBeNull();
  });

  it("keeps memory and the chat untouched until it's kept", async () => {
    useStore.setState((s) => ({ bots: [{ ...s.bots[0], autoMemory: true }] }));
    plans = [{ chunks: ["Nice to meet you, Sam. <remember>The user's name is Sam</remember>"] }];
    const early = startEarlyReply("My name is Sam", { voice: true })!;
    await sleep(120);
    expect(useStore.getState().bots[0].memory).toEqual([]);
    early.discard();
    await early.done;
    expect(useStore.getState().bots[0].memory).toEqual([]);
    expect(useStore.getState().conversations).toEqual({});

    plans = [{ chunks: ["Nice to meet you, Sam. <remember>The user's name is Sam</remember>"] }];
    const again = startEarlyReply("My name is Sam", { voice: true })!;
    await sleep(120);
    expect(again.keep()).toBe(true);
    await again.done;
    expect(useStore.getState().bots[0].memory).toEqual(["The user's name is Sam"]);
    expect(chat().map((m) => m.content)).toEqual(["My name is Sam", "Nice to meet you, Sam."]);
  });
});
