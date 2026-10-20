import { createStore, keys } from "idb-keyval";
import workletUrl from "./pcm-worklet.js?url";

export type WhisperSize = "tiny" | "base" | "small";
export const WHISPER_SIZES: Record<WhisperSize, { label: string; mb: number }> = {
  tiny: { label: "Tiny: fastest, good for phones", mb: 41 },
  base: { label: "Base: balanced (recommended)", mb: 77 },
  small: { label: "Small: most accurate, slower", mb: 249 },
};

type Progress = { progress: number; loaded: number; total: number };
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
const progressListeners = new Set<(p: Progress | null) => void>();
/** Live listeners by id; worker events carry the id of the listener they belong to. */
const liveListeners = new Map<number, (message: any) => void>();
let nextListener = 0;
/**
 * Listeners in the order they started. Only the newest has the microphone; older ones (e.g. the
 * hands-free wake listener while you dictate) wait and get it back when the newer one closes.
 */
const listeners: Listener[] = [];

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./speech.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === "progress") {
        const done = (data.progress ?? 0) >= 100;
        progressListeners.forEach((l) => l(done ? null : { progress: data.progress ?? 0, loaded: data.loaded ?? 0, total: data.total ?? 0 }));
        return;
      }
      if (data.id !== undefined && pending.has(data.id)) {
        const job = pending.get(data.id)!;
        pending.delete(data.id);
        if (data.type === "done") job.resolve(data.text);
        else job.reject(new Error(data.message));
        return;
      }
      if (data.listener !== undefined) liveListeners.get(data.listener)?.(data);
      else liveListeners.forEach((l) => l(data));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "The speech engine crashed");
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      liveListeners.forEach((l) => l({ type: "error", message: error.message }));
      // Free its models (hundreds of MB); the next request starts a fresh worker.
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<string> {
  const id = ++nextId;
  cancelIdleRelease();
  const result = new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...message, id }, transfer);
  });
  // Warm-ups and one-off transcriptions: release the models later if nothing starts listening.
  void result.catch(() => undefined).finally(() => !liveListeners.size && scheduleIdleRelease());
  return result;
}

const language = () => (navigator.language || "en").split("-")[0].toLowerCase();

/** Download progress of the speech model (null when idle or done). */
export function onWhisperProgress(listener: (p: Progress | null) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export function preloadWhisper(size: WhisperSize): Promise<void> {
  return call({ type: "load", size }).then(() => undefined);
}

export async function whisperDownloaded(size: WhisperSize): Promise<boolean> {
  try {
    const stored = (await keys(createStore("adtbot-models", "files"))) as string[];
    const has = (...parts: string[]) => stored.some((k) => parts.every((p) => k.includes(p)));
    // Everything voice mode needs offline: both halves of Whisper and the voice detector.
    return has(`whisper-${size}/`, "encoder") && has(`whisper-${size}/`, "decoder") && has("silero-vad");
  } catch {
    return false;
  }
}

export async function transcribeLocally(audio: Blob | Float32Array, size: WhisperSize): Promise<string> {
  const samples = audio instanceof Float32Array ? audio : await decodeTo16k(audio);
  if (samples.length < 16000 * 0.3) return "";
  return call({ type: "transcribe", size, audio: samples, language: language() }, [samples.buffer]);
}

/** Whisper wants 16 kHz mono samples. */
async function decodeTo16k(audio: Blob): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
    const left = decoded.getChannelData(0);
    const right = decoded.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
    return mono;
  } finally {
    void context.close();
  }
}

// Live listening -----------------------------------------------------------------

export type ListenerEvent =
  | { type: "ready" }
  | { type: "level"; level: number; probability: number }
  | { type: "start" }
  /** Clear speech for a quarter second (not a cough or click). */
  | { type: "speech" }
  /** The sound that started a turn was too short to be speech. */
  | { type: "discard" }
  | { type: "partial"; text: string }
  | { type: "transcribing" }
  /** `ms`: transcription time; `waitMs`: silence waited before the turn was judged over. */
  | { type: "utterance"; text?: string; audio?: Float32Array; ms?: number; waitMs?: number }
  | { type: "error"; message: string }
  /** The microphone delivers pure digital silence: blocked by the OS, muted, or the wrong input. */
  | { type: "silent"; message: string }
  /** The turn model judged a pause: probability that the speaker had finished. */
  | { type: "turn"; probability: number };

/** About 3 s of level reports (one per 64 ms) at exactly zero, right after the microphone opened. */
const SILENT_REPORTS = 48;

async function silentMicMessage(): Promise<string> {
  const desktop = (window as { adtbotDesktop?: { platform: string; invoke(channel: string): Promise<unknown> } }).adtbotDesktop;
  const status = await desktop?.invoke("adt:mic:status").catch(() => "unknown");
  if (status === "denied" || status === "restricted") {
    return desktop?.platform === "darwin"
      ? "ADT Bot isn't allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone, then reopen voice mode."
      : "ADT Bot isn't allowed to use the microphone. Allow it in your system's privacy settings, then reopen voice mode.";
  }
  return "Your microphone is sending silence. Check that the right input is selected and not muted in your sound settings, then tap to try again.";
}

export type ListenerOptions = {
  mode: "local" | "cloud";
  size: WhisperSize;
  endSilenceMs: number;
  partials: boolean;
  onEvent: (event: ListenerEvent) => void;
};

/**
 * Always-on microphone for voice mode and hands-free use: audio frames flow from an AudioWorklet
 * straight into the speech worker, which detects turns and transcribes them.
 */
export class Listener {
  private readonly id = ++nextListener;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private options: ListenerOptions | null = null;
  private closed = false;
  private muted = false;
  private reopening = false;
  /** A newer listener has the microphone. */
  private suspended = false;
  /** When the detector last reported a level (every 64 ms while frames flow). */
  private lastFrameAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private onDeviceChange = () => this.reopenSoon();

  static async open(options: ListenerOptions): Promise<Listener> {
    const listener = new Listener();
    await listener.start(options);
    return listener;
  }

  private async start(options: ListenerOptions) {
    this.options = options;
    listeners.forEach((l) => l.suspend());
    listeners.push(this);
    try {
      await this.connect(options);
    } catch (error) {
      // Don't leave the microphone or the worker running after a failed start.
      this.close();
      throw error;
    }
    if (this.closed) return;
    cancelIdleRelease();
    // A microphone that stops delivering audio (unplugged, sleep/wake, another app took it) would
    // otherwise leave voice mode "listening" forever: reopen it.
    navigator.mediaDevices.addEventListener?.("devicechange", this.onDeviceChange);
    this.watchdog = setInterval(() => {
      if (!this.closed && !this.muted && !this.suspended && !this.reopening && performance.now() - this.lastFrameAt > 2500) this.reopenSoon(0);
    }, 1000);
  }

  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopenSoon(delay = 600) {
    if (this.closed || this.suspended || this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      void this.reopen();
    }, delay);
  }

  private async reopen() {
    if (this.closed || this.reopening || !this.options) return;
    this.reopening = true;
    this.release();
    try {
      await this.connect(this.options);
      if (this.muted) this.setMuted(true);
    } catch (error) {
      if (!this.closed) this.options.onEvent({ type: "error", message: (error as Error).message });
    } finally {
      this.reopening = false;
      this.lastFrameAt = performance.now();
    }
  }

  private async connect(options: ListenerOptions) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      throw new Error("Microphone access was blocked. Allow it in your system or browser settings.");
    }
    if (this.closed) return this.release();
    this.stream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => this.reopenSoon()));
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.audioWorklet.addModule(workletUrl);
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "pcm-frames");
    // Keep the node pulled by the audio graph without making any sound.
    const silent = this.context.createGain();
    silent.gain.value = 0;
    source.connect(this.node).connect(silent).connect(this.context.destination);
    if (this.context.state === "suspended") await this.context.resume();

    const channel = new MessageChannel();
    this.node.port.postMessage({ port: channel.port1 }, [channel.port1]);

    let silentReports = 0;
    const ready = new Promise<void>((resolve, reject) => {
      liveListeners.set(this.id, (message) => {
        if (this.closed) return;
        if (message.type === "ready") resolve();
        if (message.type === "error" && message.id === undefined) reject(new Error(message.message));
        if (message.type === "level") {
          this.lastFrameAt = performance.now();
          if (silentReports >= 0) {
            // A blocked microphone delivers exact zeros from the start. Once any sound has come
            // through, stop checking: some mics gate quiet rooms to zero.
            silentReports = message.level === 0 ? silentReports + 1 : -1;
            if (silentReports === SILENT_REPORTS) {
              // Still nothing by the time the explanation is ready? Then report it.
              void silentMicMessage().then((text) => !this.closed && silentReports > 0 && options.onEvent({ type: "silent", message: text }));
            }
          }
        }
        options.onEvent(message);
      });
    });
    getWorker().postMessage(
      {
        type: "start",
        listener: this.id,
        mode: options.mode,
        size: options.size,
        language: language(),
        endSilenceMs: options.endSilenceMs,
        partials: options.partials,
        port: channel.port2,
      },
      [channel.port2],
    );
    await ready;
    this.lastFrameAt = performance.now();
  }

  private suspend() {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    this.release();
  }

  private resume() {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    void this.reopen();
  }

  /** Stops this listener's microphone and audio graph (the worker keeps running). */
  private release() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private configure(message: Record<string, unknown>) {
    getWorker().postMessage({ type: "configure", listener: this.id, ...message });
  }

  /** While the bot talks, require clearer speech to start a turn (ignores most echo). */
  setSensitivity(level: "normal" | "strict") {
    this.configure({ startThreshold: level === "strict" ? 0.85 : 0.6 });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.lastFrameAt = performance.now();
    this.configure({ muted });
  }

  setPartials(partials: boolean) {
    this.configure({ partials });
  }

  /** Finish the current utterance now. */
  flush() {
    getWorker().postMessage({ type: "flush", listener: this.id });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    // Only mutes the detector if this listener still owns it (the worker ignores it otherwise).
    if (worker) this.configure({ muted: true });
    liveListeners.delete(this.id);
    this.release();
    const index = listeners.indexOf(this);
    if (index >= 0) listeners.splice(index, 1);
    // Hand the microphone back to the listener this one took it from.
    if (index === listeners.length) listeners.at(-1)?.resume();
    if (!listeners.length) scheduleIdleRelease();
  }
}

// Releasing memory ----------------------------------------------------------------------------
// The speech models (detector, Whisper on the GPU, turn model) take a few hundred MB. Once nothing
// has listened for a while, stop the worker; the next use loads them again from the cache.

const IDLE_RELEASE_MS = 3 * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleRelease() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleRelease() {
  cancelIdleRelease();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!worker || liveListeners.size || pending.size) return;
    worker.terminate();
    worker = null;
  }, IDLE_RELEASE_MS);
}

/** 16 kHz mono samples as a WAV file, for cloud transcription. */
export function toWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
