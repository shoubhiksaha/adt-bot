// Live captions while the user talks (English): Moonshine streaming tiny (Moonshine AI, MIT) keeps
// what it has heard and only reads the new audio each time, where Whisper and Moonshine would read
// the whole clip again for every caption. Started by the speech worker, on its own thread, so a
// caption never holds up the voice detector or the real transcription.
import * as ort from "onnxruntime-web/webgpu";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { fetchCached } from "./model-cache";
import {
  agreedPrefix,
  CAPTION_FILES,
  CAPTION_MODEL,
  decodeTokens,
  encoderWindow,
  FRONTEND_STEP,
  maxTokens,
  type StreamingConfig,
  vocabulary,
} from "./moonshine-streaming";

ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// One thread: captions run every ~600 ms while the user talks; idle pool threads would busy-wait.
ort.env.wasm.numThreads = 1;

const post = (message: Record<string, unknown>) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

type Sessions = Record<keyof typeof CAPTION_FILES, ort.InferenceSession>;
type Model = { config: StreamingConfig; vocab: string[]; s: Sessions };

let ready: Promise<Model> | null = null;
function load(): Promise<Model> {
  ready ??= (async () => {
    const json = async (name: string) => JSON.parse(new TextDecoder().decode(await fetchCached(`${CAPTION_MODEL}/${name}`)));
    const [config, tokenizer] = await Promise.all([json("streaming_config.json"), json("tokenizer.json")]);
    const s = {} as Sessions;
    for (const [key, file] of Object.entries(CAPTION_FILES) as [keyof Sessions, string][]) {
      s[key] = await ort.InferenceSession.create(new Uint8Array(await fetchCached(`${CAPTION_MODEL}/${file}`)), { executionProviders: ["wasm"] });
    }
    const model: Model = { config, vocab: vocabulary(tokenizer), s };
    // Warm-up, so the first caption isn't slowed by kernel compilation.
    const warm = new Stream(model);
    await warm.push(new Float32Array(16000));
    await warm.encode(true);
    await warm.decode();
    return model;
  })();
  ready.catch(() => (ready = null));
  return ready;
}

const f32 = (data: Float32Array, dims: number[]) => new ort.Tensor("float32", data, dims);

/** One utterance: the frontend and encoder carry their state from chunk to chunk; the decoder re-reads. */
class Stream {
  private state: Record<string, ort.Tensor>;
  private features = new Float32Array(0);
  private featureCount = 0;
  private emitted = 0;
  private memory = new Float32Array(0);
  private memoryFrames = 0;
  private cross: { k_cross: ort.Tensor; v_cross: ort.Tensor } | null = null;
  private pending = new Float32Array(0);
  /** The last transcript, checked as a draft by the next decode. */
  tokens: number[] = [];

  constructor(private model: Model) {
    const c = model.config;
    this.state = {
      sample_buffer: f32(new Float32Array(79), [1, 79]),
      sample_len: new ort.Tensor("int64", BigInt64Array.of(0n), [1]),
      conv1_buffer: f32(new Float32Array(c.d_model_frontend * 4), [1, c.d_model_frontend, 4]),
      conv2_buffer: f32(new Float32Array(c.c1 * 4), [1, c.c1, 4]),
      frame_count: new ort.Tensor("int64", BigInt64Array.of(0n), [1]),
    };
  }

  async push(samples: Float32Array) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    const usable = all.length - (all.length % FRONTEND_STEP);
    this.pending = all.slice(usable);
    if (!usable) return;
    const out = await this.model.s.frontend.run({ audio_chunk: f32(all.slice(0, usable), [1, usable]), ...this.state });
    for (const name of Object.keys(this.state)) this.state[name] = out[`${name}_out`];
    const n = out.features.dims[1];
    if (!n) return;
    const grown = new Float32Array(this.features.length + out.features.data.length);
    grown.set(this.features);
    grown.set(out.features.data as Float32Array, this.features.length);
    this.features = grown;
    this.featureCount += n;
  }

  async encode(final: boolean) {
    const { config: c, s } = this.model;
    const w = encoderWindow(this.featureCount, this.emitted, c, final);
    if (w.fresh <= 0) return;
    const D = c.encoder_dim;
    const { encoded } = await s.encoder.run({ features: f32(this.features.slice(w.start * D, (w.start + w.size) * D), [1, w.size, D]) });
    const slice = (encoded.data as Float32Array).slice(w.offset * D, (w.offset + w.fresh) * D);
    const { memory } = await s.adapter.run({ encoded: f32(slice, [1, w.fresh, D]), pos_offset: new ort.Tensor("int64", BigInt64Array.of(BigInt(this.emitted)), [1]) });
    const grown = new Float32Array(this.memory.length + memory.data.length);
    grown.set(this.memory);
    grown.set(memory.data as Float32Array, this.memory.length);
    this.memory = grown;
    this.memoryFrames += w.fresh;
    this.emitted = w.stable;
    this.cross = null;
  }

  /** Greedy decoding from the start, keeping as much of the last transcript as the model still agrees with. */
  async decode(): Promise<number[]> {
    const { config: c, s } = this.model;
    if (!this.memoryFrames) return [];
    this.cross ??= (await s.crossKv.run({ memory: f32(this.memory, [1, this.memoryFrames, c.decoder_dim]) })) as { k_cross: ort.Tensor; v_cross: ort.Tensor };
    const empty = (): ort.Tensor => f32(new Float32Array(0), [c.depth, 1, c.nheads, 0, c.head_dim]);
    let k = empty();
    let v = empty();
    const step = async (tokens: number[]): Promise<number[]> => {
      const out = await s.decoder.run({
        token: new ort.Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length]),
        k_self: k,
        v_self: v,
        out_k_cross: this.cross!.k_cross,
        out_v_cross: this.cross!.v_cross,
      });
      k = out.out_k_self;
      v = out.out_v_self;
      const logits = out.logits.data as Float32Array;
      const V = c.vocab_size;
      return tokens.map((_, t) => {
        let best = 0;
        for (let i = 1, base = t * V; i < V; i++) if (logits[base + i] > logits[base + best]) best = i;
        return best;
      });
    };
    const draft = this.tokens;
    const result: number[] = [];
    let next: number;
    if (draft.length) {
      const predictions = await step([c.bos_id, ...draft]);
      const agreed = agreedPrefix(draft, predictions);
      result.push(...draft.slice(0, agreed));
      if (agreed === draft.length) next = predictions[agreed];
      else {
        k = empty();
        v = empty();
        next = (await step([c.bos_id, ...result])).at(-1)!;
      }
    } else next = (await step([c.bos_id]))[0];
    const max = maxTokens(this.memoryFrames);
    while (next !== c.eos_id && result.length < max) {
      result.push(next);
      next = (await step([next]))[0];
    }
    this.tokens = result;
    return result;
  }
}

// Messages: "load"; "audio" (new samples of utterance `utterance`, caption wanted); "reset".
// Audio that arrives while a caption is being made is read together for the next one.
let stream: { id: number; s: Stream } | null = null;
let queued: { id: number; samples: Float32Array[] } | null = null;
let busy = false;

async function caption() {
  if (busy || !queued) return;
  busy = true;
  try {
    while (queued) {
      const { id, samples } = queued;
      queued = null;
      const model = await load();
      if (stream?.id !== id) stream = { id, s: new Stream(model) };
      const current = stream;
      for (const chunk of samples) await current.s.push(chunk);
      await current.s.encode(false);
      const tokens = await current.s.decode();
      // Not if the utterance ended meanwhile, or more of it is waiting (its caption comes next).
      if (stream === current && !queued) post({ type: "caption", utterance: id, text: decodeTokens(tokens, model.vocab).trim() });
    }
  } catch (error) {
    stream = null;
    post({ type: "failed", message: (error as Error).message ?? String(error) });
  } finally {
    busy = false;
  }
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (data.type === "load") {
    load().then(
      () => post({ type: "ready" }),
      (error: Error) => post({ type: "failed", message: error.message ?? String(error) }),
    );
  } else if (data.type === "audio") {
    // More of the same utterance joins what's waiting; a new utterance replaces it.
    if (queued && queued.id === data.utterance) queued.samples.push(data.samples);
    else queued = { id: data.utterance, samples: [data.samples] };
    void caption();
  } else if (data.type === "reset") {
    queued = null;
    stream = null;
  }
};
