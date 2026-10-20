// On-device speech recognition models and the rules for picking one. Kept free of workers and
// browser APIs so the rules can be unit-tested and shared by the app and the speech workers.

export type WhisperSize = "tiny" | "base" | "small";
export type MoonshineSize = "moonshine-tiny" | "moonshine-base";
export type SpeechModel = WhisperSize | MoonshineSize;

export const SPEECH_MODELS: Record<SpeechModel, { label: string; mb: number; repo: string; englishOnly?: boolean }> = {
  tiny: { label: "Whisper tiny: fast, good for phones", mb: 41, repo: "onnx-community/whisper-tiny" },
  base: { label: "Whisper base: balanced (recommended)", mb: 77, repo: "onnx-community/whisper-base" },
  small: { label: "Whisper small: most accurate, slower", mb: 249, repo: "onnx-community/whisper-small" },
  // 8-bit encoder + merged decoder. Moonshine reads only the audio it's given (Whisper always
  // reads a 30 s window): on an M1's CPU a 4.5 s question took 0.32 s (base) vs 1.15 s (Whisper base).
  "moonshine-base": { label: "Moonshine base: fastest, English only", mb: 67, repo: "onnx-community/moonshine-base-ONNX", englishOnly: true },
  "moonshine-tiny": { label: "Moonshine tiny: smallest, English only, less accurate", mb: 32, repo: "onnx-community/moonshine-tiny-ONNX", englishOnly: true },
};

export const isMoonshine = (model: string): model is MoonshineSize => model.startsWith("moonshine-");

/** The Whisper size used in place of a Moonshine model (other languages, or if Moonshine can't run). */
export const whisperFor = (model: SpeechModel): WhisperSize => (model === "moonshine-tiny" ? "tiny" : isMoonshine(model) ? "base" : model);

/**
 * The model that actually runs: Moonshine only understands English, so for any other language the
 * matching Whisper size is used instead. Unknown values (old settings) fall back to Whisper base.
 */
export function effectiveSpeechModel(model: string, language: string): SpeechModel {
  if (!(model in SPEECH_MODELS)) return "base";
  const chosen = model as SpeechModel;
  return isMoonshine(chosen) && language.toLowerCase().split("-")[0] !== "en" ? whisperFor(chosen) : chosen;
}

const RATE = 16000;

/**
 * Moonshine's token budget. transformers.js allows 6 tokens per whole second, which is 0 for a
 * quick "Yes." under a second (it came back cut short), so give short clips a floor.
 */
export function moonshineMaxTokens(samples: number): number {
  return Math.max(12, Math.ceil((samples / RATE) * 6));
}

/**
 * Moonshine handles any length up to about 30 s; longer audio (long dictation) is cut into equal
 * pieces under that, each transcribed on its own.
 */
export function splitForMoonshine(audio: Float32Array, maxSeconds = 30): Float32Array[] {
  const max = maxSeconds * RATE;
  if (audio.length <= max) return [audio];
  const pieces = Math.ceil(audio.length / max);
  const size = Math.ceil(audio.length / pieces);
  const out: Float32Array[] = [];
  for (let start = 0; start < audio.length; start += size) out.push(audio.subarray(start, start + size));
  return out;
}

/** Phrases speech models "hear" in silence or noise; these count as nothing said. */
export function isNoiseTranscript(text: string): boolean {
  return /^(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching!?|\.+)$/i.test(text.trim());
}
