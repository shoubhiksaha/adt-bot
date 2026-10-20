// Voice providers the user adds themselves: any HTTP text-to-speech API, described by a URL, headers and
// a body template, plus where the audio is in the response.

/** A reply-voice service added in Settings → Voice. */
export type CustomVoice = {
  id: string;
  name: string;
  url: string;
  /** One "Name: value" per line. */
  headers: string;
  /** Request body; {{text}}, {{voice}}, {{model}}, {{speed}} and {{key}} are filled in per sentence. */
  body: string;
  /** "audio": the response is the audio file. "json": base64 audio inside JSON, at `audioPath`. */
  response: "audio" | "json";
  /** Dotted path to the base64 audio, e.g. "audioContent" or "audios.0". */
  audioPath: string;
  key: string;
  voice: string;
  model: string;
};

export type CustomVoiceTemplate = Omit<CustomVoice, "id" | "key"> & { keyUrl?: string; hint: string };

/** Ready-made shapes for popular services; everything stays editable. */
export const CUSTOM_VOICE_TEMPLATES: Record<string, CustomVoiceTemplate> = {
  sarvam: {
    name: "Sarvam AI",
    hint: "Indian languages. Voice = speaker (e.g. anushka); set language_code in the body (en-IN, hi-IN, bn-IN…).",
    keyUrl: "https://dashboard.sarvam.ai/",
    url: "https://api.sarvam.ai/text-to-speech",
    headers: "api-subscription-key: {{key}}\ncontent-type: application/json",
    body: '{"text": "{{text}}", "language_code": "en-IN", "speaker": "{{voice}}", "model": "{{model}}", "pace": {{speed}}, "output_audio_codec": "mp3"}',
    response: "json",
    audioPath: "audios.0",
    voice: "anushka",
    model: "bulbul:v3",
  },
  google: {
    name: "Google Cloud Text-to-Speech",
    hint: "Voice = voice name (e.g. en-US-Neural2-F, en-IN-Neural2-A); the language code is in the body.",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    url: "https://texttospeech.googleapis.com/v1/text:synthesize",
    headers: "x-goog-api-key: {{key}}\ncontent-type: application/json",
    body: '{"input": {"text": "{{text}}"}, "voice": {"languageCode": "en-US", "name": "{{voice}}"}, "audioConfig": {"audioEncoding": "MP3", "speakingRate": {{speed}}}}',
    response: "json",
    audioPath: "audioContent",
    voice: "en-US-Neural2-F",
    model: "",
  },
  azure: {
    name: "Azure AI Speech",
    hint: "Replace eastus in the URL with your resource's region. Voice = voice name (e.g. en-US-AvaMultilingualNeural).",
    keyUrl: "https://portal.azure.com/",
    url: "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
    headers: "Ocp-Apim-Subscription-Key: {{key}}\ncontent-type: application/ssml+xml\nX-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3",
    body: '<speak version="1.0" xml:lang="en-US"><voice name="{{voice}}"><prosody rate="{{speed}}">{{text}}</prosody></voice></speak>',
    response: "audio",
    audioPath: "",
    voice: "en-US-AvaMultilingualNeural",
    model: "",
  },
  blank: {
    name: "My voice service",
    hint: "Any HTTP text-to-speech API. Use {{text}}, {{voice}}, {{model}}, {{speed}} and {{key}} anywhere below.",
    url: "https://",
    headers: "authorization: Bearer {{key}}\ncontent-type: application/json",
    body: '{"text": "{{text}}", "voice": "{{voice}}", "model": "{{model}}"}',
    response: "audio",
    audioPath: "",
    voice: "",
    model: "",
  },
};

export function newCustomVoice(template: keyof typeof CUSTOM_VOICE_TEMPLATES = "blank"): CustomVoice {
  const { hint: _hint, keyUrl: _keyUrl, ...shape } = CUSTOM_VOICE_TEMPLATES[template] ?? CUSTOM_VOICE_TEMPLATES.blank;
  return { id: crypto.randomUUID().slice(0, 8), key: "", ...shape };
}

type Escape = (value: string) => string;
const jsonEscape: Escape = (v) => JSON.stringify(v).slice(1, -1);
const xmlEscape: Escape = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function fill(template: string, values: Record<string, string>, escape: Escape): string {
  return template.replace(/\{\{\s*(text|voice|model|speed|key)\s*\}\}/g, (_, name: string) => escape(values[name] ?? ""));
}

export function parseHeaderLines(text: string): [string, string][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf(":");
      return at > 0 ? ([line.slice(0, at).trim(), line.slice(at + 1).trim()] as [string, string]) : null;
    })
    .filter((h): h is [string, string] => Boolean(h));
}

/** The HTTP request for one sentence. Values are escaped for where they land (URL, JSON, XML). */
export function buildCustomRequest(voice: CustomVoice, text: string, rate: number): { url: string; headers: Record<string, string>; body: string } {
  const values = { text, voice: voice.voice, model: voice.model, speed: String(Math.round(rate * 100) / 100), key: voice.key };
  const headers = Object.fromEntries(parseHeaderLines(fill(voice.headers, values, (v) => v.replace(/[\r\n]/g, ""))));
  const type = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  // A form body (a=1&b=2) gets each value URL-encoded: "&voice=…" in the text stays text.
  const form = /x-www-form-urlencoded/i.test(type) || (!type && /^[\w.-]+=[^&]*(&[\w.-]+=[^&]*)*$/.test(voice.body.trim()));
  const bodyEscape: Escape = /json/i.test(type) || /^\s*[[{]/.test(voice.body) ? jsonEscape : /xml|ssml/i.test(type) || /^\s*</.test(voice.body) ? xmlEscape : form ? encodeURIComponent : (v) => v;
  return { url: fill(voice.url, values, encodeURIComponent), headers, body: fill(voice.body, values, bodyEscape) };
}

/** Reads the audio out of a JSON response ("audios.0", "audioContent", "data.audio"…). */
export function audioFromJson(json: unknown, path: string): ArrayBuffer {
  let value: unknown = json;
  for (const part of path.split(".").filter(Boolean)) value = (value as Record<string, unknown> | undefined)?.[part];
  if (typeof value !== "string" || !value) throw new Error(`No audio at "${path}" in the response.`);
  const base64 = value.replace(/^data:[^,]*,/, "");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return bytes.buffer;
}
