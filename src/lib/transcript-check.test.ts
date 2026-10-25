import { describe, expect, it } from "vitest";
import { collapseRepeats, cutShort, quietestSplit, repairTranscript, wordCount } from "./transcript-check";

// From a real voice-debug.log: the last caption, and what the final transcription said.
const CAPTION = "And may event available in Slack, free version. Also, if the lead of the MacBook is open and MacBook goes to sleep on the screen, lots of innovative boots will";

describe("checking the final transcription against the captions", () => {
  it("counts a speech model's loops once", () => {
    expect(collapseRepeats("Can I use any other kind of old leftover leftover leftover leftover")).toBe("Can I use any other kind of old leftover");
    expect(wordCount("MacBook goes to 2.5, 2.5, 2.5, 2.5, 2")).toBeLessThan(9);
    expect(collapseRepeats("yes, yes")).toBe("yes, yes");
  });

  it("notices a long question that came back as one word", () => {
    expect(cutShort("that", CAPTION)).toBe(true);
    // A normal transcription differs from the captions, but covers them.
    expect(cutShort("Is it available in the Slack free version? Also, if the lid of the MacBook is open and it goes to sleep, will the bots keep working?", CAPTION)).toBe(false);
    // Short questions are left alone: the captions there are too rough to judge by.
    expect(cutShort("Yes.", "Yes, good, good.")).toBe(false);
    expect(cutShort("", "")).toBe(false);
  });

  it("uses the second try when it covers the captions, else the captions", () => {
    const retry = "Is it available in the Slack free version? Also if the lid of the MacBook is open and the MacBook goes to sleep";
    expect(repairTranscript("that", retry, CAPTION)).toEqual({ text: retry, repaired: "retry" });
    expect(repairTranscript("that", "that", CAPTION)).toEqual({ text: CAPTION, repaired: "captions" });
    expect(repairTranscript("that", "", CAPTION).repaired).toBe("captions");
    const fine = "Is it available in the Slack free version, and what if the MacBook goes to sleep with the lid open?";
    expect(repairTranscript(fine, "", CAPTION)).toEqual({ text: fine, repaired: null });
  });

  it("splits a long stretch at the gap between words", () => {
    const rate = 16000;
    const audio = new Float32Array(rate * 9).map((_, i) => 0.3 * Math.sin(i / 7));
    // A pause from 5.0 to 5.4 s.
    audio.fill(0, rate * 5, rate * 5.4);
    const at = quietestSplit(audio, rate);
    expect(at).toBeGreaterThan(rate * 5);
    expect(at).toBeLessThan(rate * 5.4);
    expect(quietestSplit(new Float32Array(1000))).toBe(500);
  });
});
