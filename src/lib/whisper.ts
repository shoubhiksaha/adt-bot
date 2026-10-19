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
const liveListeners = new Set<(message: any) => void>();

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
      liveListeners.forEach((l) => l(data));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "The speech engine crashed");
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      liveListeners.forEach((l) => l({ type: "error", message: error.message }));
      worker = null;
    };
  }
  return worker;
}

function call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<string> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...message, id }, transfer);
  });
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
  | { type: "utterance"; text?: string; audio?: Float32Array; ms?: number }
  | { type: "error"; message: string }
  /** The microphone delivers pure digital silence: blocked by the OS, muted, or the wrong input. */
  | { type: "silent"; message: string };

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
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private onMessage: ((message: any) => void) | null = null;
  private closed = false;

  static async open(options: ListenerOptions): Promise<Listener> {
    const listener = new Listener();
    await listener.start(options);
    return listener;
  }

  private async start(options: ListenerOptions) {
    try {
      await this.connect(options);
    } catch (error) {
      // Don't leave the microphone or the worker running after a failed start.
      this.close();
      throw error;
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
      this.onMessage = (message) => {
        if (this.closed) return;
        if (message.type === "ready") resolve();
        if (message.type === "error" && message.id === undefined) reject(new Error(message.message));
        if (message.type === "level" && silentReports >= 0) {
          // A blocked microphone delivers exact zeros from the start. Once any sound has come
          // through, stop checking: some mics gate quiet rooms to zero.
          silentReports = message.level === 0 ? silentReports + 1 : -1;
          if (silentReports === SILENT_REPORTS) {
            // Still nothing by the time the explanation is ready? Then report it.
            void silentMicMessage().then((text) => !this.closed && silentReports > 0 && options.onEvent({ type: "silent", message: text }));
          }
        }
        options.onEvent(message);
      };
    });
    liveListeners.add(this.onMessage!);
    getWorker().postMessage(
      {
        type: "start",
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
  }

  /** While the bot talks, require clearer speech to start a turn (ignores most echo). */
  setSensitivity(level: "normal" | "strict") {
    getWorker().postMessage({ type: "configure", startThreshold: level === "strict" ? 0.85 : 0.6 });
  }

  setMuted(muted: boolean) {
    getWorker().postMessage({ type: "configure", muted });
  }

  setPartials(partials: boolean) {
    getWorker().postMessage({ type: "configure", partials });
  }

  /** Finish the current utterance now. */
  flush() {
    getWorker().postMessage({ type: "flush" });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    getWorker().postMessage({ type: "configure", muted: true });
    if (this.onMessage) liveListeners.delete(this.onMessage);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close();
  }
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
