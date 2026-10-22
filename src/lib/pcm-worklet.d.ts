/** The voice-mode echo canceller inside the microphone worklet (see pcm-worklet.js). */
export class EchoCanceller {
  /** Blocks since the reference last had sound. */
  readonly quiet: number;
  /** How far the echo was turned down since the last call, in dB (null if the bot was quiet meanwhile). */
  takeReduction(): number | null;
  /** One 128-sample block of microphone and of what went to the speakers (null: silence). */
  process(mic: Float32Array, ref: Float32Array | null): Float32Array;
}
