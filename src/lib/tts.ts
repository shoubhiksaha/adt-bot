import { Capacitor } from "@capacitor/core";
import { describeHttpError, withCustomHeaders } from "./llm";
import { providerFetch } from "./transport";
import { audioFromJson, buildCustomRequest } from "./custom-tts";
import { KOKORO_VOICES, localChoice, localVoiceReady, synthesizeLocally } from "./local-tts";
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

/** Device speech in Chromium sometimes never reports "end"; keep a reference so it isn't garbage-collected. */
let activeUtterance: SpeechSynthesisUtterance | null = null;

let output: AudioContext | null = null;
let suspendTimer: ReturnType<typeof setTimeout> | null = null;
function audioOutput(): AudioContext {
  if (suspendTimer) clearTimeout(suspendTimer);
  suspendTimer = null;
  if (!output || output.state === "closed") output = new AudioContext();
  if (output.state === "suspended") void output.resume();
  return output;
}

/** A running audio context keeps the audio hardware (and a CPU thread) busy; let it sleep when quiet. */
function suspendOutputSoon() {
  if (suspendTimer) clearTimeout(suspendTimer);
  suspendTimer = setTimeout(() => {
    suspendTimer = null;
    if (output?.state === "running" && !networkPlaying) void output.suspend().catch(() => undefined);
  }, 10_000);
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
    suspendOutputSoon();
  } catch {
    // Audio isn't available; cues are optional.
  }
}

type Clip = { text: string; audio: Promise<AudioBuffer | null> | null; started?: boolean };

export type SpeakerHooks = {
  /** A sentence starts sounding (not when it's queued: network audio may still be downloading). */
  onSentence?: (text: string) => void;
  /** How far into the current sentence the voice is, in characters (for word-by-word captions). */
  onProgress?: (chars: number) => void;
  onError?: (message: string) => void;
};

// Loudness of the bot's voice right now, for the voice-mode orb ------------------------------

let analyser: AnalyserNode | null = null;
let samples: Float32Array<ArrayBuffer> | null = null;
let networkPlaying = false;
/** Device voices can't be measured; their word boundaries drive a pulse instead. */
let deviceSpeaking = false;
let lastWordAt = 0;

/** 0–1: how loud the bot is speaking at this moment. Cheap enough to call every animation frame. */
export function speechLevel(): number {
  if (networkPlaying && analyser && samples) {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.min(1, Math.sqrt(sum / samples.length) * 5);
  }
  if (deviceSpeaking) return 0.25 + 0.6 * Math.exp(-(performance.now() - lastWordAt) / 140);
  return 0;
}

let duck: GainNode | null = null;

/**
 * How loud the bot's voice is coming out right now, in dB, after it's turned down for a cut-in;
 * null when it can't be measured (device voices play outside the page). Voice mode predicts its
 * echo in the microphone from this.
 */
export function outputDb(): number | null {
  if (!networkPlaying || !analyser || !samples) return null;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length) * (duck?.gain.value ?? 1);
  return 20 * Math.log10(rms + 1e-6);
}

function outputNode(ctx: AudioContext): AudioNode {
  if (!analyser || analyser.context !== ctx) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    duck = ctx.createGain();
    analyser.connect(duck).connect(ctx.destination);
    samples = new Float32Array(analyser.fftSize);
  }
  return analyser;
}

/**
 * Turns the bot's voice right down while the user may be cutting in, and back up if it was a false
 * alarm (a cough, the bot's own echo). Only affects voices played by the page.
 */
export function duckSpeech(on: boolean) {
  if (!duck) return;
  const now = duck.context.currentTime;
  duck.gain.cancelScheduledValues(now);
  duck.gain.setTargetAtTime(on ? 0.12 : 1, now, on ? 0.03 : 0.12);
}

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
  /**
   * How long sound keeps coming out of the speakers after playback "ends" here (output buffering,
   * Bluetooth): the bot's last words can reach the microphone this much later.
   */
  readonly tailMs: number;
};

export type TtsContext = { voice: VoiceSettings; providers: ProviderConfig[]; useProxy: boolean };

/**
 * The Mac desktop app renders the built-in voices to audio (electron/features/20-speech.cjs), so the
 * page plays them like any natural voice: the microphone's echo canceller then removes them, the orb
 * follows them, and they can be turned down when the user cuts in.
 */
function canRenderDeviceVoice(): boolean {
  return typeof window !== "undefined" && window.adtbotDesktop?.platform === "darwin" && Boolean(window.adtbotDesktop.invoke);
}

/** Loads the built-in voice ahead of the first reply (the first sentence otherwise waits about 2 s). */
export function warmDeviceVoice(voice: VoiceSettings) {
  if (voice.tts !== "system" || !canRenderDeviceVoice()) return;
  void bestVoice(voice.voiceName)
    .then((chosen) => window.adtbotDesktop?.invoke?.("adt:speech:warm", { voice: chosen?.name, lang: chosen?.lang, rate: voice.rate }))
    .catch(() => undefined);
}

export function ttsLabel(voice: VoiceSettings): string {
  if (voice.tts === "local") return `On-device voice · ${voice.localVoice || "F1"}`;
  if (voice.tts === "supertonic3") return `Supertonic 3 · ${voice.localVoice || "F1"}`;
  if (voice.tts === "kokoro") return `Kokoro · ${KOKORO_VOICES.find((v) => v.id === voice.kokoroVoice)?.label.split(" (")[0] ?? "Heart"}`;
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
  /** Played by the page: natural voices, and the Mac's built-in ones rendered to audio. */
  const inPage = network || canRenderDeviceVoice();
  /** Rendering a built-in voice failed once (say, a voice `say` doesn't have): speak the rest the old way. */
  let renderFailed = false;
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
      suspendOutputSoon();
    }
  };

  const renderDevice = async (text: string): Promise<AudioBuffer | null> => {
    if (renderFailed) return null;
    try {
      const chosen = await bestVoice(voice.voiceName);
      const wav = (await window.adtbotDesktop!.invoke!("adt:speech:render", { text, voice: chosen?.name, lang: chosen?.lang, rate: voice.rate })) as Uint8Array;
      if (controller.signal.aborted) return null;
      return await audioOutput().decodeAudioData(wav.slice().buffer);
    } catch (error) {
      if (!controller.signal.aborted) {
        renderFailed = true;
        console.warn("Speaking with the system voice instead:", (error as Error).message);
      }
      return null;
    }
  };

  const fetchAudio = async (text: string): Promise<AudioBuffer | null> => {
    if (!network) return renderDevice(text);
    try {
      const local = localChoice(voice);
      if (local) {
        // Still loading (or downloading): the device voice speaks this sentence instead.
        if (!localVoiceReady(local)) return null;
        // Generated on this device as raw samples: no encoding or decoding step.
        const out = await synthesizeLocally(text, local, voice.rate, controller.signal);
        if (!out || !out.audio.length) return null;
        const buffer = audioOutput().createBuffer(1, out.audio.length, out.sampleRate);
        buffer.copyToChannel(out.audio as Float32Array<ArrayBuffer>, 0);
        return buffer;
      }
      const bytes = await synthesize(text, context, controller.signal);
      return await audioOutput().decodeAudioData(bytes);
    } catch (error) {
      if (!controller.signal.aborted) hooks.onError?.((error as Error).message);
      return null;
    }
  };

  const prefetch = () => {
    // Keep at most two sentences being made (downloaded, generated or rendered) ahead of playback.
    queue.slice(0, 2).forEach((clip) => {
      if (inPage && !clip.audio) clip.audio = fetchAudio(clip.text);
    });
  };

  const playBuffer = async (buffer: AudioBuffer, text: string) => {
    const ctx = audioOutput();
    // A suspended context never plays, so "ended" would never come.
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    if (ctx.state !== "running") {
      hooks.onError?.("Audio playback is blocked. Tap the screen once, then try again.");
      return;
    }
    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(outputNode(ctx));
      // Network audio has no word events: estimate the position from the share of time played.
      const startedAt = performance.now();
      const ticker = setInterval(() => {
        const share = Math.min(1, (performance.now() - startedAt) / 1000 / buffer.duration);
        hooks.onProgress?.(Math.round(share * text.length));
      }, 120);
      const done = () => {
        clearTimeout(watchdog);
        clearInterval(ticker);
        networkPlaying = false;
        hooks.onProgress?.(text.length);
        resolve();
      };
      // Safety net in case "ended" is lost (device change, sleep).
      const watchdog = setTimeout(done, (buffer.duration + 3) * 1000);
      source.onended = done;
      current = source;
      hooks.onSentence?.(text);
      networkPlaying = true;
      source.start();
    });
  };

  let usedDevice = false;
  const speakDevice = async (text: string) => {
    usedDevice = true;
    const chosen = await bestVoice(voice.voiceName);
    // Stopped (barge-in) while finding the voice: don't start a sentence after the cancel.
    if (stopped) return;
    if (Capacitor.isNativePlatform()) {
      const { TextToSpeech } = await import("@capacitor-community/text-to-speech");
      const voices = await listVoices();
      const index = chosen ? voices.findIndex((v) => v.name === chosen.name) : -1;
      if (stopped) return;
      hooks.onSentence?.(text);
      // Android reports no word positions: estimate them, and pulse the orb, from the time spoken.
      deviceSpeaking = true;
      const startedAt = performance.now();
      const perSecond = 14 * Math.max(0.5, voice.rate);
      const ticker = setInterval(() => {
        const word = text.lastIndexOf(" ", Math.round(((performance.now() - startedAt) / 1000) * perSecond));
        if (word > 0) {
          lastWordAt = performance.now();
          hooks.onProgress?.(word);
        }
      }, 200);
      await TextToSpeech.speak({ text, lang: chosen?.lang ?? navigator.language, rate: voice.rate, ...(index >= 0 ? { voice: index } : {}) })
        .catch((error: Error) => hooks.onError?.(`The device voice failed: ${error.message ?? error}`))
        .finally(() => {
          clearInterval(ticker);
          deviceSpeaking = false;
          hooks.onProgress?.(text.length);
        });
      return;
    }
    if (!("speechSynthesis" in window)) {
      hooks.onError?.("This device has no built-in voice. Choose a natural voice in Settings → Voice.");
      return;
    }
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      activeUtterance = utterance;
      const match = chosen ? speechSynthesis.getVoices().find((v) => v.name === chosen.name) : undefined;
      if (match) utterance.voice = match;
      utterance.lang = match?.lang ?? navigator.language;
      utterance.rate = voice.rate;
      // About 12 characters a second at normal speed, plus slack; covers a lost "end" event.
      const watchdog = setTimeout(() => finish(), (4000 + (text.length / 12 / Math.max(0.5, voice.rate)) * 1000 * 1.5));
      let ticker: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        clearTimeout(watchdog);
        if (ticker) clearInterval(ticker);
        if (activeUtterance === utterance) activeUtterance = null;
        deviceSpeaking = false;
        hooks.onProgress?.(text.length);
        resolve();
      };
      let started = false;
      let boundaries = false;
      const start = () => {
        if (started) return;
        started = true;
        deviceSpeaking = true;
        lastWordAt = performance.now();
        hooks.onSentence?.(text);
        // Some voices never report word boundaries: estimate the position from the time spoken.
        const startedAt = performance.now();
        const perSecond = 14 * Math.max(0.5, voice.rate);
        let reported = 0;
        ticker = setInterval(() => {
          if (boundaries) return;
          const chars = Math.min(text.length, Math.round(((performance.now() - startedAt) / 1000) * perSecond));
          const word = text.lastIndexOf(" ", chars);
          if (word > reported) {
            reported = word;
            lastWordAt = performance.now();
            hooks.onProgress?.(word);
          }
        }, 150);
      };
      utterance.onstart = start;
      utterance.onboundary = (event) => {
        start();
        boundaries = true;
        lastWordAt = performance.now();
        if (event.name === "word") hooks.onProgress?.(event.charIndex + (event.charLength || 0));
      };
      utterance.onend = finish;
      utterance.onerror = (event) => {
        if (event.error !== "interrupted" && event.error !== "canceled") hooks.onError?.(`The device voice failed (${event.error}).`);
        finish();
      };
      if (stopped) return finish();
      speechSynthesis.speak(utterance);
    });
  };

  let deviceStandIn = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length && !stopped) {
      prefetch();
      const clip = queue[0];
      clip.started = true;
      queue.shift();
      spoken += `${clip.text} `;
      if (inPage) {
        const buffer = await (clip.audio ?? fetchAudio(clip.text));
        if (buffer && !stopped) await playBuffer(buffer, clip.text);
        // The voice service failed for this sentence (the error is shown), or the built-in voice
        // couldn't be rendered: the system speaks it.
        else if (!buffer && !stopped && !controller.signal.aborted) {
          deviceStandIn = true;
          await speakDevice(clip.text).finally(() => (deviceStandIn = false));
        }
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
      // The device voice takes 1–2.5 s to start each utterance: after the first one, speak in
      // bigger pieces, joining sentences that arrive while it's still talking.
      const last = queue.at(-1);
      if (!inPage && last && !last.started && last.text.length + clean.length < 400) last.text = `${last.text} ${clean}`;
      else queue.push({ text: clean, audio: null });
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
      } else if (usedDevice && "speechSynthesis" in window) speechSynthesis.cancel();
      busy = false;
      networkPlaying = false;
      deviceSpeaking = false;
      settle();
    },
    get speaking() {
      return busy || queue.length > 0;
    },
    get spoken() {
      return spoken;
    },
    /** False while the device voice stands in (it can't be turned down, so cutting in must stop it). */
    get inPageAudio() {
      return inPage && !deviceStandIn;
    },
    get tailMs() {
      return outputTailMs(inPage && !deviceStandIn);
    },
  };
}

export type PcmPlayer = {
  /** Queues samples (−1…1) at `rate` Hz right after what's already queued. */
  push(samples: Float32Array, rate: number): void;
  /** Stops at once and drops everything queued (the user cut in). */
  flush(): void;
  /** Sound is playing or queued. */
  readonly playing: boolean;
  /** Resolves when everything queued has been heard. */
  idle(): Promise<void>;
};

/**
 * Plays a voice that arrives as a stream of audio pieces (Gemini Live), gaplessly, through the same
 * output as the other voices: the echo canceller removes it and the orb follows it.
 */
export function createPcmPlayer(): PcmPlayer {
  const sources = new Set<AudioBufferSourceNode>();
  let next = 0;
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (sources.size) return;
    networkPlaying = false;
    waiters.forEach((w) => w());
    waiters = [];
    suspendOutputSoon();
  };
  return {
    push(samples, rate) {
      if (!samples.length) return;
      const ctx = audioOutput();
      const buffer = ctx.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(outputNode(ctx));
      // A little slack before the first piece, so the next one is there before this one ends.
      const at = Math.max(next, ctx.currentTime + (sources.size ? 0 : 0.06));
      source.start(at);
      next = at + buffer.duration;
      sources.add(source);
      networkPlaying = true;
      const ended = () => {
        clearTimeout(watchdog);
        if (!sources.delete(source)) return;
        settle();
      };
      // "ended" can be lost (the output device changed, the Mac slept): don't stay "speaking".
      const watchdog = setTimeout(ended, (at - ctx.currentTime + buffer.duration + 2) * 1000);
      source.onended = ended;
    },
    flush() {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Not started yet.
        }
      }
      sources.clear();
      next = 0;
      settle();
    },
    get playing() {
      return sources.size > 0;
    },
    idle() {
      if (!sources.size) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** The speakers' delay: measured for audio the page plays, a safe guess for the system voice. */
export function outputTailMs(inPage: boolean): number {
  if (!inPage || !output) return 300;
  const latency = (output.outputLatency || 0) + (output.baseLatency || 0);
  return Math.round(Math.min(1500, latency * 1000) + 80);
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

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];

/** "https://www.example.com/a/b" → "example.com": a voice reading a whole link is just noise. */
function spokenLink(url: string): string {
  try {
    return ` ${new URL(url).hostname.replace(/^www\./, "")} `;
  } catch {
    return " a link ";
  }
}

/** Text as it should be read aloud: no code, links, citations, emoji or Markdown symbols. */
export function speakable(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, " ")
    .replace(/<\/?[a-z][\w-]*[^<>\n]{0,60}$/i, " ") // a tag still streaming in (e.g. "<remem")
    .replace(/```[\s\S]*?(```|$)/g, " I've put the code in the chat. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[(\d{1,2})\](\([^)]*\))?/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+/g, spokenLink)
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*(\d{1,2})[.)]\s+/gm, (_m, n: string) => ` ${ORDINALS[Number(n) - 1] ?? n}, `)
    .replace(/\b([CF])#/g, "$1 sharp")
    .replace(/\s>=\s/g, " at least ")
    .replace(/\s<=\s/g, " at most ")
    .replace(/\s>\s/g, " greater than ")
    .replace(/\s<\s/g, " less than ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~>#|]+/g, " ")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

const ABBREVIATION = /(?:^|[\s(])(?:dr|mr|mrs|ms|prof|sr|jr|st|vs|approx|no|fig|e\.g|i\.e|[a-z])\.$/i;

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
    // "Dr. Smith", "e.g. this": not the end of a sentence.
    if (m[1] === "." && ABBREVIATION.test(buffer.slice(Math.max(0, m.index - 8), m.index + 1))) continue;
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
