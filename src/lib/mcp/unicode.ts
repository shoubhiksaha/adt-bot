/**
 * Invisible characters in what MCP servers send. Tool names, descriptions, schemas and results are
 * read by the model, so text the user can't see (Unicode TAG characters, zero-width characters,
 * bidi overrides and isolates, other format characters, stray control codes) is a way to slip it
 * instructions. They are removed and counted, so the app can warn about the server.
 *
 * Kept, because real text needs them: the zero-width joiner inside emoji sequences, a variation
 * selector right after an emoji, ZWJ/ZWNJ between letters of scripts that use them (Persian,
 * Indic), and left-to-right/right-to-left marks in text that has right-to-left letters.
 */

// Default-ignorable code points cover the TAG block (U+E0000–U+E007F), zero-width characters,
// bidi controls, variation selectors, Hangul fillers and the rest of the invisible format
// characters. Interlinear annotation marks and control codes (other than tab and newlines) too.
const HIDDEN = /[\p{Default_Ignorable_Code_Point}￹-￻\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const HIDDEN_ONE = new RegExp(HIDDEN.source, "u");
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Emoji_Modifier}⃣]/u;
const EMOJI = /\p{Emoji}/u;
const SCRIPT_LETTER = /[\p{L}\p{M}]/u;
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;

const before = (text: string, index: number) => {
  const prev = text.codePointAt(index - 1);
  // Step back over a surrogate pair.
  if (prev !== undefined && prev >= 0xdc00 && prev <= 0xdfff && index >= 2) return String.fromCodePoint(text.codePointAt(index - 2) ?? 0);
  return prev === undefined ? "" : String.fromCodePoint(prev);
};
const after = (text: string, index: number, char: string) => {
  const next = text.codePointAt(index + char.length);
  return next === undefined ? "" : String.fromCodePoint(next);
};

function legitimate(char: string, text: string, index: number): boolean {
  const prev = before(text, index);
  const next = after(text, index, char);
  switch (char) {
    case "‍": // zero-width joiner: emoji sequences (👩‍💻) and Indic/Arabic shaping
      if ((PICTOGRAPH.test(prev) || prev === "️") && PICTOGRAPH.test(next)) return true;
      return nonLatinLetter(prev) && nonLatinLetter(next);
    case "‌": // zero-width non-joiner: Persian and Indic words
      return nonLatinLetter(prev) && nonLatinLetter(next);
    case "︎":
    case "️": // text/emoji presentation, once, right after an emoji character (❤️, 1️⃣)
      return EMOJI.test(prev) && !/[︎️]/.test(prev);
    case "‎":
    case "‏":
    case "؜": // direction marks belong in right-to-left text
      return RTL.test(text);
    default:
      return false;
  }
}

const nonLatinLetter = (c: string) => c !== "" && c.charCodeAt(0) > 0x24f && SCRIPT_LETTER.test(c);

/** Whether text has characters that would be removed. */
export function hasHidden(text: string): boolean {
  if (!HIDDEN_ONE.test(text)) return false;
  return stripHidden(text).removed > 0;
}

/** The text without hidden characters, and how many were removed. */
export function stripHidden(text: string): { text: string; removed: number } {
  if (typeof text !== "string" || !HIDDEN_ONE.test(text)) return { text, removed: 0 };
  let removed = 0;
  const out = text.replace(HIDDEN, (char: string, index: number) => {
    if (legitimate(char, text, index)) return char;
    removed++;
    return "";
  });
  return { text: out, removed };
}

/** Cleans every string (and object key) in a JSON value, e.g. an input schema. */
export function cleanDeep<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const r = stripHidden(v);
      removed += r.removed;
      return r.text;
    }
    if (!v || typeof v !== "object" || depth > 64) return v;
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      const k = stripHidden(key);
      removed += k.removed;
      // Two keys that only differed by hidden characters: keep the first.
      if (!(k.text in out)) out[k.text] = walk(item, depth + 1);
    }
    return out;
  };
  const cleaned = walk(value, 0) as T;
  return { value: removed ? cleaned : value, removed };
}

/** Makes hidden characters visible as \uXXXX, for showing the exact text (approval cards). */
export function revealHidden(text: string): string {
  if (!HIDDEN_ONE.test(text)) return text;
  return text.replace(HIDDEN, (char: string, index: number) => {
    if (legitimate(char, text, index)) return char;
    const code = char.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}
