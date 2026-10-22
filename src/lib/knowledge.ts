import { markUntrusted } from "./agent/vendor/copilotkit/untrusted-content";
import { clear, createStore, del, get, set } from "idb-keyval";
import { hybridRank } from "./hybrid";
import type { KnowledgeRef } from "./types";
import { deleteVectors } from "./vector-index";

/**
 * Knowledge files: company profiles, handbooks, product docs, a bot's instructions. Text is kept
 * in IndexedDB (not in the app state, which is saved often) and handed to the model either whole,
 * when small, or as the few passages most relevant to the question.
 */
const docs = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-knowledge", "docs");
const cache = new Map<string, string>();

/** Below this, every file is included in full (~6k tokens); above it, only relevant passages. */
export const FULL_TEXT_LIMIT = 24_000;
const CHUNK = 1200;
const TOP_CHUNKS = 6;

export async function addKnowledgeFile(file: File): Promise<KnowledgeRef> {
  const { fileText } = await import("./images");
  const text = (await fileText(file)).replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) throw new Error(`${file.name}: no readable text found (scanned PDFs need OCR first).`);
  return saveKnowledgeText(file.name, text, file.size);
}

export async function saveKnowledgeText(name: string, text: string, size = text.length): Promise<KnowledgeRef> {
  const ref: KnowledgeRef = { id: crypto.randomUUID(), name, size, chars: text.length, addedAt: Date.now() };
  cache.set(ref.id, text);
  if (docs) await set(ref.id, text, docs);
  return ref;
}

export async function removeKnowledgeText(id: string) {
  cache.delete(id);
  if (docs) await del(id, docs);
  await deleteVectors(knowledgeSource(id)).catch(() => undefined);
}

/** A knowledge file's full text ("" if it's gone). */
export async function loadText(id: string): Promise<string> {
  if (!cache.has(id)) cache.set(id, (docs ? await get<string>(id, docs) : undefined) ?? "");
  return cache.get(id)!;
}

/** Where a file's passages live in the vector index (smarter search). */
export const knowledgeSource = (id: string) => `file:${id}`;

/** A file's passages, as ranked and as indexed for smarter search. */
export async function knowledgeChunks(id: string): Promise<string[]> {
  const text = await loadText(id);
  return text ? chunk(text) : [];
}

export type KnowledgeContext = { prompt: string; used: string[]; outside?: boolean };

/** Builds the knowledge section of the system prompt for a question. */
export async function knowledgeContext(refs: KnowledgeRef[], query: string): Promise<KnowledgeContext> {
  if (!refs.length) return { prompt: "", used: [] };
  const texts = await Promise.all(refs.map(async (ref) => ({ ref, text: await loadText(ref.id) })));
  const available = texts.filter((t) => t.text);
  if (!available.length) return { prompt: "", used: [] };
  const total = available.reduce((n, t) => n + t.text.length, 0);

  if (total <= FULL_TEXT_LIMIT) {
    return asOutside(
      {
        prompt: wrap(available.map((t) => `<document name="${t.ref.name}">\n${t.text}\n</document>`).join("\n\n")),
        used: available.map((t) => t.ref.name),
      },
      available.some((t) => t.ref.outside),
    );
  }

  const chunks = available.flatMap((t) => chunk(t.text).map((text, i) => ({ name: t.ref.name, index: i, text, source: knowledgeSource(t.ref.id) })));
  // Keywords (BM25), plus meaning when smarter search is on.
  const ranked = (await hybridRank(chunks, query, rank(chunks, query))).items.slice(0, TOP_CHUNKS);
  if (!ranked.length) return { prompt: "", used: [] };
  ranked.sort((a, b) => (a.name === b.name ? a.index - b.index : a.name.localeCompare(b.name)));
  const used = [...new Set(ranked.map((c) => c.name))];
  return asOutside(
    {
      prompt: wrap(
        ranked.map((c) => `<excerpt document="${c.name}" part="${c.index + 1}">\n${c.text}\n</excerpt>`).join("\n\n"),
        true,
      ),
      used,
    },
    available.some((t) => t.ref.outside && used.includes(t.ref.name)),
  );
}

/** Files that came with a template from someone else are outside content: wrapped, and the turn marked. */
function asOutside(context: KnowledgeContext, outside: boolean): KnowledgeContext {
  return outside ? { ...context, prompt: markUntrusted(context.prompt, "knowledge files that came with a bot template"), outside: true } : context;
}

function wrap(body: string, excerpts = false): string {
  return (
    `Reference knowledge from files the user provided${excerpts ? " (the passages most relevant to this question)" : ""}:\n\n${body}\n\n` +
    "Use this knowledge when it's relevant, and prefer it over general knowledge for anything about the user, their " +
    "organisation or their products. If it doesn't cover the question, say so rather than guessing."
  );
}

/** Splits text into overlapping passages at paragraph or sentence boundaries. */
export function chunk(text: string, size = CHUNK): string[] {
  const paragraphs = text.split(/\n{2,}/).flatMap((p) => (p.length > size ? (p.match(new RegExp(`[^.!?\\n]{1,${size}}[.!?]?\\s*`, "g")) ?? [p]) : [p]));
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > size) {
      chunks.push(current.trim());
      // Carry the last sentence over so answers spanning a boundary still match.
      current = `${current.slice(-200).replace(/^\S*\s/, "")}\n\n`;
    }
    current += `${paragraph}\n\n`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so that the their them there these they this to us was we were what when where which who why will with would you your about tell explain please".split(
    " ",
  ),
);

/** Chinese and Japanese are written without spaces. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function tokenize(text: string): string[] {
  const words =
    text
      .toLowerCase()
      .normalize("NFKD")
      // Accents off Latin, Greek and Cyrillic letters, so "clinica" finds "clínica". Other marks are
      // part of the letter (Hindi and Bengali vowel signs): they stay inside the word.
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const w of words) {
    if (CJK.test(w)) {
      // No spaces to split on: match pairs of characters ("在宅勤務" → 在宅, 宅勤, 勤務).
      if (w.length < 3) tokens.push(w);
      else for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    } else if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
  }
  return tokens;
}

/** Greetings and fillers (as tokenize leaves them): they don't make a message about anything. */
const SMALL_TALK = new Set(
  "hello hey hiya hii thank thanks thx okay yes yeah yep nope sure cool great good nice fine morn even night afternoon bye goodbye sup whats wassup lol hmm haha".split(" "),
);

/**
 * The words of a message that say what it's about: no greetings, fillers or tiny words. Empty for
 * "Hello, what's up?", so small talk doesn't recall old notes or memories by a shared "up".
 */
export function subjectWords(text: string): string {
  return (text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((w) => tokenize(w).some((t) => (t.length >= 3 || CJK.test(t)) && !SMALL_TALK.has(t))).join(" ");
}

/** BM25 ranking of passages against the question. */
export function rank<T extends { text: string }>(chunks: T[], query: string): T[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return chunks.slice(0, TOP_CHUNKS);
  const docsTokens = chunks.map((c) => tokenize(c.text));
  const avg = docsTokens.reduce((n, d) => n + d.length, 0) / Math.max(1, docsTokens.length);
  const df = new Map<string, number>();
  for (const tokens of docsTokens) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  const scored = chunks.map((c, i) => {
    const tokens = docsTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (chunks.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * tokens.length) / avg));
    }
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .map((s) => s.c);
}

/** Erase all data: the text of every knowledge file goes too. */
export async function clearKnowledgeDocs() {
  if (docs) await clear(docs);
}
