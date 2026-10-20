// Text for Supertonic 3 (Supertone, OpenRAIL-M model), which reads characters, not phonemes: the
// clean-up follows Supertone's MIT-licensed web/helper.js. Kept free of workers and browser APIs so
// it can be unit-tested; the voice itself runs in supertonic3.worker.ts.

/** The languages Supertonic 3 speaks, by code. */
export const SUPERTONIC3_LANGUAGES = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
  "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
] as const;

const SUPPORTED = new Set<string>(SUPERTONIC3_LANGUAGES);
/** Languages written in Latin letters: for these the script alone doesn't tell which one it is. */
const LATIN = new Set(["en", "cs", "da", "de", "es", "et", "fi", "fr", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "sk", "sl", "sv", "tr", "vi"]);
/**
 * Everyday words of the most used Latin-script languages, to tell them apart. Words shared across
 * languages count for each; "is", "of" and "to" aren't listed for English (Dutch, Polish use them).
 */
const COMMON_WORDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    en: "the and with this that these you your what how why when where which who would could have has been they she please yes can are it it's i'm don't from about just sure",
    de: "der die das und ist nicht ich du sie wir ein eine mit auf für von zu den dem des im auch sich es wie was",
    es: "el la los las y a es que de en un una por para con no se lo como más pero su al del está",
    fr: "le la les et est que de en un une pour avec ne pas je vous il elle des du au ce qui sur dans",
    it: "il lo la gli le e è che di in un una per con non si come più ma del della sono",
    pt: "o a os as e é que de em um uma para com não se como mais mas do da são está você",
    nl: "de het een en is van in op met niet ik je dat die voor zijn maar ook er",
    pl: "i w na z że nie to jest się do jak ale co od po tak",
    sv: "och är att det som en ett på med för inte jag du har av till den",
    tr: "ve bir bu da de için ile ne çok var mi gibi daha",
  }).map(([lang, words]) => [lang, new Set(words.split(" "))]),
);

/**
 * Which language to read a sentence in. The writing system decides when it can (Korean, Japanese,
 * Arabic, Greek, Hindi, Cyrillic). Latin text goes by its everyday words (the user's own language,
 * `preferred`, wins a tie); without a clear sign it's the preferred language when Supertonic speaks
 * it, otherwise English.
 */
export function supertonicLanguage(text: string, preferred: string): string {
  const lang = preferred.toLowerCase().split(/[-_]/)[0];
  if (/[가-힯ᄀ-ᇿ]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text) || (/[一-鿿]/.test(text) && lang === "ja")) return "ja";
  if (/[؀-ۿ]/.test(text)) return "ar";
  if (/[Ͱ-Ͽ]/.test(text)) return "el";
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  if (/[Ѐ-ӿ]/.test(text)) return ["ru", "uk", "bg"].includes(lang) ? lang : "ru";
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let best = { lang: "", score: 0 };
  for (const [candidate, common] of Object.entries(COMMON_WORDS)) {
    const score = words.filter((w) => common.has(w)).length / Math.max(1, words.length) + (candidate === lang ? 0.01 : 0);
    if (score > best.score) best = { lang: candidate, score };
  }
  if (best.score >= 0.15) return best.lang;
  return LATIN.has(lang) ? lang : "en";
}

const REPLACEMENTS: [string, string][] = [
  ["–", "-"],
  ["‑", "-"],
  ["—", "-"],
  ["_", " "],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["´", "'"],
  ["`", "'"],
  ["[", " "],
  ["]", " "],
  ["|", " "],
  ["/", " "],
  ["#", " "],
  ["→", " "],
  ["←", " "],
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

/**
 * The text as Supertonic 3 expects it: decomposed accents (it knows "e" plus an accent mark, not
 * "é"), plain punctuation, a closing mark, and the language tags around it.
 */
export function supertonicText(text: string, lang: string): string {
  let t = text.normalize("NFKD").replace(EMOJI, "");
  for (const [from, to] of REPLACEMENTS) t = t.replaceAll(from, to);
  t = t
    .replace(/[♥☆♡©\\]/g, "")
    .replace(/ ([,.!?;:'])/g, "$1")
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(t)) t += ".";
  const tag = SUPPORTED.has(lang) ? lang : "en";
  return `<${tag}>${t}</${tag}>`;
}

/** Character ids for the model (`indexer`: unicode_indexer.json, by code point; -1 when unknown). */
export function supertonicIds(text: string, indexer: ArrayLike<number>): BigInt64Array {
  const codes = Array.from(text, (c) => c.codePointAt(0)!);
  return BigInt64Array.from(codes, (c) => BigInt(c < indexer.length ? indexer[c] : -1));
}
