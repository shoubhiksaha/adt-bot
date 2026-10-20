// Smart Turn v3 (pipecat-ai/smart-turn, BSD-2-Clause): from the sound of the last 8 s, has the
// speaker finished, or paused mid-thought? Lets a finished question get its answer sooner, and a
// thinking pause not be cut off. Optional: without it, turns end after a fixed silence.
import { env, WhisperFeatureExtractor } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { cachedUrls, fetchCached } from "./model-cache";

ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// transformers.js would try to cache the bundled runtime files (app://), which the browser Cache API refuses.
env.useWasmCache = false;
// Runs once per pause, so a couple of threads finish it quickly without idling hot in between.
ort.env.wasm.numThreads = 2;

const BASE = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main";
/** 8-bit, for the CPU. */
const CPU_URL = `${BASE}/smart-turn-v3.2-cpu.onnx`;
/**
 * Full precision, for the GPU: on an M1 the model ran in ~30 ms there against 120–450 ms on the CPU.
 * In voice mode, where the CPU is busy transcribing at that moment, the verdict came a median ~0.3 s
 * into the pause against ~0.7 s, by which time the fixed timeout had often ended the turn already.
 */
const GPU_URL = `${BASE}/smart-turn-v3.2-gpu.onnx`;
const SAMPLES = 8 * 16000;

type Judge = { session: ort.InferenceSession; features: WhisperFeatureExtractor; gpu: boolean };
let ready: Promise<Judge> | null = null;

const gpuAvailable: Promise<boolean> = (async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(await gpu?.requestAdapter());
  } catch {
    return false;
  }
})();
let gpuFailed = false;

const newFeatures = () =>
  new WhisperFeatureExtractor({ feature_size: 80, sampling_rate: 16000, hop_length: 160, n_fft: 400, n_samples: SAMPLES, nb_max_frames: 800, chunk_length: 8 });

/** The GPU model, warmed up (its first run compiles the kernels: up to ~2 s). */
async function openGpu(): Promise<Judge> {
  const session = await ort.InferenceSession.create(new Uint8Array(await fetchCached(GPU_URL)), { executionProviders: ["webgpu"] });
  try {
    const judge = { session, features: newFeatures(), gpu: true };
    await run(judge, new Float32Array(SAMPLES));
    return judge;
  } catch (error) {
    await session.release().catch(() => undefined);
    throw error;
  }
}

function load() {
  ready ??= (async () => {
    // Straight to the GPU when its model is already here; otherwise the CPU model first.
    if ((await gpuAvailable) && !gpuFailed && (await cachedUrls()).has(GPU_URL)) {
      try {
        return await openGpu();
      } catch {
        gpuFailed = true;
      }
    }
    const session = await ort.InferenceSession.create(new Uint8Array(await fetchCached(CPU_URL)), { executionProviders: ["wasm"] });
    void upgradeToGpu();
    return { session, features: newFeatures(), gpu: false };
  })();
  // Offline or blocked: answer "no model" and try again next time.
  ready.catch(() => (ready = null));
  return ready;
}

/** Downloads the GPU model (32 MB) in the background while the CPU one works, then switches. */
async function upgradeToGpu() {
  if (gpuFailed || !(await gpuAvailable)) return;
  try {
    const gpu = await openGpu();
    retired = (await ready?.catch(() => null))?.session ?? null;
    ready = Promise.resolve(gpu);
    if (!busy) releaseRetired();
  } catch {
    gpuFailed = true;
  }
}

/** The CPU session the GPU replaced: freed once no pause is being judged with it. */
let retired: ort.InferenceSession | null = null;
function releaseRetired() {
  void retired?.release().catch(() => undefined);
  retired = null;
}

async function run({ session, features }: Judge, input: Float32Array): Promise<number> {
  const { input_features } = await features(input);
  const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input_features.data as Float32Array, input_features.dims) });
  return ((await result[session.outputNames[0]].getData()) as Float32Array)[0];
}

async function judge(audio: Float32Array): Promise<{ probability: number; gpu: boolean }> {
  const model = await load();
  // The last 8 s, zero-padded at the start, normalised to zero mean and unit variance (as in the
  // reference implementation), then Whisper's log-mel features: [1, 80, 800].
  const input = new Float32Array(SAMPLES);
  const tail = audio.subarray(Math.max(0, audio.length - SAMPLES));
  input.set(tail, SAMPLES - tail.length);
  let mean = 0;
  for (const v of input) mean += v;
  mean /= input.length;
  let variance = 0;
  for (const v of input) variance += (v - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / input.length + 1e-7);
  for (let i = 0; i < input.length; i++) input[i] = (input[i] - mean) * scale;
  return { probability: await run(model, input), gpu: model.gpu };
}

// Only the newest pause matters; one at a time.
let busy = false;
self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  if (data.type === "load") {
    void load().catch(() => undefined);
    return;
  }
  if (data.type !== "judge") return;
  if (busy) return void (self as unknown as Worker).postMessage({ id: data.id, probability: null });
  busy = true;
  const started = performance.now();
  try {
    const { probability, gpu } = await judge(data.audio);
    (self as unknown as Worker).postMessage({ id: data.id, probability, gpu, ms: Math.round(performance.now() - started) });
  } catch {
    (self as unknown as Worker).postMessage({ id: data.id, probability: null });
  } finally {
    busy = false;
    releaseRetired();
  }
};
