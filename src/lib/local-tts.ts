import { createStore, keys } from "idb-keyval";
import type { LocalChoice, LocalEngine } from "./local-tts-voices";

/**
 * The on-device natural voices: Supertonic (local-tts.worker.ts) and Kokoro (kokoro-tts.worker.ts).
 * This side starts the chosen voice's worker when needed, hands it sentences, and stops it after a
 * few idle minutes to free memory. Kokoro's code (and its phonemizer) only loads when it's chosen.
 */
export type { LocalChoice, LocalEngine };
export { KOKORO_MB, KOKORO_VOICES, LOCAL_VOICE_MB, LOCAL_VOICES, localChoice, splitLongText, SUPERTONIC3_MB } from "./local-tts-voices";

type Audio = { audio: Float32Array; sampleRate: number };
type Job = { resolve: (audio: Audio | null) => void; reject: (error: Error) => void };

/** One worker per engine; usually only the chosen one ever starts. */
class Engine {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly jobs = new Map<number, Job>();
  readonly progressListeners = new Set<(percent: number | null) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The current worker has the model loaded and warmed up. */
  loaded = false;
  loading: Promise<void> | null = null;

  constructor(private readonly start: () => Worker) {}

  private getWorker(): Worker {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.worker) return this.worker;
    const w = this.start();
    w.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data.type === "progress") {
        const done = (data.progress ?? 0) >= 100;
        this.progressListeners.forEach((l) => l(done ? null : Math.round(data.progress ?? 0)));
        return;
      }
      const job = this.jobs.get(data.id);
      if (!job) return;
      this.jobs.delete(data.id);
      if (data.type === "audio") job.resolve({ audio: data.audio, sampleRate: data.sampleRate });
      else if (data.type === "done" || data.type === "skipped") job.resolve(null);
      else job.reject(new Error(data.message || "The on-device voice failed"));
      if (!this.jobs.size) this.releaseLater();
    };
    w.onerror = (event) => {
      const error = new Error(event.message || "The on-device voice crashed");
      for (const job of this.jobs.values()) job.reject(error);
      this.jobs.clear();
      w.terminate();
      if (this.worker === w) this.reset();
    };
    this.worker = w;
    return w;
  }

  private reset() {
    this.worker = null;
    this.loaded = false;
    this.loading = null;
  }

  /** The model takes a few hundred MB: stop the worker when the voice hasn't been used for a while. */
  private releaseLater() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.jobs.size) return;
      this.worker?.terminate();
      this.reset();
    }, IDLE_MS);
  }

  call(message: Record<string, unknown>): { id: number; result: Promise<Audio | null> } {
    const id = ++this.nextId;
    const result = new Promise<Audio | null>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.getWorker().postMessage({ ...message, id });
    });
    return { id, result };
  }

  cancel(id: number) {
    this.worker?.postMessage({ type: "cancel", ids: [id] });
  }
}

const IDLE_MS = 3 * 60_000;

const engines: Record<LocalEngine, Engine> = {
  supertonic: new Engine(() => new Worker(new URL("./local-tts.worker.ts", import.meta.url), { type: "module" })),
  supertonic3: new Engine(() => new Worker(new URL("./supertonic3.worker.ts", import.meta.url), { type: "module" })),
  kokoro: new Engine(() => new Worker(new URL("./kokoro-tts.worker.ts", import.meta.url), { type: "module" })),
};

/** Download progress of a voice model (null when idle or done). */
export function onLocalVoiceProgress(engine: LocalEngine, listener: (percent: number | null) => void): () => void {
  engines[engine].progressListeners.add(listener);
  return () => engines[engine].progressListeners.delete(listener);
}

/** Loads (downloading the first time) and warms up the voice. */
export function preloadLocalVoice(choice: LocalChoice): Promise<void> {
  const e = engines[choice.engine];
  e.loading ??= e.call({ type: "load", voice: choice.voice }).result.then(
    () => {
      e.loaded = true;
    },
    (error) => {
      e.loading = null;
      throw error;
    },
  );
  return e.loading;
}

/**
 * Whether sentences can be spoken with the on-device voice right now. If not, loading starts in the
 * background and the caller uses the device voice meanwhile, so the first reply isn't held up by a
 * download or by loading the model.
 */
export function localVoiceReady(choice: LocalChoice): boolean {
  const e = engines[choice.engine];
  if (!e.loaded) void preloadLocalVoice(choice).catch(() => undefined);
  return e.loaded;
}

export async function localVoiceDownloaded(engine: LocalEngine): Promise<boolean> {
  try {
    const stored = (await keys(createStore("adtbot-models", "files"))) as string[];
    if (engine === "kokoro") return stored.some((k) => k.includes("Kokoro-82M-v1.0-ONNX") && k.endsWith("model_quantized.onnx"));
    if (engine === "supertonic3") {
      return ["duration_predictor", "text_encoder", "vector_estimator", "vocoder"].every((part) => stored.some((k) => k.includes("supertonic-3/") && k.endsWith(`/${part}.onnx`)));
    }
    const has = (part: string) => stored.some((k) => k.includes("Supertonic-TTS-ONNX") && k.includes(part));
    return has("text_encoder.onnx_data") && has("latent_denoiser.onnx_data") && has("voice_decoder.onnx_data");
  } catch {
    return false;
  }
}

/**
 * Speaks one sentence into raw audio. Resolves null when stopped first. The speech rate maps to
 * the model's speed; for Supertonic, short sentences use fewer denoising steps, so the first words
 * come sooner.
 */
export function synthesizeLocally(text: string, choice: LocalChoice, rate: number, signal: AbortSignal): Promise<Audio | null> {
  if (signal.aborted) return Promise.resolve(null);
  const e = engines[choice.engine];
  const { id, result } = e.call({ type: "speak", text, voice: choice.voice, speed: rate, steps: text.length < 60 ? 4 : 5 });
  signal.addEventListener("abort", () => e.cancel(id), { once: true });
  return result;
}
