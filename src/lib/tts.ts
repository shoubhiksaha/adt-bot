import { Capacitor } from "@capacitor/core";
import { describeHttpError, withCustomHeaders } from "./llm";
import { providerFetch } from "./transport";
import { audioFromJson, buildCustomRequest } from "./custom-tts";
import type { CloudTts, ProviderConfig, VoiceSettings } from "./types";

export function customVoiceFor(voice: VoiceSettings) {
  const id = voice.tts.startsWith("custom:") ? voice.tts.slice(7) : "";
  return (voice.customVoices ?? []).find((c) => c.id === id);
}

export const OPENAI_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
export const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

// Device voices ---------------------------------------------------------------

export type DeviceVoice = { name: string; lang: string; local?: boolean };
let nativeVoices: DeviceVoice[] | null = null;

export async function listVoices(): Promise<DeviceVoice[]> {
  if (Capacitor.isNativePlatform()) {
    if (!nativeVoices) {
      const { TextToSpeech } = await import("@capacitor-community/text-to-speech");
      nativeVoices = (await TextToSpeech.getSupportedVoices()).voices.map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
    }
    return nativeVoices;
  }
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  let voices = speechSynthesis.getVoices();
  if (!voices.length) {
    await new Promise((r) => {
      speechSynthesis.addEventListener("voiceschanged", r, { once: true });
      setTimeout(r, 1500);
    });
    voices = speechSynthesis.getVoices();
  }
  return voices.map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
}

/** macOS/iOS novelty and legacy voices that sound robotic. */
const ROBOTIC = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|sandy|flo|reed|eddy|compact)\b/i;

/** Ranks voices so the most natural one for the user's language comes first. */
export function rankVoice(voice: DeviceVoice, language = typeof navigator === "undefined" ? "en-US" : navigator.language): number {
  const lang = language.toLowerCase();
  const v = voice.lang.toLowerCase().replace("_", "-");
  let score = v === lang ? 40 : v.split("-")[0] === lang.split("-")[0] ? 25 : 0;
  if (/premium/i.test(voice.name)) score += 30;
  if (/enhanced/i.test(voice.name)) score += 20;
  if (/siri|neural|natural|google|online|wavenet/i.test(voice.name)) score += 15;
  if (/\b(samantha|ava|allison|evan|nathan|zoe|joelle|nicky|tom|serena|daniel|kate|karen|moira|rishi|veena)\b/i.test(voice.name)) score += 5;
  if (ROBOTIC.test(voice.name)) score -= 60;
  return score;
}

export async function bestVoice(preferred: string): Promise<DeviceVoice | undefined> {
  const voices = await listVoices();
  if (preferred) {
    const chosen = voices.find((v) => v.name === preferred);
    if (chosen) return chosen;
  }
  return [...voices].sort((a, b) => rankVoice(b) - rankVoice(a))[0];
}

// Playback ------------------------------------------------------------------------

let output: AudioContext | null = null;
function audioOutput(): AudioContext {
  if (!output || output.state === "closed") output = new AudioContext();
  if (output.state === "suspended") void output.resume();
  return output;
}

/** Short cue tones for hands-free use (listening, woke up, error). */
export function chime(kind: "listen" | "wake" | "error") {
  try {
    const ctx = audioOutput();
    const notes = kind === "wake" ? [660, 880] : kind === "listen" ? [880] : [330, 220];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.12;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch {
    // Audio isn't available; cues are optional.
  }
}

type Clip = { text: string; audio: Promise<AudioBuffer | null> | null };

export type SpeakerHooks = { onSentence?: (text: string) => void; onError?: (message: string) => void };

export type Speaker = {
  say(text: string): void;
  /** Resolves when everything queued has been spoken. */
  idle(): Promise<void>;
  stop(): void;
  readonly speaking: boolean;
  /** Everything spoken so far in this reply (used to recognise our own echo). */
  readonly spoken: string;
  /** Audio is played by the page, so the microphone's echo canceller can remove it. */
  readonly inPageAudio: boolean;
};

export type TtsContext = { voice: VoiceSettings; providers: ProviderConfig[]; useProxy: boolean };

export function ttsLabel(voice: VoiceSettings): string {
  if (voice.tts === "openai") return `${voice.ttsModel || "OpenAI"} · ${voice.ttsVoice || "alloy"}`;
  if (voice.tts === "elevenlabs") return "ElevenLabs";
  if (voice.tts in CLOUD_TTS) return CLOUD_TTS[voice.tts as CloudTts].label;
  if (voice.tts.startsWith("custom:")) return customVoiceFor(voice)?.name || "Custom voice";
  return "Device voice";
}

/** Queues sentences and speaks them in order, fetching network audio one sentence ahead. */
export function createSpeaker(context: TtsContext, hooks: SpeakerHooks = {}): Speaker {
  const { voice } = context;
  const network = voice.tts !== "system";
  const queue: Clip[] = [];
  const controller = new AbortController();
  let busy = false;
  let stopped = false;
  let spoken = "";
  let current: AudioBufferSourceNode | null = null;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (!busy && !queue.length) {
      waiters.forEach((w) => w());
      waiters = [];
    }
  };

  const fetchAudio = async (text: string): Promise<AudioBuffer | null> => {
    try {
      const bytes = await synthesize(text, context, controller.signal);
      return await audioOutput().decodeAudioData(bytes);
    } catch (error) {
      if (!controller.signal.aborted) hooks.onError?.((error as Error).message);
      return null;
    }
  };

  const prefetch = () => {
    // Keep at most two network requests ahead of playback.
    queue.slice(0, 2).forEach((clip) => {
      if (network && !clip.audio) clip.audio = fetchAudio(clip.text);
    });
  };

  const playBuffer = (buffer: AudioBuffer) =>
    new Promise<void>((resolve) => {
      const ctx = audioOutput();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => resolve();
      current = source;
      source.start();
    });

  const speakDevice = async (text: string) => {
    const chosen = await bestVoice(voice.voiceName);
    if (Capacitor.isNativePlatform()) {
      const { TextToSpeech } = await import("@capacitor-community/text-to-speech");
      const voices = await listVoices();
      const index = chosen ? voices.findIndex((v) => v.name === chosen.name) : -1;
      await TextToSpeech.speak({ text, lang: chosen?.lang ?? navigator.language, rate: voice.rate, ...(index >= 0 ? { voice: index } : {}) }).catch(
        () => undefined,
      );
      return;
    }
    if (!("speechSynthesis" in window)) return;
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const match = chosen ? speechSynthesis.getVoices().find((v) => v.name === chosen.name) : undefined;
      if (match) utterance.voice = match;
      utterance.lang = match?.lang ?? navigator.language;
      utterance.rate = voice.rate;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  };

  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !stopped) {
      prefetch();
      const clip = queue.shift()!;
      hooks.onSentence?.(clip.text);
      spoken += `${clip.text} `;
      if (network) {
        const buffer = await (clip.audio ?? fetchAudio(clip.text));
        if (buffer && !stopped) await playBuffer(buffer);
      } else {
        await speakDevice(clip.text);
      }
    }
    busy = false;
    current = null;
    settle();
  };

  return {
    say(text) {
      const clean = speakable(text);
      if (!clean || stopped) return;
      queue.push({ text: clean, audio: null });
      prefetch();
      void pump();
    },
    idle() {
      if (!busy && !queue.length) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    stop() {
      stopped = true;
      queue.length = 0;
      controller.abort();
      try {
        current?.stop();
      } catch {
        // Already stopped.
      }
      if (Capacitor.isNativePlatform()) {
        void import("@capacitor-community/text-to-speech").then(({ TextToSpeech }) => TextToSpeech.stop());
      } else if (!network && "speechSynthesis" in window) speechSynthesis.cancel();
      busy = false;
      settle();
    },
    get speaking() {
      return busy || queue.length > 0;
    },
    get spoken() {
      return spoken;
    },
    get inPageAudio() {
      return network;
    },
  };
}

/** Natural-voice services that only need an API key: how each one is called. */
export const CLOUD_TTS: Record<
  CloudTts,
  { label: string; keyUrl: string; voiceHint: string; voiceRequired: boolean; models: string[]; request: (text: string, c: { key: string; voice: string; model: string }, rate: number) => { url: string; headers: Record<string, string>; body: string } }
> = {
  fish: {
    label: "Fish Audio",
    keyUrl: "https://fish.audio/app/api-keys/",
    voiceHint: "Voice model ID from fish.audio (blank = default voice)",
    voiceRequired: false,
    models: ["s2.1-pro", "s2-pro", "s1", "drama-3"],
    request: (text, c, rate) => ({
      url: "https://api.fish.audio/v1/tts",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.key}`, model: c.model || "s2.1-pro" },
      body: JSON.stringify({ text, format: "mp3", latency: "balanced", ...(c.voice ? { reference_id: c.voice } : {}), prosody: { speed: Math.min(2, Math.max(0.5, rate)) } }),
    }),
  },
  cartesia: {
    label: "Cartesia",
    keyUrl: "https://play.cartesia.ai/keys",
    voiceHint: "Voice ID from the Cartesia voice library (required)",
    voiceRequired: true,
    models: ["sonic-3.6", "sonic-3", "sonic-2"],
    request: (text, c, rate) => ({
      url: "https://api.cartesia.ai/tts/bytes",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.key}`, "cartesia-version": "2026-08-14" },
      body: JSON.stringify({
        model_id: c.model || "sonic-3.6",
        transcript: text,
        voice: { id: c.voice },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        generation_config: { speed: Math.min(1.5, Math.max(0.6, rate)) },
      }),
    }),
  },
  deepgram: {
    label: "Deepgram Aura",
    keyUrl: "https://console.deepgram.com/",
    voiceHint: "The voice is part of the model name (e.g. aura-2-thalia-en, aura-2-orion-en)",
    voiceRequired: false,
    models: ["aura-2-thalia-en", "aura-2-andromeda-en", "aura-2-orion-en", "aura-2-apollo-en"],
    request: (text, c) => ({
      url: `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(c.model || "aura-2-thalia-en")}&encoding=mp3`,
      headers: { "content-type": "application/json", authorization: `Token ${c.key}` },
      body: JSON.stringify({ text }),
    }),
  },
};

/** Natural voices: any OpenAI-compatible /audio/speech server, ElevenLabs, Fish Audio, Cartesia or Deepgram. Returns encoded audio. */
async function synthesize(text: string, { voice, providers, useProxy }: TtsContext, signal: AbortSignal): Promise<ArrayBuffer> {
  if (voice.tts.startsWith("custom:")) {
    const custom = customVoiceFor(voice);
    if (!custom) throw new Error("That voice service was removed. Choose another in Settings → Voice.");
    if (!/^https?:\/\/[^/]+/.test(custom.url)) throw new Error(`Add the web address for ${custom.name} in Settings → Voice.`);
    const { url, headers, body } = buildCustomRequest(custom, text, voice.rate);
    const res = await providerFetch(url, { method: "POST", headers, body, signal }, useProxy);
    if (!res.ok) throw new Error(`${custom.name}: ${(await describeHttpError(res)).replace("Settings → Providers", "Settings → Voice")}`);
    if (custom.response === "json") return audioFromJson(await res.json(), custom.audioPath);
    return res.arrayBuffer();
  }
  if (voice.tts in CLOUD_TTS) {
    const service = CLOUD_TTS[voice.tts as CloudTts];
    const config = voice.cloudTts?.[voice.tts as CloudTts];
    if (!config?.key) throw new Error(`Add your ${service.label} API key in Settings → Voice.`);
    if (service.voiceRequired && !config.voice) throw new Error(`Add a ${service.label} voice ID in Settings → Voice.`);
    const { url, headers, body } = service.request(text, config, voice.rate);
    const res = await providerFetch(url, { method: "POST", headers, body, signal }, useProxy);
    if (!res.ok) throw new Error(`${service.label}: ${(await describeHttpError(res)).replace("Settings → Providers", "Settings → Voice")}`);
    return res.arrayBuffer();
  }
  if (voice.tts === "elevenlabs") {
    if (!voice.elevenKey) throw new Error("Add your ElevenLabs key in Settings → Voice.");
    const id = voice.elevenVoiceId || ELEVENLABS_DEFAULT_VOICE;
    const res = await providerFetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/mpeg", "xi-api-key": voice.elevenKey },
        body: JSON.stringify({ text, model_id: voice.elevenModel || "eleven_flash_v2_5", voice_settings: { speed: clampSpeed(voice.rate) } }),
        signal,
      },
      useProxy,
    );
    if (!res.ok) throw new Error(`ElevenLabs: ${(await describeHttpError(res)).replace("Settings → Providers", "Settings → Voice")}`);
    return res.arrayBuffer();
  }
  const provider = providers.find((p) => p.id === voice.ttsProviderId);
  if (!provider) throw new Error("Choose a voice provider in Settings → Voice.");
  const model = voice.ttsModel || "gpt-4o-mini-tts";
  const body: Record<string, unknown> = { model, input: text, voice: voice.ttsVoice || "alloy", response_format: "mp3", speed: voice.rate };
  if (/gpt-4o.*tts/.test(model)) body.instructions = "Speak naturally and warmly, like a friendly person in a relaxed conversation.";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await providerFetch(
    `${provider.baseUrl.replace(/\/+$/, "")}/audio/speech`,
    { method: "POST", headers: withCustomHeaders(headers, provider.headers), body: JSON.stringify(body), signal },
    useProxy,
  );
  if (!res.ok) throw new Error(`Voice: ${await describeHttpError(res)}`);
  return res.arrayBuffer();
}

function clampSpeed(rate: number) {
  return Math.min(1.2, Math.max(0.7, rate));
}

/** Text as it should be read aloud: no code, links, citations or Markdown symbols. */
export function speakable(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, " ")
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[(\d{1,2})\](\([^)]*\))?/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~>#|]+/g, " ")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits finished sentences off the front of streaming text so speech can start before the reply
 * is complete. The first sentence may be a short clause, to start talking sooner; later fragments
 * are merged to avoid choppy speech.
 */
export function takeSentences(buffer: string, final: boolean, first = false): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const boundary = first ? /([.!?…。！？:;,])(["')\]]*)(\s+)|\n{2,}/g : /([.!?…。！？])(["')\]]*)(\s+)|\n{2,}/g;
  let last = 0;
  let current = "";
  for (let m = boundary.exec(buffer); m; m = boundary.exec(buffer)) {
    // Keep the whitespace so merged fragments stay separate words.
    current += buffer.slice(last, boundary.lastIndex);
    last = boundary.lastIndex;
    const min = first && !sentences.length ? (/[,;:]$/.test(current.trim()) ? 40 : 12) : 24;
    if (current.trim().length >= min) {
      sentences.push(current.trim());
      current = "";
    }
  }
  let rest = current + buffer.slice(last);
  if (final && rest.trim()) {
    sentences.push(rest.trim());
    rest = "";
  }
  return { sentences, rest };
}
