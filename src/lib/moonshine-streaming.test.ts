// @vitest-environment node
import { describe, expect, it } from "vitest";
import { agreedPrefix, decodeTokens, encoderWindow, maxTokens, vocabulary } from "./moonshine-streaming";

const config = { total_lookahead: 16, depth: 6 };

describe("Moonshine streaming captions", () => {
  it("encodes only frames with enough look-ahead, with 96 frames of left context", () => {
    // 40 frames so far, none encoded: 24 are stable.
    expect(encoderWindow(40, 0, config, false)).toEqual({ stable: 24, fresh: 24, start: 0, size: 40, offset: 0 });
    // Later: 200 frames, 150 encoded. The window starts 96 before the first new frame.
    expect(encoderWindow(200, 150, config, false)).toEqual({ stable: 184, fresh: 34, start: 54, size: 146, offset: 96 });
    // Nothing new to encode yet.
    expect(encoderWindow(20, 4, config, false).fresh).toBe(0);
    // At the end everything is encoded.
    expect(encoderWindow(200, 184, config, true)).toMatchObject({ stable: 200, fresh: 16 });
  });

  it("keeps the part of the last caption the model still agrees with", () => {
    expect(agreedPrefix([5, 6, 7], [5, 6, 7, 2])).toBe(3);
    expect(agreedPrefix([5, 6, 7], [5, 9, 7, 2])).toBe(1);
    expect(agreedPrefix([], [4])).toBe(0);
  });

  it("caps tokens by the length of the audio", () => {
    expect(maxTokens(50)).toBe(7); // 1 s
    expect(maxTokens(0)).toBe(0);
  });

  it("turns tokens into text like the tokenizer's decoder", () => {
    const vocab = vocabulary({
      model: { vocab: { "<unk>": 0, "<s>": 1, "</s>": 2, "<0xC3>": 3, "<0xA9>": 4, "▁Caf": 5, "▁is": 6, "▁open": 7, ".": 8 } },
      added_tokens: [
        { id: 1, content: "<s>", special: true },
        { id: 2, content: "</s>", special: true },
      ],
    });
    // "Café is open." with the é as UTF-8 byte tokens; the leading space goes.
    expect(decodeTokens([1, 5, 3, 4, 6, 7, 8, 2], vocab)).toBe("Café is open.");
    expect(decodeTokens([], vocab)).toBe("");
  });
});
