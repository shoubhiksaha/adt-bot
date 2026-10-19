import { AudioLines, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { updateSettings, useStore } from "../../lib/store";
import { CUSTOM_VOICE_TEMPLATES, type CustomVoice, newCustomVoice } from "../../lib/custom-tts";
import { bestVoice, CLOUD_TTS, customVoiceFor, type DeviceVoice, listVoices, OPENAI_TTS_VOICES, rankVoice } from "../../lib/tts";
import type { CloudTts, VoiceSettings } from "../../lib/types";
import { ENGINE_LABELS, resolveEngine, speak, TRANSCRIBE_MODEL_SUGGESTIONS } from "../../lib/voice";
import { onWhisperProgress, preloadWhisper, WHISPER_SIZES, whisperDownloaded } from "../../lib/whisper";
import { ModelInput, Section, Toggle } from "./controls";

export function VoiceSettings() {
  const providers = useStore((s) => s.providers);
  const voice = useStore((s) => s.settings.voice);
  const autoSpeak = useStore((s) => s.settings.autoSpeak);
  const useProxy = useStore((s) => s.settings.useProxy);
  const bots = useStore((s) => s.bots);
  const [voices, setVoices] = useState<DeviceVoice[]>([]);
  const [autoVoice, setAutoVoice] = useState<string>("");
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const openaiLike = providers.filter((p) => p.kind === "openai");
  const engine = resolveEngine(voice, providers);
  const set = (patch: Partial<typeof voice>) => updateSettings({ voice: { ...voice, ...patch } });
  const wakeName = bots[0]?.nickname?.trim() || bots[0]?.name || "ADT";

  useEffect(() => {
    void listVoices().then(setVoices).catch(() => setVoices([]));
    void bestVoice("").then((v) => setAutoVoice(v?.name ?? ""));
  }, []);
  useEffect(() => {
    void whisperDownloaded(voice.localModel).then((yes) => setDownloaded(yes));
  }, [voice.localModel]);
  useEffect(() => onWhisperProgress((p) => setProgress(p ? Math.round(p.progress) : null)), []);

  const sortedVoices = [...voices].sort((a, b) => rankVoice(b) - rankVoice(a) || a.name.localeCompare(b.name));
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
            🎤 dictates into the message box · <AudioLines size={12} /> starts hands-free voice mode. Listening with {ENGINE_LABELS[engine]}.
          </div>
        </div>
      </div>

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
            <span className="small muted">
              On a Mac, nicer voices are free: System Settings → Accessibility → Spoken Content → System voice → Manage voices, then add a
              “Premium” or “Enhanced” voice. It's picked automatically.
            </span>
          </div>
        )}

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
        <Toggle checked={autoSpeak} onChange={(v) => updateSettings({ autoSpeak: v })} title="Read every reply aloud" hint="Also speak answers in normal chats, not just in voice mode." />
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
            <option value="whisper-local">Whisper on this device (private, works offline)</option>
            <option value="whisper-cloud">Cloud Whisper (OpenAI, Groq, your server…)</option>
          </select>
          <span className="small muted">
            Automatic uses your phone's or browser's recognizer when there is one, otherwise Whisper on this device. No key needed.
          </span>
        </div>
        {engine === "whisper-local" && (
          <div className="field">
            <label htmlFor="whisper-size">On-device Whisper model</label>
            <select id="whisper-size" className="select" value={voice.localModel} onChange={(e) => set({ localModel: e.target.value as typeof voice.localModel })}>
              {(Object.keys(WHISPER_SIZES) as (keyof typeof WHISPER_SIZES)[]).map((size) => (
                <option key={size} value={size}>
                  {WHISPER_SIZES[size].label} · {WHISPER_SIZES[size].mb} MB
                </option>
              ))}
            </select>
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
                  {progress !== null ? `Downloading… ${progress}%` : "Download now"}
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
