// On-device natural voice: Supertonic (Supertone, OpenRAIL-M model; MIT sample code), run with
// transformers.js. No phonemizer (it reads plain text), so nothing GPL is bundled. Model files are
// cached in IndexedDB like Whisper's, so after the first download it works offline.
import { env, pipeline } from "@huggingface/transformers";
import { createStore, get, set } from "idb-keyval";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

// Use the copies of ONNX Runtime bundled with the app, so nothing is fetched from a CDN.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

const MODEL = "onnx-community/Supertonic-TTS-ONNX";
const VOICE_URL = (id: string) => `https://huggingface.co/${MODEL}/resolve/main/voices/${id}.bin`;
const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

const files = createStore("adtbot-models", "files");

env.allowLocalModels = false;
env.useBrowserCache = false;
// The ONNX Runtime files are bundled with the app (app://), which the browser Cache API refuses.
env.useWasmCache = false;
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

type Output = { audio: Float32Array; sampling_rate: number };
type Synthesizer = ((text: string, options: Record<string, unknown>) => Promise<Output>) & { dispose?: () => Promise<void> };

/** The GPU when WebGPU works here (much faster for the denoiser), otherwise the CPU. */
const gpuAvailable: Promise<boolean> = (async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(await gpu?.requestAdapter());
  } catch {
    return false;
  }
})();

let ready: Promise<{ tts: Synthesizer; device: string }> | null = null;

function progress(info: { status: string; progress?: number; loaded?: number; total?: number }) {
  if (info.status === "progress_total") post({ type: "progress", progress: info.progress, loaded: info.loaded, total: info.total });
}

async function create(device: "webgpu" | "wasm"): Promise<Synthesizer> {
  return (await pipeline("text-to-speech", MODEL, { device, dtype: "fp32", progress_callback: progress } as never)) as unknown as Synthesizer;
}

/** The voice the user picked, so warming up doesn't download one they never use. */
let warmVoice = "F1";

function load(): Promise<{ tts: Synthesizer; device: string }> {
  ready ??= (async () => {
    let device: "webgpu" | "wasm" = (await gpuAvailable) ? "webgpu" : "wasm";
    // The voice is fetched first, so a failed voice download isn't mistaken for a GPU problem.
    const embedding = await voice(warmVoice);
    let tts: Synthesizer | undefined;
    try {
      tts = await create(device);
      // Warm-up: compiles the GPU kernels, so the first real sentence isn't slow.
      await tts("Hi.", { speaker_embeddings: embedding, num_inference_steps: 2, speed: 1 });
    } catch (error) {
      if (device === "wasm") throw error;
      // Free the GPU copy before loading another on the CPU.
      await tts?.dispose?.().catch(() => undefined);
      device = "wasm";
      tts = await create(device);
    }
    post({ type: "progress", progress: 100 });
    return { tts, device };
  })();
  ready.catch(() => (ready = null));
  return ready;
}

/** Speaker embeddings, loaded once each (passing the URL would fetch it on every sentence). */
const voices = new Map<string, Promise<Float32Array>>();
function voice(id: string): Promise<Float32Array> {
  const name = VOICES.includes(id) ? id : "F1";
  let embedding = voices.get(name);
  if (!embedding) {
    embedding = (async () => {
      const url = VOICE_URL(name);
      let bytes = (await get<{ body: ArrayBuffer }>(url, files))?.body;
      if (!bytes) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Couldn't download the voice (${res.status})`);
        bytes = await res.arrayBuffer();
        await set(url, { body: bytes, type: "application/octet-stream" }, files);
      }
      return new Float32Array(bytes);
    })();
    embedding.catch(() => voices.delete(name));
    voices.set(name, embedding);
  }
  return embedding;
}

// One sentence at a time; sentences the speaker no longer wants (barge-in) are skipped.
let queue: Promise<unknown> = Promise.resolve();
const cancelled = new Set<number>();

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (data.type === "cancel") {
    for (const id of data.ids as number[]) cancelled.add(id);
    return;
  }
  const run = async () => {
    try {
      if (data.type === "load") {
        warmVoice = VOICES.includes(data.voice) ? data.voice : warmVoice;
        const { device } = await load();
        await voice(data.voice ?? "F1");
        post({ id: data.id, type: "done", device });
      } else if (data.type === "speak") {
        if (cancelled.delete(data.id)) return post({ id: data.id, type: "skipped" });
        if (VOICES.includes(data.voice)) warmVoice = data.voice;
        const { tts } = await load();
        const out = await tts(String(data.text), {
          speaker_embeddings: await voice(data.voice),
          // Fewer denoising steps = faster; 5 is the model's default quality.
          num_inference_steps: data.steps ?? 5,
          speed: Math.min(1.6, Math.max(0.7, Number(data.speed) || 1)) * 1.05,
        });
        if (cancelled.delete(data.id)) return post({ id: data.id, type: "skipped" });
        post({ id: data.id, type: "audio", audio: out.audio, sampleRate: out.sampling_rate }, [out.audio.buffer]);
      }
    } catch (error) {
      post({ id: data.id, type: "error", message: (error as Error).message ?? String(error) });
    }
  };
  queue = queue.then(run, run);
};
