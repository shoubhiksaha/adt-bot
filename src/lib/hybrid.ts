/**
 * Hybrid retrieval: keyword (BM25) ranking fused with vector similarity by reciprocal rank fusion.
 * Used for knowledge passages and memories. When smarter search is off, or its model isn't on this
 * device, or it fails, the keyword ranking is used unchanged.
 */

/** A source's texts: a knowledge file's passages, or one bot's memories. */
export type SourceTexts = { source: string; texts: string[] };

export type Semantic = {
  /**
   * Similarity of the question to each text of each source, in the same shape as `groups`. Texts
   * that aren't indexed yet score NaN (keyword search still covers them).
   */
  scores(query: string, groups: SourceTexts[]): Promise<Float32Array[]>;
  /** How far below the best score a text still counts as a semantic match. */
  window: number;
};

let active: Semantic | null = null;

/** Set by semantic.ts while smarter search is on and its model is downloaded. */
export function setSemantic(semantic: Semantic | null) {
  active = semantic;
}

export function getSemantic(): Semantic | null {
  return active;
}

/**
 * Weighted reciprocal rank fusion. `k` and the keyword weight were picked on a 56-question test set
 * (paraphrases, exact names, 8 languages): the usual k = 60 with equal weights let any passage
 * sharing a word with the question ("sister company" for "my sister's name") jump ahead of the
 * model's best match (top-1 accuracy 0.71 → 0.60). With k = 1 and keywords at half weight, the
 * model's best match stays first unless a nearly-as-good one also has the words, and an exact
 * keyword match still lands in the top three (exact-name queries: top-3 0.93 → 1.0).
 */
export const FUSION = { k: 1, keywordWeight: 0.5, depth: 20 };

/** Fuses rankings (best first) of item ids; items in neither list are left out. */
export function fuse<T>(vector: T[], keyword: T[], options = FUSION): T[] {
  const scores = new Map<T, number>();
  const add = (list: T[], weight: number) =>
    list.slice(0, options.depth).forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + weight / (options.k + rank + 1)));
  add(vector, 1);
  add(keyword, options.keywordWeight);
  // Stable: ties keep the vector order, then the keyword order.
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Questions wait at most this long for the model (it may have to load first); then keywords only. */
const SEMANTIC_TIMEOUT_MS = 4000;

export type Ranked<T> = { items: T[]; semantic: boolean };

/**
 * Ranks `items` for `query`: the keyword ranking (`keyword`, best first, matches only) fused with
 * vector similarity when smarter search is available. `source` and `text` say where each item's
 * vector lives.
 */
export async function hybridRank<T extends { source: string; text: string }>(items: T[], query: string, keyword: T[]): Promise<Ranked<T>> {
  const semantic = active;
  if (!semantic || !items.length || !query.trim()) return { items: keyword, semantic: false };
  const groups = new Map<string, { texts: string[]; items: T[] }>();
  for (const item of items) {
    const group = groups.get(item.source) ?? { texts: [], items: [] };
    group.texts.push(item.text);
    group.items.push(item);
    groups.set(item.source, group);
  }
  const list = [...groups.entries()];
  let scores: Float32Array[];
  try {
    scores = await withTimeout(
      semantic.scores(
        query,
        list.map(([source, g]) => ({ source, texts: g.texts })),
      ),
      SEMANTIC_TIMEOUT_MS,
    );
  } catch {
    return { items: keyword, semantic: false };
  }
  const scored: { item: T; score: number }[] = [];
  list.forEach(([, g], gi) => g.items.forEach((item, i) => Number.isFinite(scores[gi][i]) && scored.push({ item, score: scores[gi][i] })));
  if (!scored.length) return { items: keyword, semantic: false };
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  const vector = scored.filter((s) => s.score >= best - semantic.window).map((s) => s.item);
  return { items: fuse(vector, keyword), semantic: true };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
