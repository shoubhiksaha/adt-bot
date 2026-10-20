import { deleteEmbeddingModel, downloadEmbeddingModel, embeddingModelDownloaded, warmEmbeddings, workerEmbedder } from "./embeddings";
import { EMBEDDING_MODEL } from "./embedding-model";
import { type Semantic, type SourceTexts, setSemantic } from "./hybrid";
import { knowledgeChunks, knowledgeSource } from "./knowledge";
import type { Bot, KnowledgeRef } from "./types";
import { memorySource } from "./memory-recall";
import { updateSettings, useStore } from "./store";
import { type Embedder, idbVectorStore, VectorIndex } from "./vector-index";

/**
 * "Smarter memory search" (Settings → Workspace): keeps the vector index of every bot's memories
 * and every knowledge file up to date in the background, and answers similarity questions for
 * hybrid ranking. Off, or before the model is downloaded, nothing here runs and search is keyword
 * only, exactly as before.
 */

/** A question embeds this many unindexed texts itself (a few new memories); more wait for the background pass. */
const INLINE_LIMIT = 16;

/** `onBacklog`: sources with more unindexed text than a question should wait for. */
export function createSemantic(index: VectorIndex, embedder: Embedder, onBacklog: (sources: string[]) => void): Semantic {
  return {
    window: EMBEDDING_MODEL.window,
    async scores(query: string, groups: SourceTexts[]) {
      const [vector] = await embedder.embed([query], "query");
      const missing = await Promise.all(groups.map((g) => index.missing(g.source, g.texts)));
      let budget = INLINE_LIMIT;
      const now = missing.map((n) => n > 0 && n <= budget && (budget -= n) >= 0);
      const backlog = groups.filter((_, i) => missing[i] && !now[i]).map((g) => g.source);
      if (backlog.length) onBacklog(backlog);
      await Promise.all(groups.map((g, i) => (now[i] ? index.add(g.source, g.texts, { urgent: true }) : 0)));
      return Promise.all(groups.map((g) => index.scores(g.source, g.texts, vector)));
    },
  };
}

export type IndexStatus = { done: number; total: number } | null;

let index: VectorIndex | null = null;
const getIndex = () => (index ??= new VectorIndex(idbVectorStore, workerEmbedder));

let enabled = false;
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> | null = null;
let stopSync = new AbortController();
let again = false;
/** Files fully indexed this session: a file's text never changes, so they needn't be read again. */
const complete = new Set<string>();
const statusListeners = new Set<(status: IndexStatus) => void>();
let status: IndexStatus = null;

function setStatus(next: IndexStatus) {
  status = next;
  statusListeners.forEach((l) => l(next));
}

/** Background indexing progress, for the setting (null when idle). */
export function onIndexStatus(listener: (status: IndexStatus) => void): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

/** Runs a background pass soon (changes come in bursts: wait for them to settle). */
function scheduleSync(delay = 3000) {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (syncing) {
      again = true;
      return;
    }
    stopSync = new AbortController();
    syncing = sync(stopSync.signal)
      .catch(() => undefined)
      .finally(() => {
        syncing = null;
        setStatus(null);
        if (again) {
          again = false;
          scheduleSync();
        }
      });
  }, delay);
}

/** What the index should hold: every bot's memories and every knowledge file (texts load on demand). */
export function indexSources(bots: Pick<Bot, "id" | "memory" | "knowledge">[], shared: KnowledgeRef[]): Map<string, () => Promise<string[]>> {
  const sources = new Map<string, () => Promise<string[]>>();
  for (const bot of bots) sources.set(memorySource(bot.id), async () => bot.memory);
  for (const ref of [...shared, ...bots.flatMap((b) => b.knowledge ?? [])]) sources.set(knowledgeSource(ref.id), () => knowledgeChunks(ref.id));
  return sources;
}

/**
 * One background pass: drops the vectors of what's gone (deleted bots and files, forgotten
 * memories), then embeds only what's new. `complete` lists files already fully indexed (a file's
 * text never changes, so they aren't read again); finished files are added to it.
 */
export async function syncIndex(
  vectors: VectorIndex,
  sources: Map<string, () => Promise<string[]>>,
  options: { signal?: AbortSignal; complete?: Set<string>; onStatus?: (status: IndexStatus) => void } = {},
): Promise<void> {
  const { signal, complete = new Set<string>(), onStatus } = options;
  await vectors.prune((source) => sources.has(source));
  const work: { source: string; texts: string[]; count: number }[] = [];
  for (const [source, load] of sources) {
    if (complete.has(source)) continue;
    const texts = await load();
    if (source.startsWith("memory:")) await vectors.retain(source, texts);
    const count = await vectors.missing(source, texts);
    if (count) work.push({ source, texts, count });
    else if (source.startsWith("file:")) complete.add(source);
  }
  // Memories first: they're small and every chat uses them.
  work.sort((a, b) => Number(b.source.startsWith("memory:")) - Number(a.source.startsWith("memory:")));
  const total = work.reduce((n, w) => n + w.count, 0);
  let done = 0;
  for (const w of work) {
    if (signal?.aborted) return;
    onStatus?.({ done, total });
    const added = await vectors.add(w.source, w.texts, { signal, onProgress: (n) => onStatus?.({ done: done + n, total }) });
    done += added;
    if (added === w.count && w.source.startsWith("file:")) complete.add(w.source);
  }
}

function sync(signal: AbortSignal) {
  const { bots, settings } = useStore.getState();
  return syncIndex(getIndex(), indexSources(bots, settings.knowledge), { signal, complete, onStatus: setStatus });
}

async function apply() {
  enabled = useStore.getState().settings.semanticSearch && (await embeddingModelDownloaded());
  const backlog = (sources: string[]) => {
    sources.forEach((source) => complete.delete(source));
    scheduleSync();
  };
  setSemantic(enabled ? createSemantic(getIndex(), workerEmbedder, backlog) : null);
  scheduleSync(1000);
}

/** Starts watching the setting, memories and files. Called once, after the saved state has loaded. */
export function startSemanticSearch() {
  if (started) return;
  started = true;
  useStore.subscribe((state, previous) => {
    if (state.settings.semanticSearch !== previous.settings.semanticSearch) void apply();
    else if (state.bots !== previous.bots || state.settings.knowledge !== previous.settings.knowledge) scheduleSync();
  });
  void apply();
}

/** The message box got focus: load the model now, so the question doesn't wait for it. */
export function warmSemanticSearch() {
  if (enabled) warmEmbeddings();
}

/** Turns smarter search on: downloads the model the first time (progress: onEmbeddingProgress), then indexes. */
export async function enableSemanticSearch() {
  updateSettings({ semanticSearch: true });
  await downloadEmbeddingModel();
  await apply();
}

/** Turns it off and deletes the index (it holds what your memories and files say, in another form). */
export async function disableSemanticSearch() {
  updateSettings({ semanticSearch: false });
  enabled = false;
  setSemantic(null);
  if (timer) clearTimeout(timer);
  stopSync.abort();
  await syncing;
  await clearVectorIndex();
}

/** Off, plus the downloaded model removed. */
export async function removeSemanticSearch() {
  await disableSemanticSearch();
  await deleteEmbeddingModel();
}

/** Deletes every stored vector (also used by "Erase all data"). */
export function clearVectorIndex(): Promise<void> {
  complete.clear();
  return getIndex().clear();
}

export { embeddingModelDownloaded, onEmbeddingProgress } from "./embeddings";
