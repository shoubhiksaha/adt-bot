// Records the bot's voice as it goes to the speakers, for a voice report (src/lib/voice-recording.ts):
// blocks of 4096 samples go to the page, which keeps the last few seconds.

/** Samples per message (about 85 ms at 48 kHz). */
const BLOCK = 4096;
/** Quieter than this (peak) counts as silence. */
const QUIET = 1e-4;

class BotVoiceRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
    this.quiet = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    // Half a second of a pause is kept (a gap in the voice is worth hearing); longer ones are left
    // out, so the seconds kept are the voice and not the quiet after it.
    if (peak < QUIET) {
      this.quiet += samples.length;
      if (this.quiet > sampleRate / 2) return true;
    } else this.quiet = 0;
    for (let i = 0; i < samples.length; i++) {
      this.block[this.filled++] = samples[i];
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

if (typeof registerProcessor === "function") registerProcessor("bot-voice-recorder", BotVoiceRecorder);
