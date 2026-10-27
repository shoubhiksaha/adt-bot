import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, crc32, REPORT_MAX_CHARS, reportLine, reportLog, reportSettings, scrub, zipFiles } from "./voice-report";
import { keepLast, wavFile } from "./voice-recording";
import { spoken } from "./voice-log";
import type { VoiceSettings } from "./types";

const T = "2026-10-27T09:41:12.345Z ";

describe("voice report lines", () => {
  it("leaves out what was said, marked or from an older log, as a word count", () => {
    expect(reportLine(`${T}heard utterance ${spoken("tell me if I left the oven on")} {"phase":"listening","mic":-41}`, true)).toBe(
      `${T}heard utterance [8 words] {"phase":"listening","mic":-41}`,
    );
    // 1.5.9 and before: quoted, not marked.
    expect(reportLine(`${T}heard utterance "tell me if I left the oven on" {"phase":"listening","mic":-41}`, true)).toBe(
      `${T}heard utterance [8 words] {"phase":"listening","mic":-41}`,
    );
    expect(reportLine(`${T}stopped by a short word stop`, true)).toBe(`${T}stopped by a short word [1 word]`);
    expect(reportLine(`${T}words, but never louder than the leftover echo the weather today -38`, true)).toBe(
      `${T}words, but never louder than the leftover echo [3 words] -38`,
    );
    expect(reportLine(`${T}live: asking Can I use your browser to open example.com? Say yes or no.`, true)).toBe(`${T}live: asking [12 words]`);
    expect(reportLine(`${T}live: complete {"you":"what's the \\"weather\\"","reply":"","sound":{"pieces":3},"mic":0.1}`, true)).toBe(
      `${T}live: complete {"you":"[3 words]","reply":"[nothing]","sound":{"pieces":3},"mic":0.1}`,
    );
  });

  it("keeps what was said when asked to, marked", () => {
    expect(reportLine(`${T}heard final "go ahead" {"phase":"hearing"}`, false)).toBe(`${T}heard final ⟦go ahead⟧ {"phase":"hearing"}`);
    expect(reportLine(`${T}stopped by what was heard ${spoken("wait")}`, false)).toBe(`${T}stopped by what was heard ⟦wait⟧`);
  });

  it("leaves lines without words alone", () => {
    const lines = [
      `${T}cut-in check STOP {"echoGap":-52,"cancelled":8,"gaps":14,"noise":-62,"mic":"-41 -40 -39 -45 -47 -38 -40 -41 -42","out":"-30 -31 -29 -33 -35 -30 -31 -32 -30"}`,
      `${T}echo {"mic":-60,"out":-31,"recentOut":-30}`,
      `${T}other audio playing Spotify, com.google.Chrome`,
      `${T}live: connected {"model":"models/gemini-2.5-flash-native-audio-preview-09-2025","voice":"Puck","tools":12}`,
      `${T}=== ADT Bot 1.5.10 (darwin arm64)`,
    ];
    for (const line of lines) expect(reportLine(line, true)).toBe(line);
  });

  it("takes out keys, tokens, email addresses and phone numbers", () => {
    expect(scrub("live: failed wss://x/ws?key=AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW&alt=1")).toBe("live: failed wss://x/ws?key=[key]&alt=1");
    expect(scrub("error sk-ant-api03-abcdefghijklmnop and sk-proj-abcdefghijklmnopqrstuv")).toBe("error [key] and [key]");
    expect(scrub("Authorization: Bearer abc.def.ghi123456")).not.toContain("abc.def");
    expect(scrub('{"token":"s3cr3t-value"}')).toBe('{"token":"[hidden]"}');
    expect(scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe("[token]");
    expect(scrub("id 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe("id [code]");
    expect(scrub("mail shoubhik.test@example.co.in now")).toBe("mail [email] now");
    expect(scrub("call +91 93306 61906 please")).toBe("call [phone] please");
    // Not phone numbers: dates, levels, short numbers.
    expect(scrub("on 2026-10-27 at -41 -40 -39 -45 -47")).toBe("on 2026-10-27 at -41 -40 -39 -45 -47");
  });

  it("takes out a phone number said without the + (only in what was said)", () => {
    expect(reportLine(`${T}heard utterance ${spoken("message 93306 61906 on WhatsApp")} {"mic":-40}`, false)).toBe(
      `${T}heard utterance ⟦message [number] on WhatsApp⟧ {"mic":-40}`,
    );
    expect(reportLine(`${T}heard utterance ${spoken("my key is sk-ant-api03-abcdefghijklmnop")} {"mic":-40}`, false)).toBe(
      `${T}heard utterance ⟦my key is [key]⟧ {"mic":-40}`,
    );
  });
});

describe("voice report", () => {
  const voice = {
    conversation: "gemini-live",
    engine: "whisper-local",
    tts: "custom:abc",
    elevenKey: "el-secret-key",
    cloudTts: { fish: { key: "fish-secret", voice: "x", model: "y" } },
    customVoices: [{ id: "abc", url: "https://my.server/tts", headers: "Authorization: Bearer zzz" }],
    liveModel: "gemini-2.5-flash-native-audio",
  } as unknown as VoiceSettings;

  it("has the settings that matter, never keys or addresses", () => {
    const settings = reportSettings(voice, false);
    const text = JSON.stringify(settings);
    expect(settings).toMatchObject({ conversation: "gemini-live", engine: "whisper-local", tts: "a voice service you added" });
    expect(text).not.toMatch(/secret|my\.server|zzz/);
    expect(reportSettings(voice, true).tts).toBe("your server");
  });

  it("puts the app, settings, the person's note and the log together", () => {
    const log = `${T}=== ADT Bot 1.5.10 (darwin arm64)\n${T}heard utterance ${spoken("hello there")} {"mic":-40}\n\n`;
    const report = buildReport({
      log: reportLog(log, true),
      app: { version: "1.5.10", platform: "darwin", arch: "arm64", os: "27.0", electron: "38.1.0" },
      settings: reportSettings(voice, false),
      note: "A siren after I asked about the weather. Reach me at someone@example.com",
      leaveOutWords: true,
      audio: { seconds: 9.98, rate: 48000 },
    });
    expect(report).toContain("App: ADT Bot 1.5.10 on macOS 27.0 (arm64), Electron 38.1.0");
    expect(report).toContain("What was said: left out");
    expect(report).toContain("the last 10.0 s it played, in bot-voice.wav (48000 Hz)");
    expect(report).toContain("A siren after I asked about the weather. Reach me at [email]");
    expect(report).toContain("--- voice-debug.log, 2 lines ---");
    expect(report).toContain(`${T}heard utterance [2 words] {"mic":-40}`);
    expect(report).not.toContain("hello there");
  });

  it("says so when the log is empty, and keeps only the latest part of a long one", () => {
    expect(reportLog("", false)).toContain("voice-debug.log is empty");
    const line = `${T}echo {"mic":-60,"out":-31,"recentOut":-30}`;
    const lines = Math.ceil(REPORT_MAX_CHARS / line.length) + 100;
    const part = reportLog(Array.from({ length: lines }, () => line).join("\n"), false);
    expect(part.length).toBeLessThanOrEqual(REPORT_MAX_CHARS + 200);
    expect(part).toMatch(/oldest left out to keep the report small/);
  });
});

describe("the bot's voice for a report", () => {
  it("keeps the last pieces up to the limit", () => {
    const list: Float32Array[] = [];
    for (let i = 0; i < 10; i++) keepLast(list, new Float32Array(100).fill(i), 350);
    expect(list.map((p) => p[0])).toEqual([6, 7, 8, 9]);
  });

  it("makes a 16-bit WAV", () => {
    const wav = wavFile(new Float32Array([0, 0.5, -1, 2]), 24000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 16384, -32767, 32767]);
  });
});

describe("zip", () => {
  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("makes an archive unzip can read", () => {
    let unzip = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzip = false;
    }
    if (!unzip) return;
    const dir = mkdtempSync(join(tmpdir(), "voice-report-"));
    try {
      const wav = wavFile(new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5), 48000);
      const file = join(dir, "report.zip");
      writeFileSync(file, zipFiles([{ name: "report.txt", data: new TextEncoder().encode("hello ⟦world⟧\n") }, { name: "bot-voice.wav", data: wav }]));
      expect(execFileSync("unzip", ["-t", file]).toString()).toMatch(/No errors detected/);
      execFileSync("unzip", ["-o", "-q", file, "-d", join(dir, "out")]);
      expect(readFileSync(join(dir, "out", "report.txt"), "utf8")).toBe("hello ⟦world⟧\n");
      expect(Buffer.compare(readFileSync(join(dir, "out", "bot-voice.wav")), Buffer.from(wav))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
