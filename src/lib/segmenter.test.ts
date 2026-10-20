// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FRAME, FRAME_MS, lullFor, patientFor, Segmenter, type SegmentEvent, startsEarly } from "./segmenter";

const frame = new Float32Array(FRAME);
/** Feeds `ms` of frames at one voice probability; returns the events by type. */
function feed(segmenter: Segmenter, ms: number, probability: number, events: SegmentEvent[] = []) {
  for (let t = 0; t < ms; t += FRAME_MS) events.push(...segmenter.push(frame, probability));
  return events;
}
const types = (events: SegmentEvent[]) => events.map((e) => e.type).filter((t) => t !== "progress");

describe("probable ends of turn (early replies)", () => {
  it("reports a lull once, partway into a long pause, before the turn ends", () => {
    const s = new Segmenter({ endSilenceMs: 700, patientEndMs: 1540, lullMs: 770 });
    const events = feed(s, 600, 0.9);
    // The turn model says the speaker is mid-thought: wait longer, with a lull on the way.
    const version = (events.find((e) => e.type === "start") ? 1 : 0) as number;
    feed(s, 250, 0.05, events);
    s.decide(version, false);
    feed(s, 1400, 0.05, events);
    expect(types(events)).toEqual(["start", "speech", "pause", "silence", "lull", "end"]);
  });

  it("reports no lull when the speaker carries on first", () => {
    const s = new Segmenter({ endSilenceMs: 700, patientEndMs: 1540, lullMs: 770 });
    const events = feed(s, 600, 0.9);
    feed(s, 500, 0.05, events);
    feed(s, 300, 0.9, events);
    expect(types(events)).toEqual(["start", "speech", "pause", "silence", "resume"]);
  });

  it("follows the end-of-turn setting", () => {
    expect([450, 700, 1200].map(patientFor)).toEqual([1200, 1540, 2500]);
    expect([450, 700, 1200].map(lullFor)).toEqual([600, 770, 1250]);
  });

  it("starts early on an unsure verdict or none, not on a clear one either way", () => {
    expect(startsEarly(null)).toBe(true);
    expect(startsEarly(0.15)).toBe(true);
    expect(startsEarly(0.5)).toBe(true);
    // Clearly finished: the turn ends now anyway. Clearly mid-thought: wait for the lull.
    expect(startsEarly(0.9)).toBe(false);
    expect(startsEarly(0.05)).toBe(false);
  });
});
