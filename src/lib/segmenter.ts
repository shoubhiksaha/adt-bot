/** 32 ms frames at 16 kHz, the size Silero VAD expects. */
export const FRAME = 512;
export const FRAME_MS = (FRAME / 16000) * 1000;

export type SegmenterOptions = {
  /** Silence after speech that ends a turn. */
  endSilenceMs: number;
  /** Speech shorter than this is treated as a noise blip. */
  minSpeechMs?: number;
  /** Audio kept from just before speech starts, so first syllables aren't clipped. */
  prerollMs?: number;
  /** Hard cap on a single turn. */
  maxSpeechMs?: number;
  /** Probability needed to start (raised while the bot is talking, to ignore echo). */
  startThreshold?: number;
  endThreshold?: number;
};

export type SegmentEvent =
  | { type: "start" }
  /** Silence just began: a good moment to start transcribing speculatively. */
  | { type: "pause"; audio: Float32Array; version: number }
  /** Speech continued, so any speculative transcription for `version` is stale. */
  | { type: "resume"; version: number }
  | { type: "end"; audio: Float32Array; version: number }
  /** Speech so far, for live captions while the user is still talking. */
  | { type: "progress"; audio: Float32Array };

/**
 * Turns per-frame voice probabilities into utterances. Pure and synchronous so it can be tested
 * with synthetic input and run inside a worker next to the VAD model.
 */
export class Segmenter {
  private options: Required<SegmenterOptions>;
  private preroll: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private state: "idle" | "speech" | "trailing" = "idle";
  private above = 0;
  private silence = 0;
  private speechFrames = 0;
  private version = 0;
  private sinceProgress = 0;

  constructor(options: SegmenterOptions) {
    this.options = {
      minSpeechMs: 250,
      prerollMs: 320,
      maxSpeechMs: 30_000,
      startThreshold: 0.6,
      endThreshold: 0.35,
      ...options,
    };
  }

  configure(options: Partial<SegmenterOptions>) {
    this.options = { ...this.options, ...options };
  }

  get speaking() {
    return this.state !== "idle";
  }

  reset() {
    this.preroll = [];
    this.frames = [];
    this.state = "idle";
    this.above = 0;
    this.silence = 0;
    this.speechFrames = 0;
  }

  /** Ends the current utterance now (e.g. the user tapped "done"), even if it is short. */
  flush(): SegmentEvent[] {
    if (this.state === "idle" || !this.frames.length) return [];
    const audio = concat(this.frames);
    const version = this.version;
    this.reset();
    return [{ type: "end", audio, version }];
  }

  push(frame: Float32Array, probability: number): SegmentEvent[] {
    const o = this.options;
    const events: SegmentEvent[] = [];
    const frames = (ms: number) => Math.max(1, Math.round(ms / FRAME_MS));

    if (this.state === "idle") {
      this.preroll.push(frame);
      if (this.preroll.length > frames(o.prerollMs)) this.preroll.shift();
      this.above = probability >= o.startThreshold ? this.above + 1 : 0;
      // Two confident frames in a row (64 ms) to start, which filters clicks and taps.
      if (this.above >= 2) {
        this.state = "speech";
        this.frames = [...this.preroll];
        this.preroll = [];
        this.speechFrames = this.above;
        this.silence = 0;
        this.sinceProgress = 0;
        this.version++;
        events.push({ type: "start" });
      }
      return events;
    }

    this.frames.push(frame);
    if (probability >= o.endThreshold) {
      if (this.state === "trailing" && probability >= o.startThreshold) {
        this.state = "speech";
        events.push({ type: "resume", version: this.version });
        this.version++;
      }
      if (this.state === "speech") {
        this.speechFrames++;
        this.silence = 0;
      }
    }
    if (probability < o.endThreshold) {
      if (this.state === "speech") {
        this.state = "trailing";
        this.silence = 0;
        if (this.speechFrames >= frames(o.minSpeechMs)) {
          events.push({ type: "pause", audio: concat(this.frames), version: this.version });
        }
      }
      this.silence++;
    } else if (this.state === "trailing") {
      this.silence++;
    }

    if (this.state === "speech" && ++this.sinceProgress >= frames(1500)) {
      this.sinceProgress = 0;
      events.push({ type: "progress", audio: concat(this.frames) });
    }

    const ended = this.state === "trailing" && this.silence >= frames(o.endSilenceMs);
    const tooLong = this.frames.length >= frames(o.maxSpeechMs);
    if (ended || tooLong) {
      const long = this.speechFrames >= frames(o.minSpeechMs);
      // Keep ~100 ms of the trailing silence; the rest only slows transcription.
      const keep = ended ? this.frames.length - Math.max(0, this.silence - frames(100)) : this.frames.length;
      const audio = concat(this.frames.slice(0, keep));
      const version = this.version;
      this.reset();
      if (long) events.push({ type: "end", audio, version });
    }
    return events;
  }
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
