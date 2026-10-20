import { clear, createStore, del, get, keys, set } from "idb-keyval";

/**
 * On-device vector index for "Smarter memory search". One record per source (a knowledge file, or
 * one bot's memories) holds the vectors of that source's passages, keyed by a hash of each
 * passage's text, so only new or changed text is ever embedded again.
 *
 * Search is brute-force cosine over the records in memory. In Chromium on an M1: 50,000 passages
 * (77 MB) load from IndexedDB in ~60 ms and are scored in ~19 ms; 100,000 in ~160 ms and ~37 ms.
 * Personal knowledge stays far below that, so nothing fancier (sqlite-vec, an ANN index) is needed,
 * and it works the same on desktop, web and mobile.
 */

export type Embedder = {
  /** Stored with the vectors: another model's vectors are never compared with this one's. */
  model: string;
  dims: number;
  /**
   * Unit-length vectors, one per text. Questions and passages may be embedded differently. Urgent
   * work (a question, a new memory) goes ahead of background indexing.
   */
  embed(texts: string[], kind: "query" | "passage", urgent?: boolean): Promise<Float32Array[]>;
};

export type SourceRecord = {
  model: string;
  dims: number;
  /** Hash of each embedded text; row i of `vectors` belongs to hashes[i]. */
  hashes: string[];
  vectors: Float32Array;
};

export type VectorStore = {
  get(source: string): Promise<SourceRecord | undefined>;
  put(source: string, record: SourceRecord): Promise<void>;
  delete(source: string): Promise<void>;
  sources(): Promise<string[]>;
  clear(): Promise<void>;
};

const idb = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-vectors", "sources");

/** The app's store (IndexedDB). Without IndexedDB, it's empty and keeps nothing. */
export const idbVectorStore: VectorStore = {
  get: async (source) => (idb ? get<SourceRecord>(source, idb) : undefined),
  put: async (source, record) => (idb ? set(source, record, idb) : undefined),
  delete: async (source) => (idb ? del(source, idb) : undefined),
  sources: async () => (idb ? ((await keys(idb)) as string[]) : []),
  clear: async () => (idb ? clear(idb) : undefined),
};

/** A store that lives only in memory (tests). */
export function memoryVectorStore(): VectorStore & { records: Map<string, SourceRecord> } {
  const records = new Map<string, SourceRecord>();
  return {
    records,
    get: async (source) => records.get(source),
    put: async (source, record) => void records.set(source, record),
    delete: async (source) => void records.delete(source),
    sources: async () => [...records.keys()],
    clear: async () => records.clear(),
  };
}

/** A 53-bit hash of a passage's text (cyrb53, public domain): plenty to tell passages apart. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

type Entry = { record: SourceRecord; rows: Map<string, number> };

/** Texts embedded per worker request: small enough that a question never waits long behind one. */
const BATCH = 8;
/** Save progress this often while indexing a big file, so a restart doesn't redo it. */
const SAVE_EVERY = 64;

export type IndexProgress = (done: number) => void;

export class VectorIndex {
  private readonly cache = new Map<string, Promise<Entry>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: VectorStore,
    readonly embedder: Embedder,
  ) {}

  private empty(): SourceRecord {
    return { model: this.embedder.model, dims: this.embedder.dims, hashes: [], vectors: new Float32Array(0) };
  }

  /** The source's record, read once (a question and the background pass share the same copy). */
  private entry(source: string): Promise<Entry> {
    let entry = this.cache.get(source);
    if (!entry) {
      entry = this.store.get(source).then((stored) => {
        // Vectors from another model (or an old revision) can't be compared: start over.
        const record = stored && stored.model === this.embedder.model && stored.dims === this.embedder.dims ? stored : this.empty();
        return { record, rows: new Map(record.hashes.map((h, i) => [h, i])) };
      });
      this.cache.set(source, entry);
      entry.catch(() => this.cache.get(source) === entry && this.cache.delete(source));
    }
    return entry;
  }

  /** One change at a time per source, so background indexing and a question never race. */
  private locked<T>(source: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(source) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(source, tail);
    void tail.then(() => this.locks.get(source) === tail && this.locks.delete(source));
    return run;
  }

  /** How many of `texts` still need embedding. */
  async missing(source: string, texts: string[]): Promise<number> {
    const { rows } = await this.entry(source);
    return new Set(texts.map(textHash).filter((h) => !rows.has(h))).size;
  }

  /**
   * Embeds the texts that aren't indexed yet (only those) and saves them. Already indexed texts
   * that aren't in `texts` are kept; `retain` drops them.
   */
  add(source: string, texts: string[], options: { signal?: AbortSignal; onProgress?: IndexProgress; urgent?: boolean } = {}): Promise<number> {
    return this.locked(source, async () => {
      const entry = await this.entry(source);
      const todo = new Map<string, string>();
      for (const text of texts) {
        const hash = textHash(text);
        if (!entry.rows.has(hash)) todo.set(hash, text);
      }
      const list = [...todo.entries()];
      let unsaved = 0;
      let done = 0;
      try {
        for (let i = 0; i < list.length; i += BATCH) {
          if (options.signal?.aborted) break;
          const batch = list.slice(i, i + BATCH);
          const vectors = await this.embedder.embed(
            batch.map(([, text]) => text),
            "passage",
            options.urgent,
          );
          this.append(
            entry,
            batch.map(([hash]) => hash),
            vectors,
          );
          done += batch.length;
          unsaved += batch.length;
          options.onProgress?.(done);
          if (unsaved >= SAVE_EVERY) {
            unsaved = 0;
            await this.store.put(source, entry.record);
          }
        }
      } finally {
        if (unsaved) await this.store.put(source, entry.record);
      }
      return done;
    });
  }

  private append(entry: Entry, hashes: string[], vectors: Float32Array[]) {
    const { record } = entry;
    const dims = record.dims;
    const next = new Float32Array(record.vectors.length + hashes.length * dims);
    next.set(record.vectors);
    hashes.forEach((hash, i) => {
      next.set(vectors[i].subarray(0, dims), (record.hashes.length + i) * dims);
      entry.rows.set(hash, record.hashes.length + i);
    });
    record.hashes = [...record.hashes, ...hashes];
    record.vectors = next;
  }

  /** Drops vectors of texts no longer in the source (a forgotten memory); never embeds anything. */
  retain(source: string, texts: string[]): Promise<number> {
    return this.locked(source, async () => {
      const entry = await this.entry(source);
      const keep = new Set(texts.map(textHash));
      const kept = entry.record.hashes.map((h, i) => [h, i] as const).filter(([h]) => keep.has(h));
      const removed = entry.record.hashes.length - kept.length;
      if (!removed) return 0;
      if (!kept.length) {
        entry.record = this.empty();
        entry.rows = new Map();
        await this.store.delete(source);
        return removed;
      }
      const dims = entry.record.dims;
      const vectors = new Float32Array(kept.length * dims);
      kept.forEach(([, row], i) => vectors.set(entry.record.vectors.subarray(row * dims, (row + 1) * dims), i * dims));
      entry.record = { ...entry.record, hashes: kept.map(([h]) => h), vectors };
      entry.rows = new Map(entry.record.hashes.map((h, i) => [h, i]));
      await this.store.put(source, entry.record);
      return removed;
    });
  }

  /** Cosine similarity of the (unit) question vector to each text; NaN for texts not indexed yet. */
  async scores(source: string, texts: string[], query: Float32Array): Promise<Float32Array> {
    const { record, rows } = await this.entry(source);
    const dims = record.dims;
    const out = new Float32Array(texts.length).fill(Number.NaN);
    texts.forEach((text, i) => {
      const row = rows.get(textHash(text));
      if (row === undefined) return;
      const v = record.vectors;
      const offset = row * dims;
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += v[offset + d] * query[d];
      out[i] = dot;
    });
    return out;
  }

  /** Deletes the vectors of sources that no longer exist (a removed file, a deleted bot). */
  async prune(keep: (source: string) => boolean): Promise<string[]> {
    const gone = (await this.store.sources()).filter((source) => !keep(source));
    for (const source of gone) {
      await this.locked(source, async () => {
        this.cache.delete(source);
        await this.store.delete(source);
      });
    }
    return gone;
  }

  async clear() {
    this.cache.clear();
    await this.store.clear();
  }
}

/** Removes one source's vectors from the app's store (e.g. a knowledge file being removed). */
export function deleteVectors(source: string): Promise<void> {
  return idbVectorStore.delete(source);
}
