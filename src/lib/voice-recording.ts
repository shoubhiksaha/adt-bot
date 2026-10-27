// Settings → Voice → Voice diagnostics: the last seconds of the bot's voice as it went to the
// speakers, kept in memory for a voice report (noise, crackling or a siren can only be judged by
// ear). Only while diagnostics is on, and only voices the page plays (the computer's own voices
// play outside it). Nothing is saved unless the person adds it to a report.
import workletUrl from "./record-worklet.js?url";
import { useStore } from "./store";

export const KEEP_SECONDS = 10;

let output: { ctx: AudioContext; from: AudioNode } | null = null;
let recorder: { node: AudioWorkletNode; sink: GainNode } | null = null;
let starting = false;
let chunks: Float32Array[] = [];
let rate = 0;

const wanted = () => Boolean(useStore.getState().settings.voice.diagnostics);

/** tts.ts calls this each time it plays something, with its output (after the cut-in turn-down). */
export function recordBotVoice(ctx: AudioContext, from: AudioNode) {
  if (output?.from !== from) {
    stop();
    output = { ctx, from };
  }
  if (!wanted()) {
    stop();
    chunks = [];
  } else if (!recorder && !starting) void start(output);
}

async function start(at: { ctx: AudioContext; from: AudioNode }) {
  starting = true;
  try {
    await at.ctx.audioWorklet.addModule(workletUrl);
    if (output !== at || !wanted()) return;
    const node = new AudioWorkletNode(at.ctx, "bot-voice-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    // A silent path to the speakers keeps the recorder running.
    const sink = at.ctx.createGain();
    sink.gain.value = 0;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (rate !== at.ctx.sampleRate) chunks = [];
      rate = at.ctx.sampleRate;
      keepLast(chunks, e.data, rate * KEEP_SECONDS);
    };
    at.from.connect(node);
    node.connect(sink).connect(at.ctx.destination);
    recorder = { node, sink };
  } catch {
    // Recording is only for reports.
  } finally {
    starting = false;
  }
}

function stop() {
  if (!recorder) return;
  const { node, sink } = recorder;
  recorder = null;
  node.port.onmessage = null;
  try {
    output?.from.disconnect(node);
  } catch {
    // Already disconnected.
  }
  node.disconnect();
  sink.disconnect();
}

/** Adds a piece and drops the oldest ones beyond `max` samples (at least `max` are kept once there). */
export function keepLast(list: Float32Array[], piece: Float32Array, max: number) {
  list.push(piece);
  let total = list.reduce((n, p) => n + p.length, 0);
  while (list.length > 1 && total - list[0].length >= max) total -= list.shift()!.length;
}

/** The last seconds of the bot's voice; null when nothing was recorded (or diagnostics is off). */
export function lastBotVoice(): { samples: Float32Array; rate: number } | null {
  if (!wanted()) chunks = [];
  if (!chunks.length) return null;
  const samples = new Float32Array(chunks.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of chunks) {
    samples.set(piece, at);
    at += piece.length;
  }
  const max = rate * KEEP_SECONDS;
  return { samples: samples.length > max ? samples.slice(samples.length - max) : samples, rate };
}

/** 16-bit mono WAV. */
export function wavFile(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 0x7fff), true);
  return out;
}
