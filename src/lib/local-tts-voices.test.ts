// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KOKORO_VOICES, localChoice, splitLongText } from "./local-tts-voices";

describe("on-device voice choice", () => {
  const settings = { localVoice: "F1", kokoroVoice: "af_heart" };
  it("picks the engine from the reply voice setting", () => {
    expect(localChoice({ ...settings, tts: "local" })).toEqual({ engine: "supertonic", voice: "F1" });
    expect(localChoice({ ...settings, tts: "kokoro", kokoroVoice: "bm_george" })).toEqual({ engine: "kokoro", voice: "bm_george" });
  });
  it("is null for every other kind of voice", () => {
    for (const tts of ["system", "openai", "elevenlabs", "fish", "custom:x"] as const) expect(localChoice({ ...settings, tts })).toBeNull();
  });
  it("falls back to each engine's default voice for unknown or missing names", () => {
    expect(localChoice({ ...settings, tts: "local", localVoice: "af_heart" })?.voice).toBe("F1");
    expect(localChoice({ ...settings, tts: "kokoro", kokoroVoice: "" })?.voice).toBe("af_heart");
    expect(localChoice({ ...settings, tts: "kokoro", kokoroVoice: undefined as never })?.voice).toBe("af_heart");
  });
  it("lists Kokoro voices with af_heart first", () => {
    expect(KOKORO_VOICES[0].id).toBe("af_heart");
    expect(new Set(KOKORO_VOICES.map((v) => v.id)).size).toBe(KOKORO_VOICES.length);
    for (const v of KOKORO_VOICES) expect(v.id).toMatch(/^[ab][fm]_[a-z]+$/);
  });
});

describe("long sentences for Kokoro", () => {
  it("leaves normal sentences whole", () => {
    expect(splitLongText("  The capital of France is Paris.  ")).toEqual(["The capital of France is Paris."]);
  });
  it("cuts long text at commas, then spaces, without losing words", () => {
    const clause = "this is a fairly long clause that keeps going for a while";
    const text = Array.from({ length: 8 }, () => clause).join(", ");
    const pieces = splitLongText(text, 150);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(150);
    expect(pieces.slice(0, -1).every((p) => p.endsWith(","))).toBe(true);
    expect(pieces.join(" ")).toBe(text);
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const byWord = splitLongText(words, 60);
    expect(byWord.join(" ")).toBe(words);
    for (const p of byWord) expect(p.length).toBeLessThanOrEqual(60);
  });
});
