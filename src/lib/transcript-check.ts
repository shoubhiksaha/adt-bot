// The final transcription, checked against the live captions. Whisper sometimes stops early on a
// long stretch of speech: twelve seconds of a question came back as "that", while the captions on
// screen had nearly all of it.

/** A word or short phrase a speech model repeated three times or more in a row ("leftover leftover leftover"), once. */
export function collapseRepeats(text: string): string {
  return text.replace(/\b(\w+(?:[\s,'-]+\w+){0,2}?)(?:[\s,.!?;:-]+\1\b){2,}/gi, "$1");
}

export function wordCount(text: string): number {
  return (collapseRepeats(text).match(/[\p{L}\p{N}']+/gu) ?? []).length;
}

/** The final text covers much less than the captions did (at least six words of them). */
export function cutShort(final: string, caption: string): boolean {
  const heard = wordCount(caption);
  return heard >= 6 && wordCount(final) < heard * 0.5;
}

/**
 * Where to split a long stretch for a second try, so each half is short enough not to trip the
 * model: the quietest 200 ms between a third and two thirds of the way in (a gap between words).
 */
export function quietestSplit(audio: Float32Array, rate = 16000): number {
  const size = Math.round(rate * 0.2);
  const hop = Math.round(rate * 0.02);
  const from = Math.floor(audio.length / 3);
  const to = Math.floor((audio.length * 2) / 3) - size;
  if (to <= from) return Math.floor(audio.length / 2);
  let best = from;
  let quietest = Infinity;
  for (let at = from; at <= to; at += hop) {
    let energy = 0;
    for (let i = at; i < at + size; i++) energy += audio[i] * audio[i];
    if (energy < quietest) {
      quietest = energy;
      best = at;
    }
  }
  return best + Math.floor(size / 2);
}

/**
 * What to use when the final text was cut short: the second try if it covers the captions, else
 * whichever of it and the captions has more words (captions are rougher, but far better than one word).
 */
export function repairTranscript(final: string, retry: string, caption: string): { text: string; repaired: "retry" | "captions" | null } {
  if (!cutShort(final, caption)) return { text: final, repaired: null };
  if (retry.trim() && !cutShort(retry, caption)) return { text: retry.trim(), repaired: "retry" };
  const captions = collapseRepeats(caption).trim();
  return wordCount(captions) > Math.max(wordCount(final), wordCount(retry)) ? { text: captions, repaired: "captions" } : { text: final, repaired: null };
}
