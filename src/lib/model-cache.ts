// Model files for the on-device workers that run ONNX Runtime directly: downloaded once (with
// progress) and kept in IndexedDB with the other models, so after that they work offline.
import { createStore, get, keys, set } from "idb-keyval";

const files = createStore("adtbot-models", "files");

/** URLs already cached (to skip reading big files back just to count them). */
export async function cachedUrls(): Promise<Set<string>> {
  return new Set((await keys(files)) as string[]);
}

/** A file from the cache, or downloaded (reporting bytes as they arrive) and cached. */
export async function fetchCached(url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const hit = await get<{ body: ArrayBuffer }>(url, files);
  if (hit) {
    onBytes?.(hit.body.byteLength);
    return hit.body;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the model (${res.status})`);
  // Straight into one buffer of the announced size (no second copy of a large file).
  const expected = Number(res.headers.get("content-length")) || 0;
  let body = new Uint8Array(expected || 1 << 20);
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > body.length) {
      const grown = new Uint8Array(Math.max(body.length * 2, size + value.length));
      grown.set(body.subarray(0, size));
      body = grown;
    }
    body.set(value, size);
    size += value.length;
    onBytes?.(value.length);
  }
  const bytes = size === body.length ? body.buffer : body.slice(0, size).buffer;
  await set(url, { body: bytes, type: "application/octet-stream" }, files);
  return bytes;
}
