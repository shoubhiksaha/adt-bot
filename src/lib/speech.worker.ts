// On-device speech pipeline: Silero VAD on every 32 ms frame, turn detection, and Whisper
// transcription, all off the main thread. Model files are cached in IndexedDB, so after the first
// download it works offline and audio never leaves the device.
import { createStore, get, set } from "idb-keyval";
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { FRAME, Segmenter, type SegmentEvent } from "./segmenter";

// Use the copies of ONNX Runtime bundled with the app, so nothing is fetched from a CDN.
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// The detector runs every 32 ms. With a thread pool, the idle threads busy-waited between frames
// and voice mode held ~3 CPU cores the whole time it was open; one thread is plenty for it.
ort.env.wasm.numThreads = 1;

const files = createStore("adtbot-models", "files");

const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

// Whisper ---------------------------------------------------------------------
// Runs in its own worker (with all the threads it wants), so a transcription never stalls the
// detector: turn ends and barge-ins are noticed on time, and no live audio is dropped meanwhile.

let transcriber: Worker | null = null;
let nextJob = 0;
const jobs = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

function getTranscriber(): Worker {
  if (transcriber) return transcriber;
  const worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.id === undefined) {
      post(data); // download progress and "whisper-ready"
      return;
    }
    // Replies are matched to this worker's own jobs; never pass one on, where the id means something else.
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.type === "done") job.resolve(data.text);
    else job.reject(new Error(data.message));
  };
  // A crash (e.g. out of memory) fails what's in flight; the next request starts a fresh one.
  worker.onerror = (event) => {
    const error = new Error(event.message || "The speech engine crashed");
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
    worker.terminate();
    if (transcriber === worker) transcriber = null;
  };
  transcriber = worker;
  return worker;
}

function whisperCall(message: Record<string, unknown>): Promise<string> {
  const id = ++nextJob;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    getTranscriber().postMessage({ ...message, id });
  });
}

let language = "en";
let size = "base";

const loadWhisper = (modelSize: string) => whisperCall({ type: "load", size: modelSize });
const transcribe = (audio: Float32Array) => whisperCall({ type: "transcribe", size, language, audio });

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

// Turn model ----------------------------------------------------------------------
// Smart Turn v3 (pipecat-ai, BSD-2-Clause) in its own worker (see turn.worker.ts), so judging a
// pause never holds up the detector.

let turnWorker: Worker | null = null;
let turnJob = 0;
const turnJobs = new Map<number, (result: { probability: number | null; ms?: number }) => void>();

function getTurnWorker(): Worker {
  if (turnWorker) return turnWorker;
  const worker = new Worker(new URL("./turn.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
    const resolve = turnJobs.get(event.data.id);
    turnJobs.delete(event.data.id);
    resolve?.(event.data);
  };
  worker.onerror = () => {
    for (const resolve of turnJobs.values()) resolve({ probability: null });
    turnJobs.clear();
    worker.terminate();
    if (turnWorker === worker) turnWorker = null;
  };
  turnWorker = worker;
  return worker;
}

const loadTurnModel = () => getTurnWorker().postMessage({ type: "load" });

/** Probability (0–1) that the speaker has finished, or null without the model. */
function turnFinished(audio: Float32Array): Promise<{ probability: number | null; ms?: number }> {
  const id = ++turnJob;
  return new Promise((resolve) => {
    turnJobs.set(id, resolve);
    getTurnWorker().postMessage({ type: "judge", id, audio });
  });
}

// Live listening ------------------------------------------------------------------

let mode: "local" | "cloud" = "local";
let partials = false;
let muted = false;
const segmenter = new Segmenter({ endSilenceMs: 700 });
let speculative: { version: number; text: Promise<string> } | null = null;
let partialBusy = false;
/** When the last caption finished, and how much audio it covered. */
let partialAt = 0;
let partialSamples = 0;
/**
 * Whisper always encodes a 30 s window, so each caption costs a full run: keep them sparse, and
 * skip short questions, where a caption would only delay the real transcription queued behind it.
 */
const PARTIAL_GAP_MS = 700;
const PARTIAL_MIN_SAMPLES = 14000;
const PARTIAL_NEW_SAMPLES = 8000;
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
      const probability = await speechProbability(frame);
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
  if (event.type === "start" || event.type === "speech" || event.type === "discard") {
    if (event.type === "start") partialSamples = 0;
    post({ type: event.type });
  } else if (event.type === "pause" && mode === "local") {
    // Start transcribing as soon as the speaker pauses; if they carry on, this is discarded.
    speculative = { version: event.version, text: transcribe(event.audio) };
  } else if (event.type === "silence") {
    const { version, audio } = event;
    void turnFinished(audio).then(({ probability, ms }) => {
      if (probability === null) return;
      segmenter.decide(version, probability > 0.5);
      post({ type: "turn", probability: Math.round(probability * 100) / 100, ms });
    });
  } else if (event.type === "resume") {
    if (speculative?.version === event.version) speculative = null;
  } else if (
    event.type === "progress" &&
    partials &&
    mode === "local" &&
    !partialBusy &&
    // Not while the detector is behind: catching up on live audio matters more than a caption.
    frames.length < 4 &&
    performance.now() - partialAt > PARTIAL_GAP_MS &&
    event.audio.length >= PARTIAL_MIN_SAMPLES &&
    event.audio.length - partialSamples >= PARTIAL_NEW_SAMPLES
  ) {
    partialBusy = true;
    partialSamples = event.audio.length;
    transcribe(event.audio)
      .then((text) => text && partials && post({ type: "partial", text }))
      .finally(() => {
        partialBusy = false;
        partialAt = performance.now();
      });
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
      loadTurnModel();
      if (mode === "local") await loadWhisper(size);
      if (port !== current) return;
      current.onmessage = (e: MessageEvent<Float32Array>) => {
        if (muted || port !== current) return;
        frames.push(e.data);
        // Never more than ~3 s behind (e.g. while the tab was throttled).
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
      loadTurnModel();
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
