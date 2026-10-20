/**
 * The on-device embedding model behind "Smarter memory search". It turns text into vectors so
 * memories and knowledge passages can be found by meaning ("my sister" finds "Riya is my sibling"),
 * in any of its languages, without sending anything off the device.
 *
 * Granite Embedding 97M Multilingual R2 (IBM, Apache-2.0): 52 languages with retrieval training,
 * Hindi, Bengali, Marathi, Telugu and Urdu among them (others, like Tamil, work less well), 98 MB at
 * 8 bits plus a 25 MB tokenizer, and it runs on ONNX Runtime's WebAssembly backend on every
 * platform. EmbeddingGemma 2 ranked better in our tests, but its quantized files use an operator
 * (GatherBlockQuantized with 64-bit indices) that the WebAssembly build doesn't have.
 */
export const EMBEDDING_MODEL = {
  /** Stored with every vector: vectors from another model (or revision) are never mixed in. */
  id: "granite-embedding-97m-multilingual-r2@536a9f2",
  repo: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
  /** Pinned, so an upstream re-export can't silently change the vectors already stored. */
  revision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
  /** The file that marks the model as downloaded (the "q8" weights). */
  weights: "onnx/model_quantized.onnx",
  dtype: "q8",
  pooling: "cls",
  dims: 384,
  /** Download size, for the setting's label. */
  mb: 123,
  /** Granite needs no "query:"/"passage:" prefixes. */
  prefix: { query: "", passage: "" },
  /**
   * Its cosine scores sit close together (unrelated notes ~0.69, the right one ~0.82 in our test
   * set), so a passage counts as a semantic match only within this distance of the best one.
   */
  window: 0.1,
} as const;

/** Longer input is cut: passages are ~1,200 characters and memories are short; this keeps a stray huge one fast. */
export const EMBED_MAX_CHARS = 4000;
