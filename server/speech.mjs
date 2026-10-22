// Voice mode's speech on this server: speech-to-text (Whisper) and a natural voice (Kokoro) from a
// speech container (speaches, OpenAI-compatible), so laptops and phones don't run the models.
// On when ADT_SPEECH_URL is set (e.g. http://speech:8000). The app sends the server token
// (ADT_SPEECH_TOKEN, or ADT_AGENT_TOKEN): this relay is the only way in, the container stays private.
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

/** Speech models the server offers unless told otherwise (small enough for a free 4-core server). */
export const SPEECH_DEFAULTS = {
  stt: "Systran/faster-whisper-base",
  tts: "speaches-ai/Kokoro-82M-v1.0-ONNX",
  voice: "af_heart",
};

/** A long utterance as 16 kHz WAV is a few MB; a sentence of text is far under the text limit. */
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const ROUTES = {
  "/api/speech/v1/audio/transcriptions": MAX_AUDIO,
  "/api/speech/v1/audio/speech": MAX_TEXT,
};

const sameSecret = (a, b) => {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
};

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {{ upstream: string, token: string, stt?: string, tts?: string, voice?: string, fetchImpl?: typeof fetch, log?: (message: string) => void }} options
 */
export function createSpeechRelay({ upstream, token, stt = SPEECH_DEFAULTS.stt, tts = SPEECH_DEFAULTS.tts, voice = SPEECH_DEFAULTS.voice, fetchImpl = fetch, log = console.log }) {
  if (!token || token.length < 24) throw new Error("ADT_SPEECH_TOKEN (or ADT_AGENT_TOKEN) must be at least 24 characters.");
  const base = String(upstream).replace(/\/+$/, "");
  /** Which of the two models are downloaded and ready on the speech container. */
  const ready = { stt: false, tts: false };
  let preparing = null;

  const reply = (res, status, body) => {
    res.writeHead(status, { ...CORS, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  /** Downloads the models the app will ask for, once the container answers (it may still be starting). */
  const prepare = () =>
    (preparing ??= (async () => {
      for (let attempt = 0; attempt < 60 && !(ready.stt && ready.tts); attempt++) {
        try {
          const list = await fetchImpl(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
          const have = new Set((list.data ?? []).map((m) => m.id));
          for (const [kind, id] of [
            ["stt", stt],
            ["tts", tts],
          ]) {
            if (have.has(id)) ready[kind] = true;
            else if (!ready[kind]) {
              log(`Downloading the speech model ${id}…`);
              const r = await fetchImpl(`${base}/v1/models/${id}`, { method: "POST", signal: AbortSignal.timeout(15 * 60_000) });
              ready[kind] = r.ok;
              if (!r.ok) log(`The speech model ${id} couldn't be downloaded (${r.status}).`);
            }
          }
        } catch {
          // Not up yet.
        }
        if (!(ready.stt && ready.tts)) await new Promise((r) => setTimeout(r, 5000));
      }
      preparing = null;
    })());

  return {
    prepare,
    ready: () => ({ ...ready }),
    async handle(req, res, next) {
      const path = (req.url ?? "").split("?")[0];
      if (!path.startsWith("/api/speech")) return next();
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!auth || !sameSecret(auth, token)) return reply(res, 401, { error: "Wrong or missing server token." });
      // What the app needs to set itself up: the models and voice to ask for, and whether they're ready.
      if (path === "/api/speech" && req.method === "GET") {
        if (!(ready.stt && ready.tts)) void prepare();
        return reply(res, 200, { ok: true, stt, tts, voice, ready: { ...ready } });
      }
      const max = ROUTES[path];
      if (!max) return reply(res, 404, { error: "Not found." });
      if (req.method !== "POST") return reply(res, 405, { error: "Use POST." });
      if (Number(req.headers["content-length"] ?? 0) > max) return reply(res, 413, { error: "Too large." });
      let body;
      try {
        body = await readBody(req, max);
      } catch (error) {
        return reply(res, error.status ?? 400, { error: error.status === 413 ? "Too large." : "Couldn't read the request." });
      }
      let answer;
      try {
        answer = await fetchImpl(`${base}${path.slice("/api/speech".length)}`, {
          method: "POST",
          headers: { "content-type": String(req.headers["content-type"] ?? "application/octet-stream") },
          body,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        return reply(res, 502, { error: `The speech server isn't answering (${error.message}).` });
      }
      res.writeHead(answer.status, { ...CORS, "content-type": answer.headers.get("content-type") ?? "application/octet-stream" });
      if (!answer.body) return res.end();
      Readable.fromWeb(answer.body).pipe(res);
    },
  };
}
