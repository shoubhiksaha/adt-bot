import { createStore, del, keys } from "idb-keyval";
import { EMBEDDING_MODEL } from "./embedding-model";
import type { Embedder } from "./vector-index";

/**
 * The embedding worker (embed.worker.ts), seen from the app: download with progress, and turning
 * texts into vectors. The worker starts when needed and stops after a few idle minutes to free
 * memory. Questions jump ahead of background indexing, so a reply never waits behind a big file.
 */
type Job = {
  texts: string[];
  kind: "query" | "passage";
  urgent: boolean;
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
};

const IDLE_MS = 5 * 60_000;

let worker: Worker | null = null;
let nextId = 0;
let loading: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const calls = new Map<number, { resolve: (data: { vectors?: Float32Array }) => void; reject: (error: Error) => void }>();
const progressListeners = new Set<(percent: number | null) => void>();

function getWorker(): Worker {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  const w = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === "progress") {
      const done = (data.progress ?? 0) >= 100;
      progressListeners.forEach((l) => l(done ? null : Math.round(data.progress ?? 0)));
      return;
    }
    const call = calls.get(data.id);
    if (!call) return;
    calls.delete(data.id);
    if (data.type === "error") call.reject(new Error(data.message || "Smarter memory search failed"));
    else call.resolve(data);
    if (!calls.size && !pending.length) releaseLater();
  };
  w.onerror = (event) => {
    const error = new Error(event.message || "Smarter memory search crashed");
    for (const call of calls.values()) call.reject(error);
    calls.clear();
    w.terminate();
    if (worker === w) {
      worker = null;
      loading = null;
    }
  };
  worker = w;
  return w;
}

function releaseLater() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (calls.size || pending.length || running) return;
    worker?.terminate();
    worker = null;
    loading = null;
  }, IDLE_MS);
}

function call(message: Record<string, unknown>): Promise<{ vectors?: Float32Array }> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    getWorker().postMessage({ ...message, id });
  });
}

/** Loads the model (downloading it only when `allowDownload`) and warms it up. */
function load(allowDownload = false): Promise<void> {
  loading ??= call({ type: "load", allowDownload }).then(
    () => undefined,
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Download progress (null when idle or done). */
export function onEmbeddingProgress(listener: (percent: number | null) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** Downloads the model (once; then it's cached on this device) and loads it. */
export function downloadEmbeddingModel(): Promise<void> {
  return load(true);
}

/** Loads an already downloaded model ahead of a question (it takes a few seconds from storage). */
export function warmEmbeddings() {
  void load().catch(() => undefined);
}

const modelFiles = () => createStore("adtbot-models", "files");
const isModelFile = (key: string) => key.includes(`/${EMBEDDING_MODEL.repo}/`);

export async function embeddingModelDownloaded(): Promise<boolean> {
  try {
    const stored = (await keys(modelFiles())) as string[];
    return stored.some((k) => isModelFile(k) && k.includes(EMBEDDING_MODEL.revision) && k.endsWith(EMBEDDING_MODEL.weights));
  } catch {
    return false;
  }
}

/** Frees the space the model takes (any revision). */
export async function deleteEmbeddingModel(): Promise<void> {
  worker?.terminate();
  worker = null;
  loading = null;
  const store = modelFiles();
  const stored = (await keys(store)) as string[];
  await Promise.all(stored.filter(isModelFile).map((k) => del(k, store)));
}

// Questions and new memories first, then background indexing; one request in the worker at a time.
const pending: Job[] = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  try {
    while (pending.length) {
      const job = pending.shift()!;
      try {
        await load();
        const { vectors } = await call({ type: "embed", texts: job.texts, kind: job.kind });
        const dims = EMBEDDING_MODEL.dims;
        job.resolve(job.texts.map((_, i) => vectors!.slice(i * dims, (i + 1) * dims)));
      } catch (error) {
        job.reject(error as Error);
      }
    }
  } finally {
    running = false;
    if (!calls.size) releaseLater();
  }
}

/** The app's embedder: the worker above. */
export const workerEmbedder: Embedder = {
  model: EMBEDDING_MODEL.id,
  dims: EMBEDDING_MODEL.dims,
  embed(texts, kind, urgent = kind === "query") {
    if (!texts.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const job: Job = { texts, kind, urgent, resolve, reject };
      if (urgent) {
        const firstBackground = pending.findIndex((j) => !j.urgent);
        pending.splice(firstBackground < 0 ? pending.length : firstBackground, 0, job);
      } else pending.push(job);
      void pump();
    });
  },
};
