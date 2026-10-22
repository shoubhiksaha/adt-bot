import { AudioLines, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { updateSettings, useStore } from "../../lib/store";
import { CUSTOM_VOICE_TEMPLATES, type CustomVoice, newCustomVoice } from "../../lib/custom-tts";
import { bestVoice, CLOUD_TTS, customVoiceFor, type DeviceVoice, listVoices, OPENAI_TTS_VOICES, rankVoice } from "../../lib/tts";
import type { CloudTts, VoiceSettings } from "../../lib/types";
import { ENGINE_LABELS, resolveEngine, speak, TRANSCRIBE_MODEL_SUGGESTIONS } from "../../lib/voice";
import {
  KOKORO_MB,
  KOKORO_VOICES,
  LOCAL_VOICE_MB,
  LOCAL_VOICES,
  localChoice,
  localVoiceDownloaded,
  onLocalVoiceProgress,
  preloadLocalVoice,
  SUPERTONIC3_MB,
} from "../../lib/local-tts";
import { isMoonshine } from "../../lib/speech-models";
import { CAPTION_MB } from "../../lib/moonshine-streaming";
import { localSpeechModel, onSpeechNotice, onWhisperProgress, preloadWhisper, SPEECH_MODELS, type SpeechModel, whisperDownloaded } from "../../lib/whisper";
import { LIVE_MODELS, LIVE_VOICES } from "../../lib/gemini-live";
import { switchToDeviceVoice, switchToServerVoice, usingServerVoice } from "../../lib/server-voice";
import { ModelInput, Section, Toggle } from "./controls";

/** Whose system voice settings to point to (null on phones). */
const DESKTOP_OS =
  typeof navigator === "undefined" || /Android|iPhone|iPad/.test(navigator.userAgent)
    ? null
    : /Mac/.test(navigator.platform)
      ? "mac"
      : /Win/.test(navigator.platform)
        ? "windows"
        : /Linux/.test(navigator.platform)
          ? "linux"
          : null;

export function VoiceSettings() {
  const providers = useStore((s) => s.providers);
  const voice = useStore((s) => s.settings.voice);
  const autoSpeak = useStore((s) => s.settings.autoSpeak);
  const useProxy = useStore((s) => s.settings.useProxy);
  const bots = useStore((s) => s.bots);
  const server = useStore((s) => s.settings.server);
  const [serverNote, setServerNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  /** The system's voices (null while they load). */
  const [voices, setVoices] = useState<DeviceVoice[] | null>(null);
  const [autoVoice, setAutoVoice] = useState<string>("");
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [speechNotice, setSpeechNotice] = useState("");
  const openaiLike = providers.filter((p) => p.kind === "openai");
  const geminiKeys = providers.filter((p) => p.kind === "gemini" && p.apiKey);
  const engine = resolveEngine(voice, providers);
  const set = (patch: Partial<typeof voice>) => updateSettings({ voice: { ...voice, ...patch } });
  const wakeName = bots[0]?.nickname?.trim() || bots[0]?.name || "ADT";

  useEffect(() => {
    const load = () => {
      void listVoices().then(setVoices).catch(() => setVoices([]));
      void bestVoice("").then((v) => setAutoVoice(v?.name ?? ""));
    };
    load();
    // Some systems list their voices late.
    if (typeof speechSynthesis === "undefined") return;
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  useEffect(() => {
    void whisperDownloaded(voice.localModel).then((yes) => setDownloaded(yes));
  }, [voice.localModel]);
  useEffect(() => onWhisperProgress((p) => setProgress(p ? Math.round(p.progress) : null)), []);
  useEffect(() => onSpeechNotice(setSpeechNotice), []);
  // Moonshine is English only: for other languages the matching Whisper size runs instead.
  const speechModel = localSpeechModel(voice.localModel);
  const systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language || "en";

  const sortedVoices = [...(voices ?? [])].sort((a, b) => rankVoice(b) - rankVoice(a) || a.name.localeCompare(b.name));
  const [testError, setTestError] = useState("");
  const test = () => {
    setTestError("");
    speak("Hi! This is how I'll sound when we talk.", { voice, providers, useProxy }, setTestError);
  };

  return (
    <div>
      <div className="card voice-summary">
        <AudioLines size={18} />
        <div>
          <strong>Voice is on</strong>
          <div className="small muted">
            🎤 dictates into the message box · <AudioLines size={12} /> starts hands-free voice mode. Listening with{" "}
            {engine === "whisper-local" ? `${SPEECH_MODELS[speechModel].label.split(":")[0]} on this device (private, offline)` : ENGINE_LABELS[engine]}.
          </div>
        </div>
      </div>

      <Section title="Voice mode look" hint="What you see while you talk. In voice mode you can also show it your camera or screen.">
        <div className="field">
          <select id="voice-look" className="select" value={voice.look ?? "orb"} onChange={(e) => set({ look: e.target.value as typeof voice.look })} aria-label="Voice mode look">
            <option value="orb">Glowing orb</option>
            <option value="face">A face that talks</option>
            <option value="picture">The bot's picture</option>
          </select>
        </div>
      </Section>

      <Section title="Speech on your server" hint="Speech recognition and a natural voice run on your always-on server instead of this device: less load here, same voice mode.">
        <div className="btn-row">
          {usingServerVoice() ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                switchToDeviceVoice();
                setServerNote({ text: "Speech runs on this device again." });
              }}
            >
              Use this device again
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={!server.url || !server.token || serverBusy}
              onClick={() => {
                setServerBusy(true);
                setServerNote(null);
                switchToServerVoice()
                  .then(({ ready }) =>
                    setServerNote({ text: ready ? "Voice mode now uses your server's speech." : "Set up. Your server is still downloading its speech models: give it a few minutes before voice mode." }),
                  )
                  .catch((error: Error) => setServerNote({ text: error.message, error: true }))
                  .finally(() => setServerBusy(false));
              }}
            >
              {serverBusy ? "Connecting…" : "Use my server for voice"}
            </button>
          )}
          {!server.url && <span className="small muted">Connect your always-on server in Settings → Sync & server first.</span>}
        </div>
        {serverNote && <span className={`small ${serverNote.error ? "error-text" : "muted"}`}>{serverNote.text}</span>}
      </Section>

      <Section title="Voice mode conversation" hint="Who hears you and answers in voice mode.">
        <div className="field">
          <select
            id="voice-conversation"
            className="select"
            value={voice.conversation}
            onChange={(e) => set({ conversation: e.target.value as VoiceSettings["conversation"] })}
          >
            <option value="app">ADT Bot: your bot's model, with the speech recognition and reply voice below</option>
            <option value="gemini-live">Gemini 3.8 Live: one model hears you and talks back (most natural and fastest; Google AI key)</option>
          </select>
        </div>
        {voice.conversation === "gemini-live" && (
          <>
            {geminiKeys.length === 0 && (
              <p className="small error-text">Add Google Gemini under Settings → Providers first (a free key from aistudio.google.com).</p>
            )}
            {geminiKeys.length > 1 && (
              <div className="field">
                <label htmlFor="live-provider">Google AI key</label>
                <select id="live-provider" className="select" value={voice.liveProviderId} onChange={(e) => set({ liveProviderId: e.target.value })}>
                  <option value="">First one ({geminiKeys[0].name})</option>
                  {geminiKeys.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="live-model">Model</label>
              <select id="live-model" className="select" value={voice.liveModel} onChange={(e) => set({ liveModel: e.target.value })}>
                {LIVE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="live-voice">Voice</label>
              <select id="live-voice" className="select" value={voice.liveVoice} onChange={(e) => set({ liveVoice: e.target.value })}>
                {LIVE_VOICES.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.style.toLowerCase()})
                  </option>
                ))}
              </select>
            </div>
            <p className="small muted">
              Your bot's instructions, memories and tools still apply (actions that need your OK are asked aloud), and the conversation is saved in the chat as
              text. The speech recognition, reply voice and turn settings below aren't used. Google charges about $0.005 a minute for listening and $0.018 a
              minute for speaking; voice mode pauses after 3 quiet minutes.
            </p>
          </>
        )}
      </Section>

      <Section title="Reply voice" hint="Natural voices sound like Grok's; device voices are free and instant.">
        <div className="field">
          <select
            id="tts-engine"
            className="select"
            value={voice.tts}
            onChange={(e) => {
              if (e.target.value === "__add") {
                const added = newCustomVoice("blank");
                set({ customVoices: [...(voice.customVoices ?? []), added], tts: `custom:${added.id}` });
              } else set({ tts: e.target.value as typeof voice.tts });
            }}
          >
            <option value="system">Device voice (free, instant)</option>
            <option value="local">Natural, on this device: Supertonic (English; free, private, works offline)</option>
            <option value="supertonic3">Natural, on this device: Supertonic 3 (31 languages; free, private, works offline)</option>
            <option value="kokoro">Natural, on this device: Kokoro (most natural, slower)</option>
            <option value="openai">Natural: OpenAI-compatible (OpenAI, or a self-hosted Kokoro/LocalAI server)</option>
            <option value="elevenlabs">Natural: ElevenLabs</option>
            <option value="fish">Natural: Fish Audio</option>
            <option value="cartesia">Natural: Cartesia</option>
            <option value="deepgram">Natural: Deepgram Aura</option>
            {(voice.customVoices ?? []).map((c) => (
              <option key={c.id} value={`custom:${c.id}`}>
                Yours: {c.name || "Voice service"}
              </option>
            ))}
            <option value="__add">＋ Add a voice provider…</option>
          </select>
        </div>

        {voice.tts === "system" && (
          <div className="field">
            <label htmlFor="tts-voice">Device voice</label>
            <select id="tts-voice" className="select" value={voice.voiceName} onChange={(e) => set({ voiceName: e.target.value })}>
              <option value="">Best available{autoVoice ? ` (${autoVoice})` : ""}</option>
              {sortedVoices.map((v) => (
                <option key={`${v.name}-${v.lang}`} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            {voices?.length === 0 ? (
              <span className="small error-text">
                This computer has no system voices. Choose “Natural, on this device” above, or install them
                {DESKTOP_OS === "linux" ? " (for example: sudo apt install speech-dispatcher espeak-ng) and restart ADT Bot" : ""}.
              </span>
            ) : DESKTOP_OS === "mac" ? (
              <span className="small muted">
                On a Mac, nicer voices are free: System Settings → Accessibility → Spoken Content → System voice → Manage voices, then add a
                “Premium” or “Enhanced” voice. It's picked automatically.
              </span>
            ) : DESKTOP_OS === "windows" ? (
              <span className="small muted">On Windows, more voices are free: Settings → Time & language → Speech → Add voices. The best one is picked automatically.</span>
            ) : null}
          </div>
        )}

        {(voice.tts === "local" || voice.tts === "supertonic3" || voice.tts === "kokoro") && <LocalVoiceFields key={voice.tts} voice={voice} set={set} />}

        {voice.tts === "openai" && (
          <>
            <div className="field">
              <label htmlFor="tts-provider">Provider</label>
              <select id="tts-provider" className="select" value={voice.ttsProviderId} onChange={(e) => set({ ttsProviderId: e.target.value })}>
                <option value="">Choose…</option>
                {openaiLike.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {!openaiLike.length && <span className="small muted">Connect OpenAI, or add your Kokoro-FastAPI/LocalAI server as a private server, under Providers.</span>}
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="tts-model">Model</label>
                <ModelInput id="tts-model" value={voice.ttsModel} onChange={(ttsModel) => set({ ttsModel })} suggestions={["gpt-4o-mini-tts", "tts-1", "kokoro", "tts-1-hd"]} placeholder="gpt-4o-mini-tts" />
              </div>
              <div className="field">
                <label htmlFor="tts-voice-name">Voice</label>
                <ModelInput id="tts-voice-name" value={voice.ttsVoice} onChange={(ttsVoice) => set({ ttsVoice })} suggestions={[...OPENAI_TTS_VOICES, "af_heart", "af_bella", "am_michael", "bf_emma"]} placeholder="alloy" />
              </div>
            </div>
          </>
        )}

        {voice.tts === "elevenlabs" && (
          <>
            <div className="field">
              <label htmlFor="eleven-key">ElevenLabs API key</label>
              <input id="eleven-key" className="input" type="password" value={voice.elevenKey} onChange={(e) => set({ elevenKey: e.target.value.trim() })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="eleven-voice">Voice ID</label>
                <input id="eleven-voice" className="input" placeholder="Default: Rachel" value={voice.elevenVoiceId} onChange={(e) => set({ elevenVoiceId: e.target.value.trim() })} />
              </div>
              <div className="field">
                <label htmlFor="eleven-model">Model</label>
                <ModelInput id="eleven-model" value={voice.elevenModel} onChange={(elevenModel) => set({ elevenModel })} suggestions={["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"]} placeholder="eleven_flash_v2_5" />
              </div>
            </div>
          </>
        )}

        {voice.tts in CLOUD_TTS && <CloudVoiceFields id={voice.tts as CloudTts} voice={voice} set={set} />}
        {voice.tts.startsWith("custom:") && customVoiceFor(voice) && <CustomVoiceFields voice={voice} set={set} />}

        <div className="field">
          <label htmlFor="tts-rate">
            Speed <span className="muted small">{voice.rate.toFixed(2)}×</span>
          </label>
          <input id="tts-rate" type="range" min={0.6} max={1.8} step={0.05} value={voice.rate} onChange={(e) => set({ rate: Number(e.target.value) })} />
        </div>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button type="button" className="btn" onClick={test}>
            <Volume2 size={14} /> Test voice
          </button>
          {testError && <span className="small error-text">{testError}</span>}
        </div>
        <Toggle checked={autoSpeak} onChange={(v) => updateSettings({ autoSpeak: v })} title="Read the answer aloud when you dictate" hint="When you speak a message with the mic button, its answer is read aloud too. Typed messages always get text only, and voice mode always speaks." />
      </Section>

      <Section title="Conversation">
        <div className="field-row">
          <div className="field">
            <label htmlFor="end-silence">Reply after you pause for</label>
            <select id="end-silence" className="select" value={voice.endSilence} onChange={(e) => set({ endSilence: e.target.value as typeof voice.endSilence })}>
              <option value="fast">Short pause (snappy)</option>
              <option value="normal">Normal pause</option>
              <option value="patient">Long pause (I think while talking)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="barge">Interrupt by talking</label>
            <select id="barge" className="select" value={voice.bargeIn} onChange={(e) => set({ bargeIn: e.target.value as typeof voice.bargeIn })}>
              <option value="auto">Automatic</option>
              <option value="on">Instantly (best with headphones)</option>
              <option value="off">Off (tap or press Space)</option>
            </select>
          </div>
        </div>
        {engine === "whisper-local" && (
          <Toggle
            checked={voice.earlyReply}
            onChange={(v) => set({ earlyReply: v })}
            title="Start answering during pauses"
            hint="When you've probably finished, the bot starts on its answer before it's sure, which can save a second or more. Nothing is shown, said or done until you've really finished; if you keep talking, it's dropped (that can cost a few extra tokens)."
          />
        )}
        <Toggle checked={voice.concise} onChange={(v) => set({ concise: v })} title="Short spoken answers" hint="Bots answer in a sentence or two, like a phone call, and skip formatting." />
        <div className="field">
          <label htmlFor="voice-model">Model for voice conversations</label>
          <select
            id="voice-model"
            className="select"
            value={voice.voiceModel ? `${voice.voiceProviderId}::${voice.voiceModel}` : ""}
            onChange={(e) => {
              const [voiceProviderId, voiceModel] = e.target.value ? e.target.value.split("::") : ["", ""];
              set({ voiceProviderId, voiceModel });
            }}
          >
            <option value="">Same as the bot</option>
            {providers.flatMap((p) =>
              p.models.slice(0, 60).map((m) => (
                <option key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`}>
                  {p.name}: {m.id}
                </option>
              )),
            )}
          </select>
          <span className="small muted">A fast model (e.g. Claude Haiku, Gemini Flash, Groq) makes conversations feel instant.</span>
        </div>
      </Section>

      <Section title="Hands-free">
        <Toggle
          checked={voice.wakeWord}
          onChange={(v) => set({ wakeWord: v })}
          title={`Standby and wake word in voice mode`}
          hint={`After a quiet spell, voice mode waits for “Hey ${wakeName}”. Set a nickname for each bot in its settings.`}
        />
        <Toggle
          checked={voice.handsFree}
          onChange={(v) => set({ handsFree: v })}
          title={`Always listen for “Hey ${wakeName}”`}
          hint="While the app is open, saying the wake word opens voice mode. Speech is processed on this device and nothing is sent until you wake it. A mic indicator shows while it's listening."
        />
      </Section>

      <Section title="Speech recognition">
        <div className="field">
          <select id="stt-engine" className="select" value={voice.engine} onChange={(e) => set({ engine: e.target.value as typeof voice.engine })}>
            <option value="auto">Automatic (recommended)</option>
            <option value="device">This device's speech recognition</option>
            <option value="whisper-local">On this device: Whisper or Moonshine (private, works offline)</option>
            <option value="whisper-cloud">Cloud Whisper (OpenAI, Groq, your server…)</option>
          </select>
          <span className="small muted">
            Automatic uses your phone's or browser's recognizer when there is one, otherwise Whisper on this device. No key needed.
          </span>
        </div>
        {engine === "whisper-local" && (
          <div className="field">
            <label htmlFor="whisper-size">On-device speech model</label>
            <select id="whisper-size" className="select" value={voice.localModel} onChange={(e) => set({ localModel: e.target.value as SpeechModel })}>
              {(Object.keys(SPEECH_MODELS) as SpeechModel[]).map((size) => (
                <option key={size} value={size}>
                  {SPEECH_MODELS[size].label} · {SPEECH_MODELS[size].mb} MB
                </option>
              ))}
            </select>
            {isMoonshine(voice.localModel) && (
              <span className="small muted">
                {speechModel !== voice.localModel
                  ? `Moonshine only understands English. Your system language is ${systemLanguage}, so ${SPEECH_MODELS[speechModel].label.split(":")[0]} is used instead.`
                  : "Moonshine transcribes short questions faster than Whisper, but only understands English. If it can't run on this device, Whisper takes over."}
              </span>
            )}
            {speechNotice && isMoonshine(voice.localModel) && <span className="small muted">{speechNotice}</span>}
            {systemLanguage.toLowerCase().startsWith("en") && (
              <span className="small muted">
                Live captions while you talk use Moonshine streaming ({CAPTION_MB} MB more, downloaded the first time voice mode opens; MIT licence).
              </span>
            )}
            <div className="btn-row" style={{ marginTop: 6 }}>
              {downloaded ? (
                <span className="status ok" style={{ marginTop: 0 }}>
                  Downloaded, ready offline
                </span>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={progress !== null}
                  onClick={() => {
                    setDownloadError(null);
                    preloadWhisper(voice.localModel)
                      .then(() => setDownloaded(true))
                      .catch((e) => setDownloadError((e as Error).message));
                  }}
                >
                  {progress !== null ? `Downloading… ${progress}%` : `Download now (${SPEECH_MODELS[speechModel].mb} MB)`}
                </button>
              )}
            </div>
            {downloadError && <span className="small error-text">{downloadError}</span>}
          </div>
        )}
        {voice.engine === "whisper-cloud" && (
          <div className="field-row">
            <div className="field">
              <label htmlFor="stt-provider">Provider</label>
              <select
                id="stt-provider"
                className="select"
                value={voice.providerId}
                onChange={(e) => {
                  const provider = providers.find((p) => p.id === e.target.value);
                  set({ providerId: e.target.value, model: TRANSCRIBE_MODEL_SUGGESTIONS[provider?.presetId ?? ""] ?? "whisper-1" });
                }}
              >
                <option value="">Choose…</option>
                {openaiLike.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="stt-model">Model</label>
              <ModelInput id="stt-model" value={voice.model} onChange={(model) => set({ model })} suggestions={["gpt-4o-mini-transcribe", "whisper-1", "whisper-large-v3-turbo"]} placeholder="whisper-1" />
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

/** API key, voice and model for a natural-voice service (Fish Audio, Cartesia, Deepgram). */
function CloudVoiceFields({ id, voice, set }: { id: CloudTts; voice: VoiceSettings; set: (patch: Partial<VoiceSettings>) => void }) {
  const service = CLOUD_TTS[id];
  const config = voice.cloudTts[id];
  const update = (patch: Partial<typeof config>) => set({ cloudTts: { ...voice.cloudTts, [id]: { ...config, ...patch } } });
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-key`}>
          {service.label} API key{" "}
          <a className="small" href={service.keyUrl} target="_blank" rel="noreferrer">
            Get a key
          </a>
        </label>
        <input id={`${id}-key`} className="input" type="password" autoComplete="off" value={config.key} onChange={(e) => update({ key: e.target.value.trim() })} />
      </div>
      <div className="field-row">
        {id !== "deepgram" && (
          <div className="field">
            <label htmlFor={`${id}-voice`}>Voice ID</label>
            <input id={`${id}-voice`} className="input" placeholder={service.voiceRequired ? "Required" : "Default voice"} value={config.voice} onChange={(e) => update({ voice: e.target.value.trim() })} />
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-model`}>{id === "deepgram" ? "Voice model" : "Model"}</label>
          <ModelInput id={`${id}-model`} value={config.model} onChange={(model) => update({ model })} suggestions={service.models} placeholder={service.models[0]} />
        </div>
      </div>
      <span className="small muted">{service.voiceHint}. Keys stay on this device.</span>
    </>
  );
}

/** Any HTTP text-to-speech service: URL, key, headers, body template and where the audio is. */
function CustomVoiceFields({ voice, set }: { voice: VoiceSettings; set: (patch: Partial<VoiceSettings>) => void }) {
  const current = customVoiceFor(voice)!;
  const [template, setTemplate] = useState("");
  const update = (patch: Partial<CustomVoice>) =>
    set({ customVoices: voice.customVoices.map((c) => (c.id === current.id ? { ...c, ...patch } : c)) });
  const applyTemplate = (id: string) => {
    setTemplate(id);
    const { hint: _hint, keyUrl: _keyUrl, ...shape } = CUSTOM_VOICE_TEMPLATES[id];
    update(shape);
  };
  const remove = () => set({ customVoices: voice.customVoices.filter((c) => c.id !== current.id), tts: "system" });
  const info = CUSTOM_VOICE_TEMPLATES[template];
  return (
    <div className="custom-voice">
      <div className="field">
        <label htmlFor="cv-template">Start from</label>
        <select id="cv-template" className="select" value={template} onChange={(e) => e.target.value && applyTemplate(e.target.value)}>
          <option value="">Choose a template (optional)…</option>
          {Object.entries(CUSTOM_VOICE_TEMPLATES).map(([id, t]) => (
            <option key={id} value={id}>
              {id === "blank" ? "Any other service (blank)" : t.name}
            </option>
          ))}
        </select>
        {info && (
          <span className="small muted">
            {info.hint}{" "}
            {info.keyUrl && (
              <a href={info.keyUrl} target="_blank" rel="noreferrer">
                Get a key
              </a>
            )}
          </span>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="cv-name">Name</label>
          <input id="cv-name" className="input" value={current.name} onChange={(e) => update({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cv-key">API key</label>
          <input id="cv-key" className="input" type="password" autoComplete="off" value={current.key} onChange={(e) => update({ key: e.target.value.trim() })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cv-url">Web address (POST)</label>
        <input id="cv-url" className="input" placeholder="https://api.example.com/v1/tts" value={current.url} onChange={(e) => update({ url: e.target.value.trim() })} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="cv-voice">Voice</label>
          <input id="cv-voice" className="input" value={current.voice} onChange={(e) => update({ voice: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cv-model">Model</label>
          <input id="cv-model" className="input" value={current.model} onChange={(e) => update({ model: e.target.value })} />
        </div>
      </div>
      <details>
        <summary className="small">Request and response details</summary>
        <div className="field">
          <label htmlFor="cv-headers">Headers (one "Name: value" per line)</label>
          <textarea id="cv-headers" className="textarea mono" rows={3} value={current.headers} onChange={(e) => update({ headers: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cv-body">Body</label>
          <textarea id="cv-body" className="textarea mono" rows={4} value={current.body} onChange={(e) => update({ body: e.target.value })} />
          <span className="small muted">
            {"{{text}}"}, {"{{voice}}"}, {"{{model}}"}, {"{{speed}}"} and {"{{key}}"} are filled in for each sentence (escaped for JSON or XML).
          </span>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="cv-response">The service replies with</label>
            <select id="cv-response" className="select" value={current.response} onChange={(e) => update({ response: e.target.value as CustomVoice["response"] })}>
              <option value="audio">An audio file (mp3, wav…)</option>
              <option value="json">JSON with base64 audio</option>
            </select>
          </div>
          {current.response === "json" && (
            <div className="field">
              <label htmlFor="cv-path">Audio is at</label>
              <input id="cv-path" className="input" placeholder="audios.0" value={current.audioPath} onChange={(e) => update({ audioPath: e.target.value.trim() })} />
            </div>
          )}
        </div>
      </details>
      <div className="btn-row">
        <button type="button" className="btn danger" onClick={remove}>
          Remove this voice service
        </button>
      </div>
      <span className="small muted">Keys stay on this device. Use Test voice below to check it.</span>
    </div>
  );
}

/** An on-device natural voice (Supertonic, Supertonic 3 or Kokoro): voice choice and a one-time download. */
function LocalVoiceFields({ voice, set }: { voice: VoiceSettings; set: (patch: Partial<VoiceSettings>) => void }) {
  const choice = localChoice(voice)!;
  const kokoro = choice.engine === "kokoro";
  const size = kokoro ? KOKORO_MB : choice.engine === "supertonic3" ? SUPERTONIC3_MB : LOCAL_VOICE_MB;
  const english = (typeof navigator === "undefined" ? "en" : navigator.language || "en").toLowerCase().startsWith("en");
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void localVoiceDownloaded(choice.engine).then(setDownloaded);
  }, [choice.engine]);
  useEffect(() => onLocalVoiceProgress(choice.engine, setProgress), [choice.engine]);
  const download = () => {
    setError("");
    setProgress(0);
    preloadLocalVoice(choice)
      .then(() => setDownloaded(true))
      .catch((e: Error) => setError(e.message))
      .finally(() => setProgress(null));
  };
  return (
    <>
      <div className="field">
        <label htmlFor="local-voice">Voice</label>
        <select
          id="local-voice"
          className="select"
          value={choice.voice}
          onChange={(e) => set(kokoro ? { kokoroVoice: e.target.value } : { localVoice: e.target.value })}
        >
          {(kokoro ? KOKORO_VOICES : LOCAL_VOICES).map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <div className="btn-row">
          {downloaded ? (
            <span className="small muted">Downloaded: works offline. Speech is generated on this computer; nothing is sent anywhere.</span>
          ) : (
            <>
              <button type="button" className="btn" onClick={download} disabled={progress !== null}>
                {progress !== null ? `Downloading… ${progress}%` : `Download voice (${size} MB, one time)`}
              </button>
              <span className="small muted">Until it's downloaded, replies use the device voice.</span>
            </>
          )}
        </div>
        {error && <span className="small error-text">{error}</span>}
        {kokoro ? (
          <span className="small muted">
            English only. The most natural on-device voice, but slower than Supertonic to start each sentence: about 3–5 seconds on an M1
            Mac, so replies begin after a pause. Uses the Kokoro-82M model (Apache-2.0) and eSpeak NG (GPL-3.0).
          </span>
        ) : choice.engine === "supertonic3" ? (
          <span className="small muted">
            Speaks 31 languages, including English, Spanish, French, German, Portuguese, Italian, Japanese, Korean, Hindi, Arabic and
            Russian. Each sentence is read in the language it's written in (your system language for Latin-script text that isn't
            English). Uses the Supertonic 3 model by Supertone (OpenRAIL-M licence: don't use it to impersonate people or to pass off
            speech as human).
          </span>
        ) : (
          <span className="small muted">
            English only{english ? "" : ": for your language, choose Supertonic 3"}. Uses the Supertonic model by Supertone (OpenRAIL-M licence).
          </span>
        )}
      </div>
    </>
  );
}
