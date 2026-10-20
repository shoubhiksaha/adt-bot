/** 32 ms frames at 16 kHz, the size Silero VAD expects. */
export const FRAME = 512;
export const FRAME_MS = (FRAME / 16000) * 1000;

export type SegmenterOptions = {
  /** Silence after speech that ends a turn (when no turn model has judged it). */
  endSilenceMs: number;
  /** Silence after which the audio is offered to a turn model ("silence" event). */
  settleMs?: number;
  /**
   * Silence before a speculative transcription starts ("pause" event). Silero often dips for a
   * frame between words; each pause costs a full Whisper run, so wait for a real gap.
   */
  pauseMs?: number;
  /** Silence that ends a turn the turn model judged unfinished (the speaker is mid-thought). */
  patientEndMs?: number;
  /**
   * Silence after which the speaker has probably finished, even if the turn model thought not
   * ("lull" event): voice mode may start the reply early, without speaking it yet.
   */
  lullMs?: number;
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
  /** The utterance has passed `minSpeechMs` of speech, so it isn't a cough or click. Once per utterance. */
  | { type: "speech" }
  /** The utterance ended too short to count as speech and was dropped. */
  | { type: "discard" }
  /** Silence just began: a good moment to start transcribing speculatively. */
  | { type: "pause"; audio: Float32Array; version: number }
  /** `lullMs` of silence: the speaker has probably finished, though the turn isn't over yet. Once per pause. */
  | { type: "lull"; version: number }
  /** Speech continued, so any speculative transcription for `version` is stale. */
  | { type: "resume"; version: number }
  /** `silenceMs`: how long the speaker had been quiet when the turn was judged over. */
  | { type: "end"; audio: Float32Array; version: number; silenceMs?: number }
  /** Speech so far, for live captions while the user is still talking. */
  | { type: "progress"; audio: Float32Array }
  /** `settleMs` of silence: ask the turn model whether the speaker has finished (see `decide`). */
  | { type: "silence"; audio: Float32Array; version: number };

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
  /** The turn model's verdict on the current pause. */
  private verdict: { version: number; complete: boolean } | null = null;

  constructor(options: SegmenterOptions) {
    this.options = {
      minSpeechMs: 250,
      prerollMs: 320,
      maxSpeechMs: 30_000,
      startThreshold: 0.6,
      endThreshold: 0.35,
      settleMs: 200,
      pauseMs: 128,
      patientEndMs: 2000,
      lullMs: 1000,
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
    this.verdict = null;
  }

  /**
   * The turn model's answer for the pause in utterance `version`: finished ends the turn now;
   * unfinished waits longer (`patientEndMs`) before ending it. Stale answers are ignored.
   */
  decide(version: number, complete: boolean) {
    if (version === this.version && this.state === "trailing") this.verdict = { version, complete };
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
        if (this.speechFrames === frames(o.minSpeechMs)) events.push({ type: "speech" });
      }
    }
    if (probability < o.endThreshold) {
      if (this.state === "speech") {
        this.state = "trailing";
        this.silence = 0;
      }
      this.silence++;
    } else if (this.state === "trailing") {
      this.silence++;
    }
    if (this.state === "trailing" && this.silence === frames(o.pauseMs) && this.speechFrames >= frames(o.minSpeechMs)) {
      events.push({ type: "pause", audio: concat(this.frames), version: this.version });
    }

    if (this.state === "speech" && ++this.sinceProgress >= frames(600)) {
      this.sinceProgress = 0;
      events.push({ type: "progress", audio: concat(this.frames) });
    }
    if (this.state === "trailing" && this.silence === frames(o.settleMs) && this.speechFrames >= frames(o.minSpeechMs)) {
      events.push({ type: "silence", audio: concat(this.frames), version: this.version });
    }
    if (this.state === "trailing" && this.silence === frames(o.lullMs) && this.speechFrames >= frames(o.minSpeechMs)) {
      events.push({ type: "lull", version: this.version });
    }

    const verdict = this.verdict?.version === this.version ? this.verdict : null;
    const endAfter = verdict ? (verdict.complete ? Math.min(o.endSilenceMs, o.settleMs) : Math.max(o.endSilenceMs, o.patientEndMs)) : o.endSilenceMs;
    const ended = this.state === "trailing" && this.silence >= frames(endAfter);
    const tooLong = this.frames.length >= frames(o.maxSpeechMs);
    if (ended || tooLong) {
      const long = this.speechFrames >= frames(o.minSpeechMs);
      // Keep ~100 ms of the trailing silence; the rest only slows transcription.
      const keep = ended ? this.frames.length - Math.max(0, this.silence - frames(100)) : this.frames.length;
      const audio = concat(this.frames.slice(0, keep));
      const version = this.version;
      const silenceMs = ended ? Math.round(this.silence * FRAME_MS) : 0;
      this.reset();
      events.push(long ? { type: "end", audio, version, silenceMs } : { type: "discard" });
    }
    return events;
  }
}

/**
 * How long to wait when the turn model thinks the speaker is mid-thought, following the user's
 * "end of turn" setting (quick 450 ms → 1.2 s, normal 700 ms → 1.6 s, patient 1.2 s → 2.5 s).
 */
export const patientFor = (endSilenceMs: number) => Math.round(Math.min(2500, Math.max(1200, endSilenceMs * 2.2)));

/** Halfway through that longer wait, the speaker has probably finished after all ("lull"). */
export const lullFor = (endSilenceMs: number) => Math.max(endSilenceMs, Math.round(patientFor(endSilenceMs) / 2));

/**
 * Whether the turn model's verdict on a pause (null: no model) makes it worth starting the reply
 * early. Over 0.5 the turn ends at once anyway; an unsure verdict means the longer wait. On synthetic
 * questions, finished ones mostly scored over 0.85 and cut-off ones under 0.1, with the odd finished
 * one in between (0.15); anything lower waits for the lull.
 */
export function startsEarly(probability: number | null): boolean {
  return probability === null || (probability >= 0.1 && probability <= 0.5);
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
