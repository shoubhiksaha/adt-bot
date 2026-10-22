// "Use my server for voice": one step points speech-to-text and the reply voice at the always-on
// server, never makes bots chat through it, and says clearly when the server can't do it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ status: 200, body: {} as unknown, calls: [] as { url: string; auth?: string }[] }));
vi.mock("./transport", () => ({
  providerFetch: async (url: string, init: RequestInit) => {
    http.calls.push({ url, auth: (init.headers as Record<string, string>)?.authorization });
    return new Response(JSON.stringify(http.body), { status: http.status });
  },
}));

const { defaultSettings, useStore } = await import("./store");
const { SERVER_VOICE_ID, switchToDeviceVoice, switchToServerVoice, usingServerVoice } = await import("./server-voice");

const chatProvider = { id: "chat", presetId: "anthropic", name: "Anthropic", kind: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "k", models: [] };

beforeEach(() => {
  http.status = 200;
  http.body = { ok: true, stt: "Systran/faster-whisper-base", tts: "speaches-ai/Kokoro-82M-v1.0-ONNX", voice: "af_heart", ready: { stt: true, tts: true } };
  http.calls = [];
  useStore.setState({
    providers: [chatProvider],
    settings: { ...defaultSettings, server: { url: "https://adt.example.ts.net/", token: "t".repeat(48) } },
  });
});

describe("speech on your server", () => {
  it("points speech-to-text and the reply voice at the server, with its token", async () => {
    expect(await switchToServerVoice()).toEqual({ ready: true });
    expect(http.calls).toEqual([{ url: "https://adt.example.ts.net/api/speech", auth: `Bearer ${"t".repeat(48)}` }]);
    const { providers, settings, bots } = useStore.getState();
    const speech = providers.find((p) => p.id === SERVER_VOICE_ID)!;
    expect(speech).toMatchObject({ kind: "openai", baseUrl: "https://adt.example.ts.net/api/speech/v1", apiKey: "t".repeat(48) });
    expect(settings.voice).toMatchObject({ engine: "whisper-cloud", providerId: SERVER_VOICE_ID, model: "Systran/faster-whisper-base", tts: `custom:${SERVER_VOICE_ID}` });
    const voice = settings.voice.customVoices.find((v) => v.id === SERVER_VOICE_ID)!;
    expect(voice).toMatchObject({ url: "https://adt.example.ts.net/api/speech/v1/audio/speech", key: "t".repeat(48), voice: "af_heart", model: "speaches-ai/Kokoro-82M-v1.0-ONNX", response: "audio" });
    expect(JSON.parse(voice.body.replace("{{speed}}", "1"))).toMatchObject({ input: "{{text}}", voice: "{{voice}}" });
    // Bots keep chatting through their own provider.
    expect(bots.every((b) => b.providerId !== SERVER_VOICE_ID)).toBe(true);
    expect(usingServerVoice()).toBe(true);
    // Twice: still one entry each.
    await switchToServerVoice();
    expect(useStore.getState().providers.filter((p) => p.id === SERVER_VOICE_ID)).toHaveLength(1);
    expect(useStore.getState().settings.voice.customVoices.filter((v) => v.id === SERVER_VOICE_ID)).toHaveLength(1);
    switchToDeviceVoice();
    expect(useStore.getState().settings.voice).toMatchObject({ engine: "auto", tts: "system" });
    expect(usingServerVoice()).toBe(false);
  });

  it("says when models are still downloading, and why it can't when it can't", async () => {
    http.body = { ...(http.body as object), ready: { stt: true, tts: false } };
    expect(await switchToServerVoice()).toEqual({ ready: false });
    http.status = 401;
    await expect(switchToServerVoice()).rejects.toThrow(/refused the token/);
    http.status = 404;
    await expect(switchToServerVoice()).rejects.toThrow(/doesn't run speech yet/);
    useStore.setState({ settings: { ...useStore.getState().settings, server: { url: "", token: "" } } });
    await expect(switchToServerVoice()).rejects.toThrow(/Connect your always-on server first/);
  });
});
