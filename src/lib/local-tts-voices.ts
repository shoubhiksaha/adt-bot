// The on-device voices and the rules for using them. Kept free of workers and browser APIs so the
// rules can be unit-tested and shared with the voice workers.
import type { VoiceSettings } from "./types";

export type LocalEngine = "supertonic" | "kokoro";
/** Which on-device voice to speak with. */
export type LocalChoice = { engine: LocalEngine; voice: string };

export const LOCAL_VOICES: { id: string; label: string }[] = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((id) => ({
  id,
  label: `${id[0] === "F" ? "Female" : "Male"} ${id[1]}`,
}));
/** Download size of the model files (fp32 text encoder, denoiser and decoder). */
export const LOCAL_VOICE_MB = 262;

/** Kokoro's voices, best-rated first (a = American, b = British English). */
export const KOKORO_VOICES: { id: string; label: string }[] = [
  ["af_heart", "Heart (US, female)"],
  ["af_bella", "Bella (US, female)"],
  ["af_nicole", "Nicole (US, female, soft)"],
  ["af_aoede", "Aoede (US, female)"],
  ["af_kore", "Kore (US, female)"],
  ["af_sarah", "Sarah (US, female)"],
  ["af_nova", "Nova (US, female)"],
  ["af_alloy", "Alloy (US, female)"],
  ["af_sky", "Sky (US, female)"],
  ["af_jessica", "Jessica (US, female)"],
  ["af_river", "River (US, female)"],
  ["am_fenrir", "Fenrir (US, male)"],
  ["am_michael", "Michael (US, male)"],
  ["am_puck", "Puck (US, male)"],
  ["am_echo", "Echo (US, male)"],
  ["am_eric", "Eric (US, male)"],
  ["am_liam", "Liam (US, male)"],
  ["am_onyx", "Onyx (US, male)"],
  ["am_adam", "Adam (US, male)"],
  ["am_santa", "Santa (US, male)"],
  ["bf_emma", "Emma (UK, female)"],
  ["bf_isabella", "Isabella (UK, female)"],
  ["bf_alice", "Alice (UK, female)"],
  ["bf_lily", "Lily (UK, female)"],
  ["bm_george", "George (UK, male)"],
  ["bm_fable", "Fable (UK, male)"],
  ["bm_lewis", "Lewis (UK, male)"],
  ["bm_daniel", "Daniel (UK, male)"],
].map(([id, label]) => ({ id, label }));
/** Download size of Kokoro's 8-bit model (the voices add about 0.5 MB each). */
export const KOKORO_MB = 92;

/** The on-device voice these settings speak with, or null for any other kind of voice. */
export function localChoice(voice: Pick<VoiceSettings, "tts" | "localVoice" | "kokoroVoice">): LocalChoice | null {
  if (voice.tts === "local") {
    return { engine: "supertonic", voice: LOCAL_VOICES.some((v) => v.id === voice.localVoice) ? voice.localVoice : "F1" };
  }
  if (voice.tts === "kokoro") {
    return { engine: "kokoro", voice: KOKORO_VOICES.some((v) => v.id === voice.kokoroVoice) ? voice.kokoroVoice : "af_heart" };
  }
  return null;
}

/**
 * Kokoro reads at most ~500 sounds at a time and drops the rest, so a very long sentence is cut at
 * commas or spaces into pieces it can say whole.
 */
export function splitLongText(text: string, max = 300): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    const at = cut > max / 3 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
