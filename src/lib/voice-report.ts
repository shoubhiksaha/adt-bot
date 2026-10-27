// Settings → Voice → Save a report: voice-debug.log made fit to send to whoever helps with the app.
// What was said can be left out, and anything that looks like a key, an email address or a phone
// number is taken out. The person sees all of it before saving; the app never sends it anywhere.
import type { VoiceSettings } from "./types";

/** The most of the log a report holds (its latest part). */
export const REPORT_MAX_CHARS = 1_500_000;

export type ReportApp = { version: string; platform: string; arch: string; os: string; electron: string };

/** Words someone said, as voice-log.ts marks them. */
const SPOKEN = /⟦([^⟧]*)⟧/g;

// Logs from before 1.5.10 didn't mark what was said: the lines that carry words, by how they start.
const WORDS_AFTER = [
  "stopped by a short word",
  "stopped by a live caption",
  "other audio is playing and this wasn't addressed to the bot",
  "a step is running: this comes next",
  "stopped by what was heard",
  "joined to the request it carried on from",
  "live: asking",
];

function markOlder(message: string): string {
  if (message.includes("⟦")) return message;
  const heard = /^(heard \w+ )"(.*)"( \{.*\})$/.exec(message);
  if (heard) return `${heard[1]}⟦${heard[2]}⟧${heard[3]}`;
  const quiet = /^(words, but never louder than the leftover echo )(.*)( -?\d+)$/.exec(message);
  if (quiet) return `${quiet[1]}⟦${quiet[2]}⟧${quiet[3]}`;
  const after = WORDS_AFTER.find((start) => message.startsWith(`${start} `));
  if (after) return `${after} ⟦${message.slice(after.length + 1)}⟧`;
  return message.replace(/"(you|reply)":"((?:[^"\\]|\\.)*)"/g, '"$1":"⟦$2⟧"');
}

const digits = (s: string) => s.replace(/\D/g, "").length;

/** Keys, tokens, email addresses and phone numbers, wherever they are. */
export function scrub(text: string): string {
  return text
    .replace(/\bsk-ant-[\w-]{8,}/g, "[key]")
    .replace(/\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[\w-]{16,}/g, "[key]")
    .replace(/\bAIza[\w-]{20,}/g, "[key]")
    .replace(/\b(?:gsk|xai|ghp|gho|github_pat|hf|glpat)[_-][\w-]{16,}/g, "[key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[key]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [token]")
    .replace(/([?&](?:key|token|access_token|api_key|apikey|auth|sig|signature)=)[^&\s"']+/gi, "$1[key]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, "$1[hidden]")
    .replace(/\b[A-Za-z0-9_+]{32,}\b/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[code]" : m))
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\+\d[\d\s().-]{7,}\d/g, (m) => (digits(m) >= 10 ? "[phone]" : m));
}

/** Inside what was said, any long run of digits (a phone number said without the +). */
const scrubSaid = (said: string) => said.replace(/\d[\d\s().-]{7,}\d/g, (m) => (digits(m) >= 10 ? "[number]" : m));

const wordCount = (said: string) => {
  const n = said.split(/\s+/).filter(Boolean).length;
  return n ? `[${n} word${n === 1 ? "" : "s"}]` : "[nothing]";
};

/** One log line as it goes in a report. */
export function reportLine(line: string, leaveOutWords: boolean): string {
  const stamped = /^(\d{4}-\d\d-\d\dT[\d:.]+Z )(.*)$/.exec(line);
  const [stamp, message] = stamped ? [stamped[1], stamped[2]] : ["", line];
  const clean = scrub(markOlder(message)).replace(SPOKEN, (_, said: string) => (leaveOutWords ? wordCount(said) : `⟦${scrubSaid(said)}⟧`));
  return stamp + clean;
}

/** The voice settings that matter for a problem: never keys, addresses or the person's own voices. */
export function reportSettings(voice: VoiceSettings, serverVoice: boolean) {
  const { conversation, engine, localModel, model, tts, voiceName, rate, localVoice, kokoroVoice, ttsModel, ttsVoice, elevenModel } = voice;
  const { endSilence, bargeIn, earlyReply, concise, voiceModel, wakeWord, handsFree, look, liveModel, liveVoice } = voice;
  return {
    conversation,
    engine,
    localModel,
    model,
    tts: tts.startsWith("custom:") ? (serverVoice ? "your server" : "a voice service you added") : tts,
    voiceName,
    rate,
    localVoice,
    kokoroVoice,
    ttsModel,
    ttsVoice,
    elevenModel,
    endSilence,
    bargeIn,
    earlyReply,
    concise,
    voiceModel,
    wakeWord,
    handsFree,
    look,
    liveModel,
    liveVoice,
  };
}

const SYSTEMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** The log's part of a report (its latest part when it's long). */
export function reportLog(log: string, leaveOutWords: boolean): string {
  let lines = log.split("\n").filter((l) => l.trim());
  let dropped = 0;
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > REPORT_MAX_CHARS) {
      dropped = i + 1;
      lines = lines.slice(i + 1);
      break;
    }
  }
  if (!lines.length) return "--- voice-debug.log is empty: turn on Voice diagnostics, use voice mode until the problem happens, then save a report ---\n";
  return [
    `--- voice-debug.log, ${lines.length} lines${dropped ? ` (the ${dropped} oldest left out to keep the report small)` : ""} ---`,
    ...lines.map((l) => reportLine(l, leaveOutWords)),
    "",
  ].join("\n");
}

export function buildReport({
  log,
  app,
  settings,
  note,
  leaveOutWords,
  audio,
  savedAt = new Date(),
}: {
  /** From reportLog, with the same leaveOutWords. */
  log: string;
  app: ReportApp;
  settings: ReturnType<typeof reportSettings>;
  /** What went wrong, in the person's words. */
  note: string;
  leaveOutWords: boolean;
  /** The bot's voice going with the report, if any. */
  audio: { seconds: number; rate: number } | null;
  savedAt?: Date;
}): string {
  return [
    "ADT Bot voice report",
    `Saved: ${savedAt.toString()}`,
    `App: ADT Bot ${app.version} on ${SYSTEMS[app.platform] ?? app.platform} ${app.os} (${app.arch}), Electron ${app.electron}`,
    `Voice settings: ${JSON.stringify(settings)}`,
    leaveOutWords ? "What was said: left out (only how many words)" : "What was said: included, marked ⟦like this⟧",
    "Taken out: anything that looks like a key, a token, an email address or a phone number",
    audio ? `The bot's voice: the last ${audio.seconds.toFixed(1)} s it played, in bot-voice.wav (${audio.rate} Hz)` : "The bot's voice: not included",
    "",
    "What went wrong:",
    note.trim() ? scrub(note.trim()) : "(not described)",
    "",
    log,
  ].join("\n");
}

// A zip of files stored as they are (no compression: one file to send, sound and text together) ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipFiles(files: { name: string; data: Uint8Array }[], date = new Date()): Uint8Array {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // UTF-8 names
    l.setUint16(10, time, true);
    l.setUint16(12, day, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, file.data.length, true);
    l.setUint32(22, file.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint16(8, 0x0800, true);
    e.setUint16(12, time, true);
    e.setUint16(14, day, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, file.data.length, true);
    e.setUint32(24, file.data.length, true);
    e.setUint16(28, name.length, true);
    e.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(local, file.data);
    directory.push(entry);
    offset += local.length + file.data.length;
  }
  const directorySize = directory.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, directorySize, true);
  v.setUint32(16, offset, true);
  const all = [...parts, ...directory, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
