// @vitest-environment node
// Voice mode's speech on the server: only with the server token, models fetched once the speech
// container answers, audio and text passed through, and the container itself never exposed.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./index.mjs";
import { createSpeechRelay } from "./speech.mjs";

const TOKEN = "t".repeat(32);
const servers = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop().close(r));
});

/** A stand-in speech container: OpenAI-style transcription and speech, plus model downloads. */
async function container() {
  const calls = [];
  const models = new Set();
  const server = createServer(async (req, res) => {
    let body = Buffer.alloc(0);
    for await (const c of req) body = Buffer.concat([body, c]);
    calls.push({ method: req.method, url: req.url, type: req.headers["content-type"], auth: req.headers.authorization, size: body.length });
    if (req.url === "/v1/models" && req.method === "GET") return res.end(JSON.stringify({ data: [...models].map((id) => ({ id })) }));
    if (req.url.startsWith("/v1/models/") && req.method === "POST") {
      models.add(req.url.slice("/v1/models/".length));
      return res.end("{}");
    }
    if (req.url === "/v1/audio/transcriptions") return res.end(JSON.stringify({ text: `heard ${body.length} bytes` }));
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(Buffer.from("ID3fake-mp3"));
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, models };
}

async function serverWithSpeech(upstream) {
  const speech = createSpeechRelay({ upstream, token: TOKEN, log: () => undefined });
  const { server, url } = await startServer({ port: 0, distDir: "/nonexistent-dist", speech });
  servers.push(server);
  return { url, speech };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("speech on the server", () => {
  it("needs the server token for everything", async () => {
    const c = await container();
    const { url } = await serverWithSpeech(c.url);
    expect((await fetch(`${url}/api/speech`)).status).toBe(401);
    expect((await fetch(`${url}/api/speech`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${url}/api/speech/v1/audio/speech`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(c.calls).toHaveLength(0);
    expect(() => createSpeechRelay({ upstream: c.url, token: "short" })).toThrow(/24 characters/);
  });

  it("downloads its two models once the container answers, and says what to ask for", async () => {
    const c = await container();
    const { url, speech } = await serverWithSpeech(c.url);
    await speech.prepare();
    expect([...c.models].sort()).toEqual(["Systran/faster-whisper-base", "speaches-ai/Kokoro-82M-v1.0-ONNX"]);
    const info = await (await fetch(`${url}/api/speech`, { headers: auth })).json();
    expect(info).toEqual({ ok: true, stt: "Systran/faster-whisper-base", tts: "speaches-ai/Kokoro-82M-v1.0-ONNX", voice: "af_heart", ready: { stt: true, tts: true } });
    // Already there: not downloaded again.
    const downloads = c.calls.filter((x) => x.method === "POST").length;
    await createSpeechRelay({ upstream: c.url, token: TOKEN, log: () => undefined }).prepare();
    expect(c.calls.filter((x) => x.method === "POST")).toHaveLength(downloads);
  });

  it("passes audio in and speech out, without the app's token reaching the container", async () => {
    const c = await container();
    const { url } = await serverWithSpeech(c.url);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(1000)], { type: "audio/wav" }), "speech.wav");
    form.append("model", "Systran/faster-whisper-base");
    const heard = await fetch(`${url}/api/speech/v1/audio/transcriptions`, { method: "POST", headers: auth, body: form });
    expect(heard.status).toBe(200);
    expect((await heard.json()).text).toMatch(/^heard \d+ bytes$/);
    const spoken = await fetch(`${url}/api/speech/v1/audio/speech`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ input: "Hi", model: "m", voice: "af_heart" }) });
    expect(spoken.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await spoken.arrayBuffer()).toString()).toBe("ID3fake-mp3");
    const relayed = c.calls.filter((x) => x.url.startsWith("/v1/audio/"));
    expect(relayed.map((x) => x.url)).toEqual(["/v1/audio/transcriptions", "/v1/audio/speech"]);
    expect(relayed[0].type).toMatch(/^multipart\/form-data; boundary=/);
    expect(relayed.every((x) => x.auth === undefined)).toBe(true);
  });

  it("only relays speech: no model list, downloads or other container paths from outside", async () => {
    const c = await container();
    const { url } = await serverWithSpeech(c.url);
    expect((await fetch(`${url}/api/speech/v1/models`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${url}/api/speech/v1/models/x`, { method: "POST", headers: auth })).status).toBe(404);
    expect((await fetch(`${url}/api/speech/v1/audio/speech`, { headers: auth })).status).toBe(405);
    const big = await fetch(`${url}/api/speech/v1/audio/speech`, { method: "POST", headers: auth, body: "x".repeat(70 * 1024) });
    expect(big.status).toBe(413);
    expect(c.calls.filter((x) => x.url.startsWith("/v1/audio/"))).toHaveLength(0);
  });

  it("says so when the speech container is down", async () => {
    const { url } = await serverWithSpeech("http://127.0.0.1:9");
    const r = await fetch(`${url}/api/speech/v1/audio/speech`, { method: "POST", headers: auth, body: "{}" });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/speech server isn't answering/);
  });
});
