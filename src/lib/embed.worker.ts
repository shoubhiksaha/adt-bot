// Text embeddings for "Smarter memory search", on their own thread. Model files are cached in
// IndexedDB like the speech models', so after the one download it works offline and no text
// leaves the device.
import { env, pipeline } from "@huggingface/transformers";
import { createStore, get, set } from "idb-keyval";
import { EMBED_MAX_CHARS, EMBEDDING_MODEL } from "./embedding-model";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

// Use the copies of ONNX Runtime bundled with the app, so nothing is fetched from a CDN.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
  // Indexing runs in the background: leave most cores to the chat, speech and the screen.
  env.backends.onnx.wasm.numThreads = 2;
}

const files = createStore("adtbot-models", "files");

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(url: string) {
    const hit = await get<{ body: ArrayBuffer; type: string }>(url, files);
    return hit ? new Response(hit.body, { headers: { "content-type": hit.type, "content-length": String(hit.body.byteLength) } }) : undefined;
  },
  async put(url: string, response: Response) {
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    await set(url, { body: await response.arrayBuffer(), type }, files);
  },
};

const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

type Output = { data: Float32Array; dims: number[] };
type Extractor = (texts: string[], options: Record<string, unknown>) => Promise<Output>;

let ready: Promise<Extractor> | null = null;

let lastPercent = -1;
function progress(info: { status: string; progress?: number }) {
  if (info.status !== "progress_total") return;
  // Thousands of updates per download: pass on whole-percent steps only.
  const percent = Math.floor(info.progress ?? 0);
  if (percent === lastPercent) return;
  lastPercent = percent;
  post({ type: "progress", progress: percent });
}

/**
 * Small model, short inputs: on an M1 the CPU (WebAssembly) was faster than WebGPU in our tests
 * (33 vs 78 ms a memory, 16 vs 92 ms a question), and it leaves the GPU to Whisper and the voices.
 */
function load(allowDownload: boolean): Promise<Extractor> {
  ready ??= (async () => {
    // Only the setting's own download button may fetch the model; everything else uses the cache.
    env.allowRemoteModels = allowDownload;
    const extractor = (await pipeline("feature-extraction", EMBEDDING_MODEL.repo, {
      revision: EMBEDDING_MODEL.revision,
      dtype: EMBEDDING_MODEL.dtype,
      device: "wasm",
      progress_callback: progress,
    } as never)) as unknown as Extractor;
    // Warm-up run, so the first real question isn't slowed by kernel setup.
    await extractor(["hello"], { pooling: EMBEDDING_MODEL.pooling, normalize: true });
    post({ type: "progress", progress: 100 });
    return extractor;
  })();
  ready.catch(() => (ready = null));
  return ready;
}

// One run at a time: ONNX Runtime sessions shouldn't run concurrently.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array> {
  const extractor = await load(false);
  const prefix = EMBEDDING_MODEL.prefix[kind];
  return serial(async () => {
    const output = await extractor(
      texts.map((t) => prefix + t.slice(0, EMBED_MAX_CHARS)),
      { pooling: EMBEDDING_MODEL.pooling, normalize: true },
    );
    return output.data;
  });
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  try {
    if (data.type === "load") {
      await load(Boolean(data.allowDownload));
      post({ id: data.id, type: "done" });
    } else if (data.type === "embed") {
      const vectors = await embed(data.texts, data.kind);
      // A copy that owns its buffer, so it can be transferred instead of cloned.
      const out = new Float32Array(vectors);
      post({ id: data.id, type: "vectors", vectors: out }, [out.buffer]);
    }
  } catch (error) {
    post({ id: data.id, type: "error", message: (error as Error).message ?? String(error) });
  }
};
