// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FRAME, Segmenter, type SegmentEvent } from "./segmenter";
import { isEcho, matchWakeWord, parseVoiceCommand } from "./voice-commands";

const run = (probs: number[], endSilenceMs = 600) => {
  const seg = new Segmenter({ endSilenceMs });
  const events: SegmentEvent[] = [];
  for (const p of probs) events.push(...seg.push(new Float32Array(FRAME).fill(p), p));
  return events;
};
const quiet = (n: number) => Array(n).fill(0.02);
const voice = (n: number) => Array(n).fill(0.95);

describe("turn detection", () => {
  it("emits start, a speculative pause, then the end of the turn after the silence window", () => {
    const events = run([...quiet(20), ...voice(30), ...quiet(30)]);
    expect(events.map((e) => e.type)).toEqual(["start", "pause", "end"]);
    const pause = events[1] as Extract<SegmentEvent, { type: "pause" }>;
    const end = events[2] as Extract<SegmentEvent, { type: "end" }>;
    expect(end.version).toBe(pause.version);
    // Includes the pre-roll before speech and trims most trailing silence.
    expect(end.audio.length / FRAME).toBeGreaterThan(30);
    expect(end.audio.length / FRAME).toBeLessThan(30 + 10 + 6);
  });

  it("invalidates the speculative result when the speaker keeps going", () => {
    const events = run([...voice(20), ...quiet(8), ...voice(20), ...quiet(30)]);
    expect(events.map((e) => e.type)).toEqual(["start", "pause", "resume", "pause", "end"]);
    const firstPause = events[1] as Extract<SegmentEvent, { type: "pause" }>;
    const end = events.at(-1) as Extract<SegmentEvent, { type: "end" }>;
    expect(end.version).not.toBe(firstPause.version);
  });

  it("ignores clicks and short blips", () => {
    expect(run([...quiet(10), 0.9, ...quiet(10), ...voice(4), ...quiet(40)]).filter((e) => e.type === "end")).toEqual([]);
  });

  it("reports progress during long speech for live captions", () => {
    expect(run([...voice(100), ...quiet(30)]).filter((e) => e.type === "progress").length).toBeGreaterThanOrEqual(2);
  });
});

const bots = [
  { id: "1", name: "ADT", nickname: "Jarvis" },
  { id: "2", name: "Coder", nickname: "" },
];

describe("voice commands", () => {
  it("recognises hands-free commands", () => {
    expect(parseVoiceCommand("Stop.", bots)).toEqual({ type: "stop" });
    expect(parseVoiceCommand("Okay, that's all, thanks", bots)).toBeNull();
    expect(parseVoiceCommand("That's all, thanks!", bots)).toEqual({ type: "end" });
    expect(parseVoiceCommand("Goodbye", bots)).toEqual({ type: "end" });
    expect(parseVoiceCommand("Start a new chat please", bots)).toEqual({ type: "newChat" });
    expect(parseVoiceCommand("Switch to coder", bots)).toEqual({ type: "switchBot", botId: "2" });
    expect(parseVoiceCommand("Talk to Jarvis", bots)).toEqual({ type: "switchBot", botId: "1" });
    expect(parseVoiceCommand("Say that again", bots)).toEqual({ type: "repeat" });
    expect(parseVoiceCommand("Slow down", bots)).toEqual({ type: "slower" });
    expect(parseVoiceCommand("Search the web for the weather in Delhi", bots)).toEqual({ type: "search", query: "the weather in Delhi" });
    expect(parseVoiceCommand("Draw a red fox in the snow", bots)).toEqual({ type: "imagine", prompt: "a red fox in the snow" });
  });

  it("leaves ordinary questions for the AI", () => {
    expect(parseVoiceCommand("How do I stop a running process?", bots)).toBeNull();
    expect(parseVoiceCommand("What's a good name for a new chat app?", bots)).toBeNull();
  });
});

describe("wake word", () => {
  const names = ["Jarvis", "ADT"];
  it("wakes on 'hey <name>' and keeps the request", () => {
    expect(matchWakeWord("Hey Jarvis, what's the weather?", names)).toEqual({ woke: true, rest: "what's the weather?" });
    expect(matchWakeWord("Okay Jarvis", names)).toEqual({ woke: true, rest: "" });
  });
  it("tolerates how recognisers spell short or unusual names", () => {
    expect(matchWakeWord("Hey A.D.T. set a timer", names).woke).toBe(true);
    expect(matchWakeWord("hey jarvas tell me a joke", names)).toEqual({ woke: true, rest: "tell me a joke" });
  });
  it("doesn't wake on unrelated speech", () => {
    expect(matchWakeWord("Hey there, how are you", names).woke).toBe(false);
    expect(matchWakeWord("I think the weather is nice", names).woke).toBe(false);
  });
});

describe("echo filter", () => {
  it("recognises the bot's own voice coming back through the speakers", () => {
    expect(isEcho("the capital of France is Paris", "The capital of France is Paris, a lovely city.")).toBe(true);
    expect(isEcho("stop, I meant Germany", "The capital of France is Paris, a lovely city.")).toBe(false);
  });
});

describe("Whisper noise guards", () => {
  it("drops phrases Whisper invents from noise", async () => {
    const { isLikelyHallucination } = await import("./voice-commands");
    for (const t of ["Thank you.", "Thanks for watching!", "Love you, Duane.", "[Music]", "(silence)", "♪ ♪", "you", "Subtitles by the Amara.org community"]) {
      expect(isLikelyHallucination(t), t).toBe(true);
    }
    for (const t of ["What is the capital of France?", "Thank you, now summarise it", "Yes", "Open my calendar"]) {
      expect(isLikelyHallucination(t), t).toBe(false);
    }
  });

  it("needs a real sentence to cut in", async () => {
    const { isSubstantial } = await import("./voice-commands");
    expect(isSubstantial("no wait")).toBe(false);
    expect(isSubstantial("Actually tell me about Berlin instead")).toBe(true);
  });
});
