import { Capacitor } from "@capacitor/core";
import { describeHttpError, withCustomHeaders } from "./llm";
import { providerFetch } from "./transport";
import { createSpeaker, type Speaker, speakable, takeSentences } from "./tts";
import type { ProviderConfig, VoiceSettings } from "./types";
import { Listener, toWav } from "./whisper";

export { speakable, takeSentences };

export const TRANSCRIBE_MODEL_SUGGESTIONS: Record<string, string> = {
  openai: "gpt-4o-mini-transcribe",
  groq: "whisper-large-v3-turbo",
};

export const END_SILENCE_MS: Record<VoiceSettings["endSilence"], number> = { fast: 450, normal: 700, patient: 1200 };

/** The device recognizer exists but can't run here (no speech service, offline…); use Whisper instead. */
export class SpeechUnavailableError extends Error {}

/** The concrete recognizer a session uses. */
export type Engine = "browser" | "native" | "whisper-local" | "whisper-cloud";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

const SpeechRecognitionImpl: (new () => SpeechRecognitionLike) | undefined =
  typeof window === "undefined" ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

const platform = () => Capacitor.getPlatform();

/** Browser/WebView dictation. Electron ships the API but has no speech service behind it. */
export function browserDictationAvailable(): boolean {
  return Boolean(SpeechRecognitionImpl) && !window.adtbotDesktop && platform() !== "android";
}

let deviceRecognizerBroken = false;
/** Remember that the device recognizer can't run here, so later sessions go straight to Whisper. */
export function markDeviceRecognizerBroken() {
  deviceRecognizerBroken = true;
}

/** Picks the recognizer for this device and settings. */
export function resolveEngine(voice: VoiceSettings, providers: ProviderConfig[]): Engine {
  const cloudReady = Boolean(voice.model && providers.some((p) => p.id === voice.providerId));
  const device: Engine | null = deviceRecognizerBroken
    ? null
    : platform() === "android"
      ? "native"
      : browserDictationAvailable()
        ? "browser"
        : null;
  switch (voice.engine) {
    case "device":
      return device ?? "whisper-local";
    case "whisper-local":
      return "whisper-local";
    case "whisper-cloud":
      return cloudReady ? "whisper-cloud" : "whisper-local";
    default:
      return device ?? (cloudReady ? "whisper-cloud" : "whisper-local");
  }
}

export const ENGINE_LABELS: Record<Engine, string> = {
  browser: "Device speech recognition",
  native: "Android speech recognition",
  "whisper-local": "Whisper on this device (private, offline)",
  "whisper-cloud": "Cloud Whisper",
};

export type ListenOptions = {
  /** End automatically when the speaker pauses (one turn). Otherwise run until stop(). */
  autoStop: boolean;
  onPartial?: (text: string) => void;
  onLevel?: (level: number) => void;
  onPhase?: (phase: "listening" | "transcribing") => void;
};

export type ListenSession = {
  /** Finish and return what was said. */
  stop(): void;
  /** Abandon without a result. */
  cancel(): void;
  result: Promise<string>;
};

export type ListenContext = { voice: VoiceSettings; providers: ProviderConfig[]; useProxy: boolean };

/** One listening session with the resolved engine. Resolves to the transcript ("" if nothing was said). */
export async function listen(engine: Engine, options: ListenOptions, context: ListenContext): Promise<ListenSession> {
  if (engine === "browser") return withFallback(listenBrowser(options), options, context);
  if (engine === "native") {
    try {
      return withFallback(await listenNative(options), options, context);
    } catch (error) {
      if (/denied/i.test((error as Error).message)) throw error;
      markDeviceRecognizerBroken();
      return listenWhisper("whisper-local", options, context);
    }
  }
  return listenWhisper(engine, options, context);
}

/** If the device recognizer turns out not to work, redo the turn with Whisper transparently. */
function withFallback(session: ListenSession, options: ListenOptions, context: ListenContext): ListenSession {
  let current = session;
  const result = session.result.catch(async (error) => {
    if (!(error instanceof SpeechUnavailableError)) throw error;
    markDeviceRecognizerBroken();
    current = await listenWhisper("whisper-local", options, context);
    return current.result;
  });
  return { stop: () => current.stop(), cancel: () => current.cancel(), result };
}

function listenBrowser(options: ListenOptions): ListenSession {
  const recognition = new SpeechRecognitionImpl!();
  recognition.continuous = !options.autoStop;
  recognition.interimResults = true;
  recognition.lang = navigator.language;
  let text = "";
  let cancelled = false;
  const result = new Promise<string>((resolve, reject) => {
    recognition.onresult = (e) => {
      text = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join("");
      options.onPartial?.(text);
    };
    recognition.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") resolve(cancelled ? "" : text);
      else if (e.error === "not-allowed") {
        reject(new Error("Microphone or speech recognition permission was denied. Allow it in your device settings."));
      } else reject(new SpeechUnavailableError(`Device speech recognition unavailable (${e.error})`));
    };
    recognition.onend = () => resolve(cancelled ? "" : text.trim());
  });
  recognition.start();
  options.onPhase?.("listening");
  return {
    stop: () => recognition.stop(),
    cancel: () => {
      cancelled = true;
      recognition.abort();
    },
    result,
  };
}

async function listenNative(options: ListenOptions): Promise<ListenSession> {
  const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
  const { available } = await SpeechRecognition.available();
  if (!available) throw new Error("Speech recognition isn't available on this device.");
  let permission = await SpeechRecognition.checkPermissions();
  if (permission.speechRecognition !== "granted") permission = await SpeechRecognition.requestPermissions();
  if (permission.speechRecognition !== "granted") throw new Error("Microphone permission was denied. Allow it in Android settings.");

  let text = "";
  let cancelled = false;
  let finish: () => void = () => undefined;
  const result = new Promise<string>((resolve) => {
    finish = () => resolve(cancelled ? "" : text.trim());
  });
  // Android reports silence and errors by rejecting the call, not with a "stopped" event, so a
  // watchdog ends the turn: after 10 s with nothing heard, or 2.5 s after the last words.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => void SpeechRecognition.stop().catch(() => undefined).finally(finish), ms);
  };
  arm(10_000);
  const partial = await SpeechRecognition.addListener("partialResults", (data: { matches?: string[] }) => {
    text = data.matches?.[0] ?? text;
    options.onPartial?.(text);
    arm(2_500);
  });
  const state = await SpeechRecognition.addListener("listeningState", (data: { status: string }) => {
    // The final words can arrive just after "stopped".
    if (data.status === "stopped") setTimeout(finish, 500);
  });
  void result.then(() => {
    clearTimeout(watchdog);
    void partial.remove();
    void state.remove();
  });
  await SpeechRecognition.start({ language: navigator.language, partialResults: true, popup: false, maxResults: 1 });
  options.onPhase?.("listening");
  return {
    stop: () => void SpeechRecognition.stop().then(() => setTimeout(finish, 400)),
    cancel: () => {
      cancelled = true;
      void SpeechRecognition.stop().finally(finish);
    },
    result,
  };
}

/** Whisper with live voice detection: captions while you talk, and the text when you finish. */
async function listenWhisper(engine: Engine, options: ListenOptions, context: ListenContext): Promise<ListenSession> {
  const parts: string[] = [];
  let cancelled = false;
  let stopping = false;
  let finished = false;
  let pendingCloud = 0;
  let speaking = false;
  let resolveResult: (text: string) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const joined = () => parts.join(" ").trim();
  let listener: Listener | null = null;

  const done = () => {
    if (finished) return;
    finished = true;
    listener?.close();
    resolveResult(cancelled ? "" : joined());
  };

  listener = await Listener.open({
    mode: engine === "whisper-cloud" ? "cloud" : "local",
    size: context.voice.localModel,
    endSilenceMs: options.autoStop ? END_SILENCE_MS[context.voice.endSilence] : 1500,
    partials: true,
    onEvent: async (event) => {
      if (event.type === "level") options.onLevel?.(event.level);
      else if (event.type === "start") speaking = true;
      else if (event.type === "partial") options.onPartial?.([joined(), event.text].filter(Boolean).join(" "));
      else if (event.type === "transcribing") options.onPhase?.("transcribing");
      else if (event.type === "utterance") {
        speaking = false;
        let text = event.text ?? "";
        if (event.audio) {
          const provider = context.providers.find((p) => p.id === context.voice.providerId)!;
          pendingCloud++;
          try {
            text = await transcribe(toWav(event.audio), provider, context.voice.model, context.useProxy);
          } catch (error) {
            listener?.close();
            rejectResult(error as Error);
            return;
          } finally {
            pendingCloud--;
          }
        }
        if (text) parts.push(text);
        options.onPartial?.(joined());
        if (options.autoStop ? Boolean(text) : stopping) done();
        else options.onPhase?.("listening");
      } else if (event.type === "error") {
        listener?.close();
        rejectResult(new Error(event.message));
      }
    },
  });
  options.onPhase?.("listening");

  return {
    stop: () => {
      stopping = true;
      if (speaking) listener?.flush();
      else if (!pendingCloud) setTimeout(done, 50);
    },
    cancel: () => {
      cancelled = true;
      done();
    },
    result,
  };
}

/** Speech to text through any OpenAI-compatible /audio/transcriptions endpoint. */
export async function transcribe(audio: Blob, provider: ProviderConfig, model: string, useProxy: boolean): Promise<string> {
  const extension = audio.type.includes("wav") ? "wav" : audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", audio, `speech.${extension}`);
  form.append("model", model);
  const headers: Record<string, string> = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  const res = await providerFetch(
    `${provider.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
    { method: "POST", headers: withCustomHeaders(headers, provider.headers), body: form },
    useProxy,
  );
  if (!res.ok) throw new Error(await describeHttpError(res));
  const json: any = await res.json();
  return String(json.text ?? "").trim();
}

// Read aloud ------------------------------------------------------------------------

let readAloud: Speaker | null = null;

/** Read a reply aloud with the configured voice. Calling again while it is speaking stops it. */
export function speak(text: string, context: ListenContext, onError?: (message: string) => void): boolean {
  if (readAloud?.speaking) {
    readAloud.stop();
    readAloud = null;
    return false;
  }
  readAloud = createSpeaker(context, { onError });
  for (const sentence of takeSentences(text, true).sentences) readAloud.say(sentence);
  return true;
}

export function canSpeak(): boolean {
  return Capacitor.isNativePlatform() || (typeof window !== "undefined" && ("speechSynthesis" in window || "AudioContext" in window));
}
