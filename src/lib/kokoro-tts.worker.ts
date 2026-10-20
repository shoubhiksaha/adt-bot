// On-device natural voice: Kokoro-82M (hexgrad, Apache-2.0) through kokoro-js (Apache-2.0). Its
// phonemizer embeds eSpeak NG (GPL-3.0), so all of it is imported lazily here: this worker is only
// started when Kokoro is the chosen voice, and none of it is in the main bundle. kokoro-js runs on
// the app's own transformers.js (see "overrides" in package.json). Model and voice files are cached
// in IndexedDB like the other on-device models, so after the first download it works offline.
import { env } from "@huggingface/transformers";
import { createStore, get, set } from "idb-keyval";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { splitLongText } from "./local-tts-voices";

// Use the copies of ONNX Runtime bundled with the app, so nothing is fetched from a CDN.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** 8-bit weights (92 MB), the same file on the GPU and the CPU, so falling back never downloads again. */
const DTYPE = "q8";
const VOICE_PREFIX = `https://huggingface.co/${MODEL}/resolve/main/voices/`;
const SAMPLE_RATE = 24000;

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

// kokoro-js fetches voice files itself (through the Cache API, which isn't reliable in the desktop
// app); keep them in IndexedDB with the model instead, so voices work offline too.
const networkFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(VOICE_PREFIX)) return networkFetch(input, init);
  const hit = await get<{ body: ArrayBuffer }>(url, files);
  if (hit) return new Response(hit.body.slice(0));
  const res = await networkFetch(input, init);
  if (!res.ok) throw new Error(`Couldn't download the voice (${res.status})`);
  const body = await res.arrayBuffer();
  await set(url, { body, type: "application/octet-stream" }, files);
  return new Response(body.slice(0));
};

const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

type Kokoro = {
  generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  model: { dispose?: () => Promise<unknown> };
};

/** The GPU when WebGPU works here, otherwise the CPU. */
const gpuAvailable: Promise<boolean> = (async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(await gpu?.requestAdapter());
  } catch {
    return false;
  }
})();

function progress(info: { status: string; progress?: number; loaded?: number; total?: number }) {
  if (info.status === "progress_total") post({ type: "progress", progress: info.progress, loaded: info.loaded, total: info.total });
}

async function create(device: "webgpu" | "wasm"): Promise<Kokoro> {
  const { KokoroTTS } = await import("kokoro-js");
  return (await KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE, device, progress_callback: progress as never })) as unknown as Kokoro;
}

let ready: Promise<{ tts: Kokoro; device: string }> | null = null;
/** The voice the user picked, so warming up doesn't download one they never use. */
let warmVoice = "af_heart";

function load(): Promise<{ tts: Kokoro; device: string }> {
  ready ??= (async () => {
    let device: "webgpu" | "wasm" = (await gpuAvailable) ? "webgpu" : "wasm";
    let tts: Kokoro | undefined;
    try {
      tts = await create(device);
      // Warm-up with the chosen voice: compiles the GPU kernels and fetches the voice, so the first
      // real sentence isn't slow.
      await tts.generate("Hi.", { voice: warmVoice, speed: 1 });
    } catch (error) {
      if (device === "wasm" || /voice/i.test((error as Error).message ?? "")) throw error;
      // Free the GPU copy before loading another on the CPU.
      await tts?.model.dispose?.().catch(() => undefined);
      device = "wasm";
      tts = await create(device);
      await tts.generate("Hi.", { voice: warmVoice, speed: 1 });
    }
    post({ type: "progress", progress: 100 });
    return { tts, device };
  })();
  ready.catch(() => (ready = null));
  return ready;
}

/** Long sentences are spoken in pieces and joined, since Kokoro cuts off long input. */
async function speak(tts: Kokoro, text: string, voice: string, speed: number): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  for (const piece of splitLongText(text)) parts.push((await tts.generate(piece, { voice, speed })).audio);
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const isVoice = (id: unknown): id is string => typeof id === "string" && /^[ab][fm]_[a-z]+$/.test(id);

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
        if (isVoice(data.voice)) warmVoice = data.voice;
        const { device } = await load();
        post({ id: data.id, type: "done", device });
      } else if (data.type === "speak") {
        if (cancelled.delete(data.id)) return post({ id: data.id, type: "skipped" });
        const voice = isVoice(data.voice) ? data.voice : warmVoice;
        warmVoice = voice;
        const { tts } = await load();
        const audio = await speak(tts, String(data.text), voice, Math.min(1.6, Math.max(0.7, Number(data.speed) || 1)));
        if (cancelled.delete(data.id)) return post({ id: data.id, type: "skipped" });
        post({ id: data.id, type: "audio", audio, sampleRate: SAMPLE_RATE }, [audio.buffer]);
      }
    } catch (error) {
      post({ id: data.id, type: "error", message: (error as Error).message ?? String(error) });
    }
  };
  queue = queue.then(run, run);
};
