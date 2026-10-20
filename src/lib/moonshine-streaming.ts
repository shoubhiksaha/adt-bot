// Live captions with Moonshine streaming (Moonshine AI, MIT): the rules of its incremental runtime,
// kept free of workers and ONNX Runtime so they can be unit-tested. The model runs in
// caption.worker.ts; the steps follow Moonshine's own streaming runtime (core/moonshine-streaming-model.cpp).

/**
 * English "tiny" model, exported to plain ONNX in the five graphs the streaming runtime drives (MIT),
 * pinned to the export this was written against. 8-bit graphs: on the CPU they ran faster than
 * full precision here.
 */
export const CAPTION_MODEL = "https://huggingface.co/Masterx/moonshine-streaming-tiny-ONNX/resolve/e63ede138516bea634dab385e82b645a8f4f614f";
export const CAPTION_FILES = {
  frontend: "frontend.onnx",
  encoder: "encoder_int8.onnx",
  adapter: "adapter_int8.onnx",
  crossKv: "cross_kv_int8.onnx",
  decoder: "decoder_kv_int8.onnx",
} as const;
/** Download size of the graphs and the tokenizer. */
export const CAPTION_MB = 78;

export type StreamingConfig = {
  encoder_dim: number;
  decoder_dim: number;
  depth: number;
  nheads: number;
  head_dim: number;
  vocab_size: number;
  bos_id: number;
  eos_id: number;
  total_lookahead: number;
  d_model_frontend: number;
  c1: number;
};

/** The frontend reads audio in whole 40 ms steps; the rest waits for the next chunk. */
export const FRONTEND_STEP = 640;

/**
 * Which encoder frames to run: frames become stable once `total_lookahead` newer ones exist (all of
 * them at the end), and the encoder sees 16 frames of left context per layer before the new ones.
 */
export function encoderWindow(featureCount: number, emitted: number, config: Pick<StreamingConfig, "total_lookahead" | "depth">, final: boolean) {
  const stable = final ? featureCount : Math.max(0, featureCount - config.total_lookahead);
  const start = Math.max(0, emitted - 16 * config.depth);
  return { stable, fresh: stable - emitted, start, size: featureCount - start, offset: emitted - start };
}

/** At most 6.5 tokens per second of audio (memory frames are 20 ms each). */
export const maxTokens = (memoryFrames: number) => Math.ceil(memoryFrames * 0.02 * 6.5);

/** How many tokens of the previous transcript the model still agrees with (its predictions after BOS + draft). */
export function agreedPrefix(draft: number[], predictions: number[]): number {
  let n = 0;
  while (n < draft.length && predictions[n] === draft[n]) n++;
  return n;
}

/** Token strings by id from tokenizer.json; special tokens (BOS, EOS, added markers) become "". */
export function vocabulary(tokenizer: { model: { vocab: Record<string, number> }; added_tokens?: { id: number; content: string; special?: boolean }[] }): string[] {
  const vocab: string[] = [];
  for (const [token, id] of Object.entries(tokenizer.model.vocab)) vocab[id] = token;
  for (const t of tokenizer.added_tokens ?? []) vocab[t.id] = t.special ? "" : t.content;
  return vocab;
}

/** Tokens to text, as the tokenizer's decoder does: "▁" is a space, <0xNN> are UTF-8 bytes, one leading space dropped. */
export function decodeTokens(ids: number[], vocab: string[]): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const id of ids) {
    const token = vocab[id] ?? "";
    const byte = /^<0x([0-9A-Fa-f]{2})>$/.exec(token);
    if (byte) bytes.push(parseInt(byte[1], 16));
    else bytes.push(...encoder.encode(token.replaceAll("▁", " ")));
  }
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return text.startsWith(" ") ? text.slice(1) : text;
}
