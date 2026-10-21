// Voice mode: the bot doesn't answer its own voice coming back, and talking over it stops it.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, useStore } from "./store";
import type { Bot, ProviderConfig } from "./types";
import { type AgentTool, registerTool } from "./agent/tools";
import { startEarlyReply } from "./chat";
import { VoiceSession } from "./voice-session";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

// The microphone side: a stand-in listener whose events each test sends.
const mic = vi.hoisted(() => ({ emit: (_event: Record<string, unknown>) => undefined as unknown, early: false as boolean | undefined, level: 0.1 }));
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
        return { setPartials: () => undefined, setSensitivity: () => undefined, setMuted: () => undefined, flush: () => undefined, close: () => undefined, level: () => mic.level };
      },
    },
  };
});

// The bot's voice: records what it says; every sentence "plays" instantly.
const out = vi.hoisted(() => ({ said: [] as string[], speaking: false, db: -20 }));
vi.mock("./tts", async () => {
  const { takeSentences } = await vi.importActual<typeof import("./tts")>("./tts");
  return {
    takeSentences,
    chime: () => undefined,
    duckSpeech: () => undefined,
    outputDb: () => out.db,
    warmDeviceVoice: () => undefined,
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
        tailMs: 0,
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
  out.db = -20;
  mic.level = 0.1;
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

describe("its own voice coming back", () => {
  it("ignores the end of its own reply heard a moment after it stopped (speaker delay, Bluetooth)", async () => {
    const s = await open();
    plans = [{ chunks: ["I sent it to Sayan. ", "Was the message to Sayan the right one, or did you mean a different contact?"] }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Send hello to Sayan", ms: 3, waitMs: 300 });
    await until(() => s.state.phase === "listening" && said().includes("different contact"));
    await sleep(700); // past the short echo tail
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "or did you mean a different contact", ms: 3, waitMs: 300 });
    await sleep(150);
    expect(requests).toHaveLength(1);
    expect(s.state.phase).toBe("listening");
  });

  it("still takes a quick real answer right after it stopped", async () => {
    const s = await open();
    plans = [{ chunks: ["Should I send it to Sayan?"] }, { chunks: ["Sent."] }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Message Sayan hello", ms: 3, waitMs: 300 });
    await until(() => s.state.phase === "listening" && said().includes("Sayan?"));
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "yes please send it", ms: 3, waitMs: 300 });
    await until(() => requests.length === 2);
    expect(userWords(1)).toBe("yes please send it");
  });
});

describe("talking over it", () => {
  it("stops as soon as the live caption shows it's the user, before they finish", async () => {
    const s = await open();
    out.speaking = true;
    plans = [{ chunks: ["Here is a long story about the history of Rome. ", "It starts with Romulus and Remus. "], gap: 20 }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Tell me about Rome", ms: 3, waitMs: 300 });
    await until(() => s.state.phase === "speaking");
    mic.emit({ type: "start" });
    mic.emit({ type: "speech" });
    // Its own words leaking back don't count.
    mic.emit({ type: "partial", text: "history of Rome" });
    expect(s.state.phase).toBe("speaking");
    mic.emit({ type: "partial", text: "wait actually tell me about Paris" });
    expect(s.state.phase).toBe("hearing");
    expect(s.state.partial).toBe("wait actually tell me about Paris");
    out.speaking = false;
    mic.emit({ type: "utterance", text: "wait actually tell me about Paris instead", ms: 3, waitMs: 300 });
    await until(() => requests.length === 2);
    expect(userWords(1)).toBe("wait actually tell me about Paris instead");
  });

  it("\"stop\" on its own stops it at once", async () => {
    const s = await open();
    out.speaking = true;
    plans = [{ chunks: ["One. ", "Two. ", "Three. "], gap: 20 }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Count to three", ms: 3, waitMs: 300 });
    await until(() => s.state.phase === "speaking");
    mic.emit({ type: "start" });
    mic.emit({ type: "partial", text: "stop" });
    expect(s.state.phase).toBe("hearing");
    out.speaking = false;
  });
});

describe("talking over it, before the words are known", () => {
  /** The bot is mid-answer, and its own voice has been coming back at `echo` loudness for a second. */
  async function speakingWithEcho(echo: number) {
    const s = await open();
    out.speaking = true;
    plans = [{ chunks: ["Paris began as a small settlement on an island in the Seine. ", "The Romans called it Lutetia. ", "Later it grew."], gap: 400 }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Tell me about the history of Paris", ms: 3, waitMs: 300 });
    await until(() => s.state.phase === "speaking");
    mic.level = echo;
    await sleep(1200);
    return s;
  }

  it("stops within half a second once someone is clearly louder than its echo", async () => {
    const s = await speakingWithEcho(0.25);
    mic.emit({ type: "start" });
    mic.emit({ type: "speech" });
    mic.level = 0.8;
    await until(() => s.state.phase === "hearing", 900);
    out.speaking = false;
    // Their words: a new request is answered.
    mic.emit({ type: "utterance", text: "actually tell me about Rome instead", ms: 3, waitMs: 300 });
    await until(() => requests.length === 2);
    expect(userWords(1)).toBe("actually tell me about Rome instead");
  });

  it("doesn't count the start of a cut-in as echo (seen live: it hid a quieter voice)", async () => {
    out.db = -12;
    const s = await speakingWithEcho(0);
    // Their first quarter second, before the detector is sure it's speech.
    mic.emit({ type: "start" });
    mic.level = 0.45;
    await sleep(250);
    mic.emit({ type: "speech" });
    await until(() => s.state.phase === "hearing", 900);
    out.speaking = false;
  });

  it("doesn't stop for its own voice coming back, however loud", async () => {
    const s = await speakingWithEcho(0.7);
    mic.emit({ type: "start" });
    mic.emit({ type: "speech" });
    mic.level = 0.72;
    await sleep(800);
    expect(s.state.phase).toBe("speaking");
    out.speaking = false;
  });

  it("after stopping, a stray word or the last question heard again isn't a new request", async () => {
    for (const heard of ["was", "Tell me about the history of Paris"]) {
      const s = await speakingWithEcho(0.2);
      mic.emit({ type: "start" });
      mic.emit({ type: "speech" });
      mic.level = 0.85;
      await until(() => s.state.phase === "hearing", 900);
      out.speaking = false;
      mic.emit({ type: "utterance", text: heard, ms: 3, waitMs: 300 });
      await sleep(150);
      expect(requests).toHaveLength(1);
      expect(s.state.phase).toBe("listening");
      s.close(false);
      requests = [];
      mic.level = 0.1;
    }
  });
});

describe("telling a late echo from a reply", () => {
  it("matches the bot's last words in order, not a short or different answer", async () => {
    const { echoesLastWords } = await import("./voice-commands");
    const spoken = "I sent it to Sayan. Was the message to Sayan the right one, or did you mean a different contact?";
    expect(echoesLastWords("or did you mean a different contact", spoken)).toBe(true);
    expect(echoesLastWords("did you mean a different contract", spoken)).toBe(true);
    expect(echoesLastWords("yes send it", spoken)).toBe(false);
    expect(echoesLastWords("yes send it to Sayan", spoken)).toBe(false);
    expect(echoesLastWords("no I meant Sayan Mondal", spoken)).toBe(false);
    // Words from the start of a long reply aren't a late echo (that is always the end).
    const long = "Sure I can help with that. " + "Here is a lot more detail about the plan and the steps involved in it today. ".repeat(3);
    expect(echoesLastWords("Sure I can help with that", long)).toBe(false);
    // A word misheard in the middle ("a" for "the") doesn't hide the rest.
    const weather = "The weather in Kolkata is warm and humid today, with the chance of rain in the evening.";
    expect(echoesLastWords("Humid today with a chance of rain in the evening", weather)).toBe(true);
    // An answer that repeats its words isn't an echo.
    expect(echoesLastWords("Yes, the message to Sayan was the right one", spoken)).toBe(false);
    expect(echoesLastWords("No, the message to Sayan was wrong", spoken)).toBe(false);
  });
});

describe("garbled echo and talking over it", () => {
  const spoken = "Here's Rome in six sentences. Legend says Romulus founded it in seven fifty-three BC, and it started as a small kingdom.";
  it("knows the bot's own words even when speech-to-text mangles them", async () => {
    const { soundsLikeUser, userPart } = await import("./voice-commands");
    expect(soundsLikeUser("20 years' room in six sentences", spoken)).toBe(false);
    expect(soundsLikeUser("Legends says Romulus founded it", spoken)).toBe(false);
    // A long echo with a couple of misheard words is still the echo.
    expect(soundsLikeUser("2022's Rome in six sentences. Legend says Romulus found that", spoken)).toBe(false);
    expect(userPart("2022's Rome in six sentences. Legend says Romulus found that", spoken)).toBeNull();
    expect(soundsLikeUser("wait actually tell me about Paris", spoken)).toBe(true);
    expect(userPart("No, Paris", spoken)).toBe("No, Paris");
  });

  it("keeps the user's words when the echo comes first in the same breath", async () => {
    const { withoutLeadingEcho } = await import("./voice-commands");
    expect(withoutLeadingEcho("Years' Rome in six sentences. Legends says Romulus founded it. Tell me about Paris instead.", spoken)).toBe("Tell me about Paris instead.");
    expect(withoutLeadingEcho("Tell me about Paris", spoken)).toBe("Tell me about Paris");
    // Echo on both sides: the user's words are in the middle.
    const { userPart } = await import("./voice-commands");
    expect(userPart("Here's Rome in six sentences. Legend says Romulus. Tell me about Paris instead. Founded it in seven fifty-three BC, and it started as a small kingdom.", spoken)).toBe("Tell me about Paris instead.");
  });

  it("drops a garbled echo that began while it spoke, and answers the user's part of a mixed one", async () => {
    const s = await open();
    plans = [{ chunks: [spoken] }, { chunks: ["Paris is the capital of France."] }];
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Tell me about Rome", ms: 3, waitMs: 300 });
    await until(() => s.state.phase === "listening" && said().includes("small kingdom"));
    // Started while it was speaking (it "plays" instantly here, so start it inside the echo tail).
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "20 years' room in six sentences", ms: 3, waitMs: 300 });
    await sleep(100);
    expect(requests).toHaveLength(1);
    mic.emit({ type: "start" });
    mic.emit({ type: "utterance", text: "Legends says Romulus founded it. Tell me about Paris instead.", ms: 3, waitMs: 300 });
    await until(() => requests.length === 2);
    expect(userWords(1)).toBe("Tell me about Paris instead.");
  });
});

describe("answering the bot's question", () => {
  it("hears a yes even though the question itself said 'yes or no'", async () => {
    const { echoesLastWords } = await import("./voice-commands");
    expect(echoesLastWords("Yes.", "Can I create a routine: Morning news? Say yes or no.")).toBe(false);
    expect(echoesLastWords("create a routine morning news say yes or no", "Can I create a routine: Morning news? Say yes or no.")).toBe(true);
  });
});

describe("saying stop", () => {
  it("understands the ways people cut in, alone or after the bot's echo", async () => {
    const { endsWithStop, parseVoiceCommand, userPart } = await import("./voice-commands");
    for (const t of ["Wait, stop.", "okay okay stop", "no, hold on", "stop stop", "wait a second", "hang on please"]) expect(parseVoiceCommand(t, [])?.type, t).toBe("stop");
    expect(parseVoiceCommand("wait actually tell me about Paris", [])).toBeNull();
    expect(endsWithStop("and it started as a small kingdom. Stop.")).toBe(true);
    expect(endsWithStop("it started as a small kingdom")).toBe(false);
    // Reusing one of the bot's words ("Paris" ≈ "parts") doesn't make the user's sentence an echo.
    const spoken = "The city grew in parts over many centuries, and it was rebuilt about three times.";
    expect(userPart("Tell me about Paris instead", spoken)).toBe("Tell me about Paris instead");
  });
});

describe("numbers and stray words around the user's words", () => {
  it("drops a garbled number echo and a stray echo word before the user's sentence", async () => {
    const { userPart } = await import("./voice-commands");
    const spoken = "Paris started around the third century BC as a settlement of a Celtic tribe called the Parisii.";
    expect(userPart("3rd century BC as a 13th century.", spoken)).toBeNull();
    const rome = "Here's Rome in six sentences. According to legend, Rome was founded in seven fifty-three BC by Romulus, and it was ruled by kings until about 509 BC.";
    expect(userPart("Here's Rome in six sentences, according to legend Rome was founded in 1784. Tell me about Paris instead.", rome)).toBe("Tell me about Paris instead.");
    expect(userPart("According to legend, Rome was founded in September. Wait, stop. Tell me about Paris instead.", rome)).toBe("Wait, stop. Tell me about Paris instead.");
  });
});


describe("a long echo caption with misheard words", async () => {
  const { soundsLikeUser } = await import("./voice-commands");
  const spoken = "Paris began as a small settlement of the Parisii tribe on an island in the Seine, more than two thousand years ago. The Romans called it Lutetia and built baths, a forum and an arena there. In the Middle Ages it grew into the largest city in Europe, with Notre Dame rising on the same island.";

  it("isn't the user while it still ends in the bot's own words (seen live: 11 s of echo)", () => {
    const caption = "Paris began as a small settlement of the Parisi I tribe on an island in the Seine more than 2,000 years ago the Romans called it lutetia and built bats a foreman and arena there in the middle ages it grew into the largest city in Europe";
    expect(soundsLikeUser(caption, spoken)).toBe(false);
  });

  it("is the user once their own words come at the end", () => {
    expect(soundsLikeUser("in the middle ages it grew into hold on can you tell me about Rome instead", spoken)).toBe(true);
  });
});

describe("what speech models make of noise", async () => {
  const { isLikelyHallucination } = await import("./voice-commands");
  it("isn't taken for someone talking", () => {
    for (const t of ["Thank you for watching", "foreign foreign foreign", "Foreign.", "you you you you"]) expect(isLikelyHallucination(t)).toBe(true);
    for (const t of ["hold on wait a second", "no no no that's wrong", "stop stop", "no no no", "stop stop stop", "yes yes yes"]) expect(isLikelyHallucination(t)).toBe(false);
  });
});

describe("talking over the bot: more than its own echo explains", async () => {
  const { heardOverEcho } = await import("./voice-session");
  const echoGaps = (gap: number, n = 30) => Array.from({ length: n }, (_, i) => gap + (i % 5) - 2);
  /** The bot's output rising and falling syllable by syllable, and the microphone hearing `mic(out)`. */
  const moment = (mic: (out: number) => number) => Array.from({ length: 9 }, (_, i) => -15 - (i % 3) * 12).map((o) => ({ out: o, mic: mic(o) }));

  it("stops for a voice well above the echo the bot's output explains", () => {
    expect(heardOverEcho(moment(() => -20), echoGaps(-28), -55)).toBe(true);
  });

  it("not for the echo itself, loud or soft, however the bot's voice rises and falls", () => {
    expect(heardOverEcho(moment((o) => o - 28), echoGaps(-28), -55)).toBe(false);
    expect(heardOverEcho(moment((o) => o - 4), echoGaps(-4), -55)).toBe(false);
  });

  it("judges quiet moments against the room, and leaves it to the words until the echo is known", () => {
    const silent = Array.from({ length: 9 }, () => ({ out: -80 }));
    expect(heardOverEcho(silent.map((w) => ({ ...w, mic: -52 })), echoGaps(-28), -55)).toBe(false);
    expect(heardOverEcho(silent.map((w) => ({ ...w, mic: -25 })), echoGaps(-28), -55)).toBe(true);
    expect(heardOverEcho(moment(() => -20), echoGaps(-28, 14), -55)).toBe(false);
    expect(heardOverEcho(moment(() => -20).slice(0, 5), echoGaps(-28), -55)).toBe(false);
  });
});

