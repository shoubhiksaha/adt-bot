import { createStore, keys } from "idb-keyval";

/**
 * The on-device natural voice (Supertonic, run in local-tts.worker.ts). This side starts the
 * worker when needed, hands it sentences, and stops it after a few idle minutes to free memory.
 */
export const LOCAL_VOICES: { id: string; label: string }[] = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((id) => ({
  id,
  label: `${id[0] === "F" ? "Female" : "Male"} ${id[1]}`,
}));
/** Download size of the model files (fp32 text encoder, denoiser and decoder). */
export const LOCAL_VOICE_MB = 262;

type Job = { resolve: (audio: { audio: Float32Array; sampleRate: number } | null) => void; reject: (error: Error) => void };

let worker: Worker | null = null;
let nextId = 0;
const jobs = new Map<number, Job>();
const progressListeners = new Set<(percent: number | null) => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 3 * 60_000;
/** The current worker has the model loaded and warmed up. */
let loaded = false;
let loading: Promise<void> | null = null;

function getWorker(): Worker {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  const w = new Worker(new URL("./local-tts.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === "progress") {
      const done = (data.progress ?? 0) >= 100;
      progressListeners.forEach((l) => l(done ? null : Math.round(data.progress ?? 0)));
      return;
    }
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.type === "audio") job.resolve({ audio: data.audio, sampleRate: data.sampleRate });
    else if (data.type === "done" || data.type === "skipped") job.resolve(null);
    else job.reject(new Error(data.message || "The on-device voice failed"));
    if (!jobs.size) releaseLater();
  };
  w.onerror = (event) => {
    const error = new Error(event.message || "The on-device voice crashed");
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
    w.terminate();
    if (worker === w) {
      worker = null;
      loaded = false;
      loading = null;
    }
  };
  worker = w;
  return w;
}

/** The model takes a few hundred MB: stop the worker when the voice hasn't been used for a while. */
function releaseLater() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (jobs.size) return;
    worker?.terminate();
    worker = null;
    loaded = false;
    loading = null;
  }, IDLE_MS);
}

function call(message: Record<string, unknown>): { id: number; result: Promise<{ audio: Float32Array; sampleRate: number } | null> } {
  const id = ++nextId;
  const result = new Promise<{ audio: Float32Array; sampleRate: number } | null>((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    getWorker().postMessage({ ...message, id });
  });
  return { id, result };
}

/** Download progress of the voice model (null when idle or done). */
export function onLocalVoiceProgress(listener: (percent: number | null) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** Loads (downloading the first time) and warms up the voice. */
export function preloadLocalVoice(voice = "F1"): Promise<void> {
  loading ??= call({ type: "load", voice }).result.then(
    () => {
      loaded = true;
    },
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Whether sentences can be spoken with the on-device voice right now. If not, loading starts in the
 * background and the caller uses the device voice meanwhile, so the first reply isn't held up by a
 * download or by loading the model.
 */
export function localVoiceReady(voice = "F1"): boolean {
  if (!loaded) void preloadLocalVoice(voice).catch(() => undefined);
  return loaded;
}

export async function localVoiceDownloaded(): Promise<boolean> {
  try {
    const stored = (await keys(createStore("adtbot-models", "files"))) as string[];
    const has = (part: string) => stored.some((k) => k.includes("Supertonic-TTS-ONNX") && k.includes(part));
    return has("text_encoder.onnx_data") && has("latent_denoiser.onnx_data") && has("voice_decoder.onnx_data");
  } catch {
    return false;
  }
}

/**
 * Speaks one sentence into raw audio. Resolves null when stopped first. The speech rate maps to
 * the model's speed; short sentences use fewer denoising steps, so the first words come sooner.
 */
export function synthesizeLocally(text: string, voice: string, rate: number, signal: AbortSignal): Promise<{ audio: Float32Array; sampleRate: number } | null> {
  if (signal.aborted) return Promise.resolve(null);
  const { id, result } = call({ type: "speak", text, voice, speed: rate, steps: text.length < 60 ? 4 : 5 });
  signal.addEventListener("abort", () => worker?.postMessage({ type: "cancel", ids: [id] }), { once: true });
  return result;
}
