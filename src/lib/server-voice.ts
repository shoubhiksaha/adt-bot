/**
 * Voice mode's speech on your always-on server (server/speech.mjs): speech-to-text and a natural
 * voice run there instead of on this device, which then only listens, detects speech and plays.
 * One step sets both up from the server's address and token (Settings → Sync & server).
 */
import type { CustomVoice } from "./custom-tts";
import { updateSettings, useStore } from "./store";
import { providerFetch } from "./transport";
import type { ProviderConfig } from "./types";

/** The provider (speech-to-text) and custom voice (speech) entries this creates, by id. */
export const SERVER_VOICE_ID = "adt-server-voice";

type ServerSpeech = { ok: boolean; stt: string; tts: string; voice: string; ready: { stt: boolean; tts: boolean } };

/** Whether voice mode uses the server's speech now. */
export function usingServerVoice(): boolean {
  const { voice } = useStore.getState().settings;
  return voice.engine === "whisper-cloud" && voice.providerId === SERVER_VOICE_ID && voice.tts === `custom:${SERVER_VOICE_ID}`;
}

/** Asks the server what it offers and points voice mode at it. Resolves with whether its models are downloaded yet. */
export async function switchToServerVoice(): Promise<{ ready: boolean }> {
  const { settings } = useStore.getState();
  const { url, token } = settings.server;
  if (!url || !token) throw new Error("Connect your always-on server first (Settings → Sync & server).");
  const base = url.trim().replace(/\/+$/, "");
  const res = await providerFetch(`${base}/api/speech`, { headers: { authorization: `Bearer ${token}` } }, settings.useProxy);
  if (res.status === 401) throw new Error("The server refused the token (check Settings → Sync & server).");
  if (res.status === 404) throw new Error("Your server doesn't run speech yet. Start it with the speech service (see deploy/README.md).");
  if (!res.ok) throw new Error(`The server said ${res.status}.`);
  const info = (await res.json()) as ServerSpeech;
  const provider: ProviderConfig = {
    id: SERVER_VOICE_ID,
    presetId: "private-openai",
    name: "My ADT server (voice)",
    kind: "openai",
    baseUrl: `${base}/api/speech/v1`,
    apiKey: token,
    models: [],
    updatedAt: Date.now(),
  };
  const voice: CustomVoice = {
    id: SERVER_VOICE_ID,
    name: "My ADT server (Kokoro)",
    url: `${base}/api/speech/v1/audio/speech`,
    headers: "authorization: Bearer {{key}}\ncontent-type: application/json",
    body: '{"model": "{{model}}", "voice": "{{voice}}", "input": "{{text}}", "speed": {{speed}}, "response_format": "mp3"}',
    response: "audio",
    audioPath: "",
    key: token,
    voice: info.voice,
    model: info.tts,
  };
  // Not addProvider: this one only does speech, so bots must never adopt it for chat.
  useStore.setState((s) => ({ providers: [...s.providers.filter((p) => p.id !== SERVER_VOICE_ID), provider] }));
  const current = useStore.getState().settings.voice;
  updateSettings({
    voice: {
      ...current,
      engine: "whisper-cloud",
      providerId: SERVER_VOICE_ID,
      model: info.stt,
      tts: `custom:${SERVER_VOICE_ID}`,
      customVoices: [...current.customVoices.filter((v) => v.id !== SERVER_VOICE_ID), voice],
    },
  });
  return { ready: info.ready.stt && info.ready.tts };
}

/** Back to speech on this device (the server entries stay, to switch again later). */
export function switchToDeviceVoice() {
  const current = useStore.getState().settings.voice;
  updateSettings({ voice: { ...current, engine: "auto", tts: "system" } });
}
