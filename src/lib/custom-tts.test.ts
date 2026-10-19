// @vitest-environment node
import { describe, expect, it } from "vitest";
import { audioFromJson, buildCustomRequest, CUSTOM_VOICE_TEMPLATES, newCustomVoice, parseHeaderLines } from "./custom-tts";

const tricky = 'She said "hi" & left <now>\nok';

describe("custom voice services", () => {
  it("fills JSON bodies safely and keeps the key in headers only", () => {
    const v = { ...newCustomVoice("sarvam"), key: "sk-1" };
    const r = buildCustomRequest(v, tricky, 1.25);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ text: tricky, speaker: "anushka", model: "bulbul:v3", pace: 1.25, output_audio_codec: "mp3" });
    expect(r.headers["api-subscription-key"]).toBe("sk-1");
    expect(r.url).toBe("https://api.sarvam.ai/text-to-speech");
  });

  it("escapes text for SSML (Azure)", () => {
    const r = buildCustomRequest({ ...newCustomVoice("azure"), key: "k" }, tricky, 1);
    expect(r.body).toContain("She said &quot;hi&quot; &amp; left &lt;now&gt;");
    expect(r.headers["Ocp-Apim-Subscription-Key"]).toBe("k");
  });

  it("Google template parses and reads audioContent", () => {
    const r = buildCustomRequest({ ...newCustomVoice("google"), key: "g" }, "Hello", 1);
    expect(JSON.parse(r.body)).toMatchObject({ input: { text: "Hello" }, voice: { name: "en-US-Neural2-F" }, audioConfig: { audioEncoding: "MP3" } });
    const audio = audioFromJson({ audioContent: btoa("ID3abc") }, CUSTOM_VOICE_TEMPLATES.google.audioPath);
    expect(new TextDecoder().decode(audio)).toBe("ID3abc");
  });

  it("reads nested and array paths, and explains a missing one", () => {
    expect(new TextDecoder().decode(audioFromJson({ audios: [btoa("x1")] }, "audios.0"))).toBe("x1");
    expect(new TextDecoder().decode(audioFromJson({ data: { audio: `data:audio/mp3;base64,${btoa("y2")}` } }, "data.audio"))).toBe("y2");
    expect(() => audioFromJson({}, "audio")).toThrow(/No audio at "audio"/);
  });

  it("encodes values placed in the URL and strips newlines from headers", () => {
    const v = { ...newCustomVoice("blank"), url: "https://tts.example.com/speak?voice={{voice}}&q={{text}}", voice: "a b", headers: "x-key: {{key}}", key: "k\nInjected: 1" };
    const r = buildCustomRequest(v, "a&b", 1);
    expect(r.url).toBe("https://tts.example.com/speak?voice=a%20b&q=a%26b");
    expect(r.headers).toEqual({ "x-key": "kInjected: 1" });
    expect(parseHeaderLines("# note\nA: 1\nbad line\nB:2")).toEqual([["A", "1"], ["B", "2"]]);
  });
});
