// Smart Turn v3 (pipecat-ai/smart-turn, BSD-2-Clause): from the sound of the last 8 s, has the
// speaker finished, or paused mid-thought? Lets a finished question get its answer sooner, and a
// thinking pause not be cut off. Optional: without it, turns end after a fixed silence.
import { WhisperFeatureExtractor } from "@huggingface/transformers";
import { createStore, get, set } from "idb-keyval";
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// Runs once per pause, so a couple of threads finish it quickly without idling hot in between.
ort.env.wasm.numThreads = 2;

const files = createStore("adtbot-models", "files");
const URL_ = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx";
const SAMPLES = 8 * 16000;

let ready: Promise<{ session: ort.InferenceSession; features: WhisperFeatureExtractor }> | null = null;

function load() {
  ready ??= (async () => {
    let bytes = (await get<{ body: ArrayBuffer }>(URL_, files))?.body;
    if (!bytes) {
      const res = await fetch(URL_);
      if (!res.ok) throw new Error(`turn model ${res.status}`);
      bytes = await res.arrayBuffer();
      await set(URL_, { body: bytes, type: "application/octet-stream" }, files);
    }
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"] });
    const features = new WhisperFeatureExtractor({ feature_size: 80, sampling_rate: 16000, hop_length: 160, n_fft: 400, n_samples: SAMPLES, nb_max_frames: 800, chunk_length: 8 });
    return { session, features };
  })();
  // Offline or blocked: answer "no model" and try again next time.
  ready.catch(() => (ready = null));
  return ready;
}

async function judge(audio: Float32Array): Promise<number> {
  const { session, features } = await load();
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
  const { input_features } = await features(input);
  const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input_features.data as Float32Array, input_features.dims) });
  return (result[session.outputNames[0]].data as Float32Array)[0];
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
    const probability = await judge(data.audio);
    (self as unknown as Worker).postMessage({ id: data.id, probability, ms: Math.round(performance.now() - started) });
  } catch {
    (self as unknown as Worker).postMessage({ id: data.id, probability: null });
  } finally {
    busy = false;
  }
};
