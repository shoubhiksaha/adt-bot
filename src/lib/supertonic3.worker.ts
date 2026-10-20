// On-device natural voice in 31 languages: Supertonic 3 (Supertone, OpenRAIL-M model), run directly
// on ONNX Runtime (transformers.js doesn't know this version). The steps follow Supertone's
// MIT-licensed web/helper.js: duration → text encoder → a few denoising steps → vocoder. Model files
// are cached in IndexedDB like the other on-device models, so after the first download it works offline.
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { splitLongText } from "./local-tts-voices";
import { cachedUrls, fetchCached } from "./model-cache";
import { supertonicIds, supertonicLanguage, supertonicText } from "./supertonic-text";

// Use the copies of ONNX Runtime bundled with the app, so nothing is fetched from a CDN.
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

/** Pinned to the release the code was written for (the repository is archived). */
const BASE = "https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323";
const GRAPHS = ["duration_predictor", "text_encoder", "vector_estimator", "vocoder"] as const;
/** Download sizes, for progress before the server reports them. */
const SIZES: Record<(typeof GRAPHS)[number], number> = {
  duration_predictor: 3_700_147,
  text_encoder: 36_416_150,
  vector_estimator: 256_534_781,
  vocoder: 101_424_195,
};
const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

type Config = { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } };
type Model = {
  config: Config;
  indexer: number[];
  sessions: Record<(typeof GRAPHS)[number], ort.InferenceSession>;
  device: "webgpu" | "wasm";
};

/** The GPU when WebGPU works here (several times faster for the denoiser), otherwise the CPU. */
const gpuAvailable: Promise<boolean> = (async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(await gpu?.requestAdapter());
  } catch {
    return false;
  }
})();

let ready: Promise<Model> | null = null;
/** The voice the user picked, so warming up doesn't download one they never use. */
let warmVoice = "F1";

function load(): Promise<Model> {
  ready ??= (async () => {
    const total = Object.values(SIZES).reduce((a, b) => a + b, 0);
    let loaded = 0;
    const progress = (n: number) => {
      loaded += n;
      post({ type: "progress", progress: Math.min(99, (loaded / total) * 100) });
    };
    const [config, indexer] = await Promise.all([
      fetchCached(`${BASE}/onnx/tts.json`).then((b) => JSON.parse(new TextDecoder().decode(b)) as Config),
      fetchCached(`${BASE}/onnx/unicode_indexer.json`).then((b) => JSON.parse(new TextDecoder().decode(b)) as number[]),
    ]);
    // Download what's missing first, then read each file back only to open it: on a small Mac the
    // 400 MB of graphs never sit in memory together.
    const cached = await cachedUrls();
    const graph = (name: (typeof GRAPHS)[number]) => `${BASE}/onnx/${name}.onnx`;
    for (const name of GRAPHS) {
      if (cached.has(graph(name))) progress(SIZES[name]);
      else await fetchCached(graph(name), progress);
    }
    const embedding = await voice(warmVoice);
    const open = async (device: "webgpu" | "wasm") => {
      const sessions = {} as Model["sessions"];
      try {
        for (const name of GRAPHS) {
          sessions[name] = await ort.InferenceSession.create(new Uint8Array(await fetchCached(graph(name))), { executionProviders: [device] });
        }
        const model: Model = { config, indexer, sessions, device };
        // Warm-up: compiles the GPU kernels, so the first real sentence isn't slow.
        await synthesize(model, supertonicText("Hi.", "en"), embedding, 2, 1);
        return model;
      } catch (error) {
        await Promise.all(Object.values(sessions).map((s) => s.release().catch(() => undefined)));
        throw error;
      }
    };
    let model: Model;
    try {
      model = await open((await gpuAvailable) ? "webgpu" : "wasm");
    } catch (error) {
      if (!(await gpuAvailable)) throw error;
      model = await open("wasm");
    }
    post({ type: "progress", progress: 100 });
    return model;
  })();
  ready.catch(() => (ready = null));
  return ready;
}

type Style = { ttl: ort.Tensor; dp: ort.Tensor };
type StyleJson = { style_ttl: { data: unknown[]; dims: number[] }; style_dp: { data: unknown[]; dims: number[] } };

/** Voice styles, loaded once each. */
const voices = new Map<string, Promise<Style>>();
function voice(id: string): Promise<Style> {
  const name = VOICES.includes(id) ? id : "F1";
  let style = voices.get(name);
  if (!style) {
    style = fetchCached(`${BASE}/voice_styles/${name}.json`).then((b) => {
      const json = JSON.parse(new TextDecoder().decode(b)) as StyleJson;
      const tensor = (t: StyleJson["style_ttl"]) => new ort.Tensor("float32", Float32Array.from(t.data.flat(Infinity) as number[]), t.dims);
      return { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) };
    });
    style.catch(() => voices.delete(name));
    voices.set(name, style);
  }
  return style;
}

/** Standard normal noise (Box–Muller). */
function noise(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(-2 * Math.log(Math.max(1e-4, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
  return out;
}

/** One piece of text (already in its language's tags) into audio. */
async function synthesize(model: Model, tagged: string, style: Style, steps: number, speed: number): Promise<Float32Array> {
  const { config, indexer, sessions } = model;
  const ids = supertonicIds(tagged, indexer);
  const textIds = new ort.Tensor("int64", ids, [1, ids.length]);
  const textMask = new ort.Tensor("float32", new Float32Array(ids.length).fill(1), [1, 1, ids.length]);
  const { duration } = await sessions.duration_predictor.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
  const seconds = ((await duration.getData()) as Float32Array)[0] / speed;
  const { text_emb } = await sessions.text_encoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
  const rate = config.ae.sample_rate;
  const chunk = config.ae.base_chunk_size * config.ttl.chunk_compress_factor;
  const samples = Math.max(1, Math.floor(seconds * rate));
  const length = Math.ceil(samples / chunk);
  const dim = config.ttl.latent_dim * config.ttl.chunk_compress_factor;
  let latent = noise(dim * length);
  const latentMask = new ort.Tensor("float32", new Float32Array(length).fill(1), [1, 1, length]);
  const total = new ort.Tensor("float32", Float32Array.of(steps), [1]);
  for (let step = 0; step < steps; step++) {
    const { denoised_latent } = await sessions.vector_estimator.run({
      noisy_latent: new ort.Tensor("float32", latent, [1, dim, length]),
      text_emb,
      style_ttl: style.ttl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor("float32", Float32Array.of(step), [1]),
      total_step: total,
    });
    latent = (await denoised_latent.getData()) as Float32Array;
  }
  const { wav_tts } = await sessions.vocoder.run({ latent: new ort.Tensor("float32", latent, [1, dim, length]) });
  // The vocoder pads to whole chunks; keep what the duration says.
  return ((await wav_tts.getData()) as Float32Array).slice(0, samples);
}

/** A sentence in the language it's written in; long ones in pieces with a short pause between. */
async function speak(text: string, voiceId: string, steps: number, speed: number): Promise<{ audio: Float32Array; sampleRate: number }> {
  const model = await load();
  const style = await voice(voiceId);
  const lang = supertonicLanguage(text, navigator.language || "en");
  const pieces = splitLongText(text, lang === "ko" || lang === "ja" ? 120 : 300);
  const rate = model.config.ae.sample_rate;
  const parts: Float32Array[] = [];
  for (const piece of pieces) {
    if (parts.length) parts.push(new Float32Array(Math.round(rate * 0.15)));
    parts.push(await synthesize(model, supertonicText(piece, lang), style, steps, speed));
  }
  const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    audio.set(p, offset);
    offset += p.length;
  }
  return { audio, sampleRate: rate };
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
        if (VOICES.includes(data.voice)) warmVoice = data.voice;
        const { device } = await load();
        await voice(data.voice ?? "F1");
        post({ id: data.id, type: "done", device });
      } else if (data.type === "speak") {
        if (cancelled.delete(data.id)) return post({ id: data.id, type: "skipped" });
        if (VOICES.includes(data.voice)) warmVoice = data.voice;
        // Fewer denoising steps = faster; the speed setting stretches the predicted durations.
        const speed = Math.min(1.6, Math.max(0.7, Number(data.speed) || 1)) * 1.05;
        const { audio, sampleRate } = await speak(String(data.text), data.voice, data.steps ?? 5, speed);
        if (cancelled.delete(data.id)) return post({ id: data.id, type: "skipped" });
        post({ id: data.id, type: "audio", audio, sampleRate }, [audio.buffer]);
      }
    } catch (error) {
      post({ id: data.id, type: "error", message: (error as Error).message ?? String(error) });
    }
  };
  queue = queue.then(run, run);
};
