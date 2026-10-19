import { describe, expect, it } from "vitest";
import { CLOUD_TTS } from "./tts";

const config = (model = "", voice = "v1") => ({ key: "k", voice, model });

describe("natural-voice services", () => {
  it("Fish Audio: bearer key, model header, mp3 with the chosen voice", () => {
    const r = CLOUD_TTS.fish.request("Hi there", config("s1"), 1.1);
    expect(r.url).toBe("https://api.fish.audio/v1/tts");
    expect(r.headers).toMatchObject({ authorization: "Bearer k", model: "s1" });
    expect(JSON.parse(r.body)).toMatchObject({ text: "Hi there", format: "mp3", reference_id: "v1", prosody: { speed: 1.1 } });
    expect(JSON.parse(CLOUD_TTS.fish.request("x", config("", ""), 1).body).reference_id).toBeUndefined();
    expect(CLOUD_TTS.fish.request("x", config(), 1).headers.model).toBe("s2.1-pro");
  });

  it("Cartesia: versioned header, voice id, mp3 output, clamped speed", () => {
    const r = CLOUD_TTS.cartesia.request("Hi", config(), 3);
    expect(r.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(r.headers).toMatchObject({ authorization: "Bearer k", "cartesia-version": expect.any(String) });
    expect(JSON.parse(r.body)).toMatchObject({ model_id: "sonic-3.6", transcript: "Hi", voice: { id: "v1" }, output_format: { container: "mp3" }, generation_config: { speed: 1.5 } });
    expect(CLOUD_TTS.cartesia.voiceRequired).toBe(true);
  });

  it("Deepgram: Token auth, model and mp3 in the query", () => {
    const r = CLOUD_TTS.deepgram.request("Hi", config("aura-2-orion-en"), 1);
    expect(r.url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-orion-en&encoding=mp3");
    expect(r.headers.authorization).toBe("Token k");
    expect(JSON.parse(r.body)).toEqual({ text: "Hi" });
  });
});
