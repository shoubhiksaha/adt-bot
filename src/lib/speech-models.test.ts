// @vitest-environment node
import { describe, expect, it } from "vitest";
import { effectiveSpeechModel, isNoiseTranscript, moonshineMaxTokens, SPEECH_MODELS, splitForMoonshine, whisperFor } from "./speech-models";

describe("on-device speech model choice", () => {
  it("uses Moonshine for English", () => {
    expect(effectiveSpeechModel("moonshine-base", "en")).toBe("moonshine-base");
    expect(effectiveSpeechModel("moonshine-tiny", "en-GB")).toBe("moonshine-tiny");
    expect(effectiveSpeechModel("moonshine-base", "EN-us")).toBe("moonshine-base");
  });
  it("switches to the matching Whisper size for other languages", () => {
    expect(effectiveSpeechModel("moonshine-base", "de")).toBe("base");
    expect(effectiveSpeechModel("moonshine-tiny", "hi-IN")).toBe("tiny");
  });
  it("leaves Whisper alone in every language", () => {
    for (const size of ["tiny", "base", "small"]) {
      expect(effectiveSpeechModel(size, "fr")).toBe(size);
      expect(effectiveSpeechModel(size, "en")).toBe(size);
    }
  });
  it("treats unknown saved values as Whisper base", () => {
    expect(effectiveSpeechModel("large", "en")).toBe("base");
    expect(effectiveSpeechModel("", "en")).toBe("base");
  });
  it("falls back from Moonshine to a Whisper size", () => {
    expect(whisperFor("moonshine-base")).toBe("base");
    expect(whisperFor("moonshine-tiny")).toBe("tiny");
    expect(whisperFor("small")).toBe("small");
  });
  it("marks Moonshine as English only and lists real repos", () => {
    expect(SPEECH_MODELS["moonshine-base"].englishOnly).toBe(true);
    expect(SPEECH_MODELS.base.englishOnly).toBeUndefined();
    expect(SPEECH_MODELS["moonshine-base"].repo).toBe("onnx-community/moonshine-base-ONNX");
    expect(SPEECH_MODELS["moonshine-tiny"].repo).toBe("onnx-community/moonshine-tiny-ONNX");
  });
});

describe("Moonshine input", () => {
  it("gives short clips enough tokens to say something", () => {
    expect(moonshineMaxTokens(8000)).toBe(12); // half a second
    expect(moonshineMaxTokens(16000 * 10)).toBe(60);
    expect(moonshineMaxTokens(16000 * 10 + 1)).toBe(61);
  });
  it("keeps audio up to 30 s whole and splits longer audio into equal pieces", () => {
    expect(splitForMoonshine(new Float32Array(16000 * 30))).toHaveLength(1);
    const pieces = splitForMoonshine(new Float32Array(16000 * 70));
    expect(pieces).toHaveLength(3);
    expect(pieces.reduce((n, p) => n + p.length, 0)).toBe(16000 * 70);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(16000 * 30);
  });
});

describe("noise filter", () => {
  it("drops what speech models hear in silence", () => {
    for (const t of ["you", "Thank you.", "[BLANK_AUDIO]", "(music)", "...", " Thanks for watching! "]) expect(isNoiseTranscript(t), t).toBe(true);
    for (const t of ["Thank you, that's all", "What time is it?"]) expect(isNoiseTranscript(t), t).toBe(false);
  });
});
