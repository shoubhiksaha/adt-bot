// On-device speech pipeline: Silero VAD on every 32 ms frame, turn detection, and Whisper
// transcription, all off the main thread. Model files are cached in IndexedDB, so after the first
// download it works offline and audio never leaves the device.
import { env, pipeline } from "@huggingface/transformers";
import { createStore, get, set } from "idb-keyval";
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { FRAME, Segmenter, type SegmentEvent } from "./segmenter";

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
      ? new Response(hit.body, { headers: { "content-type": hit.type, "content-length": String(hit.body.byteLength) } })
      : undefined;
  },
  async put(url: string, response: Response) {
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    await set(url, { body: await response.arrayBuffer(), type }, files);
  },
};

const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

// One queue for all model work: ONNX Runtime sessions shouldn't run concurrently.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// Whisper ---------------------------------------------------------------------

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let whisper: { size: string; ready: Promise<Transcriber> } | null = null;

function loadWhisper(size: string): Promise<Transcriber> {
  if (whisper?.size !== size) {
    const ready = pipeline("automatic-speech-recognition", `onnx-community/whisper-${size}`, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (info: { status: string; progress?: number; loaded?: number; total?: number }) => {
        if (info.status === "progress_total") post({ type: "progress", progress: info.progress, loaded: info.loaded, total: info.total });
      },
    }).then(async (t) => {
      const transcriber = t as unknown as Transcriber;
      // Warm-up run so the first real question isn't slowed by kernel compilation.
      await transcriber(new Float32Array(16000), { language: "en" });
      post({ type: "progress", progress: 100 });
      post({ type: "whisper-ready" });
      return transcriber;
    }) as Promise<Transcriber>;
    whisper = { size, ready };
    ready.catch(() => (whisper = null));
  }
  return whisper.ready;
}

let language = "en";
let size = "base";

async function transcribe(audio: Float32Array): Promise<string> {
  const transcriber = await loadWhisper(size);
  return serial(async () => {
    const output = await transcriber(audio, { language, task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(output) ? output.map((o) => o.text).join(" ") : output.text).trim();
    // Whisper "hears" these in silence or noise.
    return /^(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching!?|\.+)$/i.test(text) ? "" : text;
  });
}

// VAD -----------------------------------------------------------------------

let vad: ort.InferenceSession | null = null;
let vadState: ort.Tensor = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
const vadRate = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
let context = new Float32Array(64);

const VAD_URL = "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx";

async function loadVad() {
  if (vad) return;
  const url = VAD_URL;
  let bytes = (await get<{ body: ArrayBuffer }>(url, files))?.body;
  if (!bytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't download the voice detector (${res.status})`);
    bytes = await res.arrayBuffer();
    await set(url, { body: bytes, type: "application/octet-stream" }, files);
  }
  vad = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"] });
}

async function speechProbability(frame: Float32Array): Promise<number> {
  const input = new Float32Array(64 + FRAME);
  input.set(context);
  input.set(frame, 64);
  context = frame.slice(FRAME - 64);
  const result = await vad!.run({ input: new ort.Tensor("float32", input, [1, 64 + FRAME]), state: vadState, sr: vadRate });
  vadState = result.stateN as ort.Tensor;
  return (result.output.data as Float32Array)[0];
}

// Live listening ------------------------------------------------------------------

let mode: "local" | "cloud" = "local";
let partials = false;
let muted = false;
const segmenter = new Segmenter({ endSilenceMs: 700 });
let speculative: { version: number; text: Promise<string> } | null = null;
let partialBusy = false;
let levelTick = 0;
const frames: Float32Array[] = [];
let pumping = false;
let port: MessagePort | null = null;

async function pump() {
  if (pumping || !vad) return;
  pumping = true;
  try {
    while (frames.length) {
      const frame = frames.shift()!;
      const probability = await serial(() => speechProbability(frame));
      if (++levelTick % 2 === 0) {
        let sum = 0;
        for (const s of frame) sum += s * s;
        post({ type: "level", level: Math.min(1, Math.sqrt(sum / frame.length) * 8), probability });
      }
      for (const event of segmenter.push(frame, probability)) handle(event);
    }
  } finally {
    pumping = false;
  }
}

function handle(event: SegmentEvent) {
  if (event.type === "start" || event.type === "speech" || event.type === "discard") post({ type: event.type });
  else if (event.type === "pause" && mode === "local") {
    // Start transcribing as soon as the speaker pauses; if they carry on, this is discarded.
    speculative = { version: event.version, text: transcribe(event.audio) };
  } else if (event.type === "resume") {
    if (speculative?.version === event.version) speculative = null;
  } else if (event.type === "progress" && partials && mode === "local" && !partialBusy) {
    partialBusy = true;
    transcribe(event.audio)
      .then((text) => text && post({ type: "partial", text }))
      .finally(() => (partialBusy = false));
  } else if (event.type === "end") {
    void finish(event);
  }
}

async function finish(event: Extract<SegmentEvent, { type: "end" }>) {
  post({ type: "transcribing" });
  if (mode === "cloud") {
    post({ type: "utterance", audio: event.audio }, [event.audio.buffer]);
    return;
  }
  const started = performance.now();
  try {
    const text = speculative?.version === event.version ? await speculative.text : await transcribe(event.audio);
    speculative = null;
    post({ type: "utterance", text, ms: Math.round(performance.now() - started) });
  } catch (error) {
    post({ type: "error", message: `Speech recognition failed: ${(error as Error).message}` });
  }
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;
  try {
    if (data.type === "start") {
      // A new listener takes over: unmute, and drop anything left from the previous one.
      muted = false;
      frames.length = 0;
      speculative = null;
      mode = data.mode;
      size = data.size ?? size;
      language = data.language ?? language;
      partials = Boolean(data.partials);
      segmenter.configure({ endSilenceMs: data.endSilenceMs ?? 700, startThreshold: 0.6 });
      segmenter.reset();
      // Only the newest microphone feeds the detector; two interleaved streams would garble both.
      port?.close();
      const current = data.port as MessagePort;
      port = current;
      await loadVad();
      if (mode === "local") await loadWhisper(size);
      if (port !== current) return;
      current.onmessage = (e: MessageEvent<Float32Array>) => {
        if (muted || port !== current) return;
        frames.push(e.data);
        // If transcription is busy, don't let a backlog build up beyond ~3 s.
        if (frames.length > 100) frames.splice(0, frames.length - 100);
        void pump();
      };
      post({ type: "ready" });
    } else if (data.type === "configure") {
      if (data.startThreshold !== undefined) segmenter.configure({ startThreshold: data.startThreshold });
      if (data.endSilenceMs !== undefined) segmenter.configure({ endSilenceMs: data.endSilenceMs });
      if (data.partials !== undefined) partials = data.partials;
      if (data.muted !== undefined) {
        muted = data.muted;
        if (muted) {
          frames.length = 0;
          segmenter.reset();
        }
      }
    } else if (data.type === "flush") {
      frames.length && (await pump());
      for (const e of segmenter.flush()) handle(e);
    } else if (data.type === "load") {
      size = data.size;
      await Promise.all([loadVad(), loadWhisper(size)]);
      post({ id: data.id, type: "done", text: "" });
    } else if (data.type === "transcribe") {
      size = data.size ?? size;
      language = data.language ?? language;
      post({ id: data.id, type: "done", text: await transcribe(data.audio) });
    }
  } catch (error) {
    post({ id: data.id, type: "error", message: (error as Error).message ?? String(error) });
  }
};
