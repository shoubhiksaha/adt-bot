// Whisper speech-to-text, on its own thread pool. Started by the speech worker, which keeps the
// voice detector real-time in the meantime. Model files are cached in IndexedDB, so after the
// first download it works offline and audio never leaves the device.
import { env, pipeline } from "@huggingface/transformers";
import { createStore, get, keys, set } from "idb-keyval";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

// transformers.js points ONNX Runtime at a CDN by default; use the copies bundled with the app so
// speech recognition works offline and nothing is fetched from third parties.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

const files = createStore("adtbot-models", "files");

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(url: string) {
    const hit = await get<{ body: ArrayBuffer; type: string }>(url, files);
    return hit
      ? new Response(hit.body, {
          headers: {
            "content-type": hit.type,
            "content-length": String(hit.body.byteLength),
          },
        })
      : undefined;
  },
  async put(url: string, response: Response) {
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    await set(url, { body: await response.arrayBuffer(), type }, files);
  },
};

const post = (message: Record<string, unknown>) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

// One run at a time: ONNX Runtime sessions shouldn't run concurrently.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

type Transcriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>) & {
  dispose?: () => Promise<void>;
};
let whisper: {
  size: string;
  ready: Promise<Transcriber>;
  gpu: boolean;
} | null = null;

/** The GPU, when this device has one WebGPU can use (with 16-bit floats). */
const gpuAvailable: Promise<boolean> = (async () => {
  try {
    const gpu = (
      navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> };
      }
    ).gpu;
    const adapter = await gpu?.requestAdapter();
    return Boolean(adapter?.features.has("shader-f16"));
  } catch {
    return false;
  }
})();
let gpuFailed = false;

const warmUp = (t: Transcriber) => t(new Float32Array(16000), { language: "en" });

/** Whether the GPU encoder (full-precision `encoder_model.onnx`) for this size has been downloaded before. */
async function gpuCached(size: string): Promise<boolean> {
  if (gpuFailed || !(await gpuAvailable)) return false;
  const stored = (await keys(files)) as string[];
  return stored.some((k) => k.includes(`whisper-${size}/`) && k.endsWith("encoder_model.onnx"));
}

const GPU_OPTIONS = {
  dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
  device: { encoder_model: "webgpu", decoder_model_merged: "wasm" },
};

function loadWhisper(size: string): Promise<Transcriber> {
  if (whisper?.size !== size) {
    // Straight to the GPU when its encoder is already here; otherwise the CPU version first.
    const ready = gpuCached(size).then((cached) => (cached ? loadGpu(size) : loadCpu(size)));
    whisper = { size, ready, gpu: false };
    ready.catch(() => (whisper = null));
  }
  return whisper.ready;
}

async function loadGpu(size: string): Promise<Transcriber> {
  try {
    const t = (await pipeline("automatic-speech-recognition", `onnx-community/whisper-${size}`, GPU_OPTIONS as never)) as unknown as Transcriber;
    await warmUp(t);
    post({ type: "progress", progress: 100 });
    post({ type: "whisper-ready" });
    post({ type: "whisper-gpu" });
    return t;
  } catch {
    gpuFailed = true;
    return loadCpu(size);
  }
}

function loadCpu(size: string): Promise<Transcriber> {
  return pipeline("automatic-speech-recognition", `onnx-community/whisper-${size}`, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (info: { status: string; progress?: number; loaded?: number; total?: number }) => {
      if (info.status === "progress_total") post({ type: "progress", progress: info.progress, loaded: info.loaded, total: info.total });
    },
  }).then(async (t) => {
    const transcriber = t as unknown as Transcriber;
    // Warm-up run so the first real question isn't slowed by kernel compilation.
    await warmUp(transcriber);
    post({ type: "progress", progress: 100 });
    post({ type: "whisper-ready" });
    void upgradeToGpu(size);
    return transcriber;
  }) as Promise<Transcriber>;
}

/**
 * Moves Whisper's encoder (the heavy half: it always reads a 30 s window) to the GPU: 2–3× faster
 * on an M1 and it leaves the CPU free. Its weights (82 MB for base) download in the background
 * while the CPU version keeps working; the small decoder stays on the CPU, already downloaded.
 * Full precision: on an M1 it ran faster than the 16-bit version.
 */
async function upgradeToGpu(size: string) {
  if (gpuFailed || !(await gpuAvailable)) return;
  try {
    const t = (await pipeline("automatic-speech-recognition", `onnx-community/whisper-${size}`, GPU_OPTIONS as never)) as unknown as Transcriber;
    await serial(() => warmUp(t));
    const current = whisper;
    if (current?.size !== size) return void t.dispose?.();
    const old = current.ready;
    whisper = { size, ready: Promise.resolve(t), gpu: true };
    // Free the CPU copy once anything already queued on it has run.
    void serial(async () => (await old).dispose?.()).catch(() => undefined);
    post({ type: "whisper-gpu" });
  } catch {
    gpuFailed = true;
  }
}

async function transcribe(audio: Float32Array, size: string, language: string): Promise<string> {
  const transcriber = await loadWhisper(size);
  return serial(async () => {
    const output = await transcriber(audio, {
      language,
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (Array.isArray(output) ? output.map((o) => o.text).join(" ") : output.text).trim();
    // Whisper "hears" these in silence or noise.
    return /^(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching!?|\.+)$/i.test(text) ? "" : text;
  });
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  try {
    if (data.type === "load") {
      await loadWhisper(data.size);
      post({ id: data.id, type: "done", text: "" });
    } else if (data.type === "transcribe") {
      post({
        id: data.id,
        type: "done",
        text: await transcribe(data.audio, data.size, data.language),
      });
    }
  } catch (error) {
    post({
      id: data.id,
      type: "error",
      message: (error as Error).message ?? String(error),
    });
  }
};
