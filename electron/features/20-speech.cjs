// The Mac's built-in voices, rendered to audio for the page to play. Played by the page, the voice
// reaches the microphone's echo canceller (and the orb, and the volume dip when the user cuts in);
// spoken by the system it bypasses all three, so in voice mode the bot could hear itself.
//
// The speech helper (electron/native/speech-helper.swift) keeps a synthesizer warm and renders a
// sentence in about 0.1 s. Without it, `say` renders to a file (about a second per sentence).
const { spawn } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const SAMPLE_RATE = 24000;
/** A quiet helper is stopped after this long; it holds a voice in memory. */
const HELPER_IDLE_MS = 10 * 60_000;
const running = new Set();

function helperPath() {
  const candidates = [path.join(__dirname, "..", "..", "build", "native", "adt-speech-helper")];
  if (process.resourcesPath) candidates.unshift(path.join(process.resourcesPath, "bin", "adt-speech-helper"));
  return candidates.find((file) => fsSync.existsSync(file)) ?? null;
}

let helper = null;
/** The helper died before ever answering (bad signature, killed at launch): use `say` instead. */
let helperBroken = false;

function startHelper() {
  const file = helperPath();
  if (!file || helperBroken) return null;
  const child = spawn(file, [], { stdio: ["pipe", "pipe", "ignore"] });
  const h = { child, pending: new Map(), buffer: "", next: 1, idle: null };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    h.buffer += chunk;
    let index;
    while ((index = h.buffer.indexOf("\n")) !== -1) {
      const line = h.buffer.slice(0, index);
      h.buffer = h.buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      h.answered = true;
      h.pending.get(message.id)?.(message);
    }
  });
  child.stdin.on("error", () => undefined);
  const gone = () => {
    if (!h.answered && !h.stopped) helperBroken = true;
    if (helper === h) helper = null;
    clearTimeout(h.idle);
    for (const settle of h.pending.values()) settle({ error: "The speech helper stopped." });
    h.pending.clear();
  };
  child.on("error", gone);
  child.on("exit", gone);
  return h;
}

function stopHelper() {
  const h = helper;
  helper = null;
  if (!h) return;
  h.stopped = true;
  h.child.kill("SIGKILL");
}

/** WAV bytes from the speech helper, or null when there's no helper. */
function helperRender({ text, voice, lang, rate }) {
  helper ??= startHelper();
  const h = helper;
  if (!h) return null;
  clearTimeout(h.idle);
  h.idle = setTimeout(() => helper === h && h.pending.size === 0 && stopHelper(), HELPER_IDLE_MS);
  const id = h.next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      reject(new Error("The speech helper took too long"));
    }, 20_000);
    h.pending.set(id, (message) => {
      clearTimeout(timer);
      h.pending.delete(id);
      if (message.wav) resolve(new Uint8Array(Buffer.from(message.wav, "base64")));
      else reject(new Error(message.error || "The speech helper failed"));
    });
    const payload = { id, text, voice: typeof voice === "string" ? voice : undefined, lang: typeof lang === "string" ? lang : undefined, rate: typeof rate === "number" && Number.isFinite(rate) ? Math.min(3, Math.max(0.3, rate)) : 1 };
    h.child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

let installed = null;
/** Voices `say` knows: "Samantha" en_US, "Eddy (English (US))" en_US, "Ava (Premium)" en_US… */
function voices() {
  installed ??= new Promise((resolve) => {
    const child = spawn("/usr/bin/say", ["-v", "?"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve([]));
    child.on("close", () =>
      resolve(
        out
          .split("\n")
          .map((line) => line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,4})\s+#/))
          .filter(Boolean)
          .map(([, name, lang]) => ({ name: name.trim(), lang: lang.replace("_", "-").toLowerCase() })),
      ),
    );
  });
  return installed;
}

const plain = (name) => name.replace(/\s*\(.*\)\s*$/, "");

/**
 * The `say` name for a voice from speechSynthesis.getVoices(). Unknown names are refused: `say`
 * would quietly use the default voice instead, so the app speaks it the old way.
 */
async function sayVoice(name, lang) {
  if (typeof name !== "string" || !name) return null;
  const list = await voices();
  if (list.some((v) => v.name === name)) return name;
  // "Eddy" exists in a dozen languages: take the one for the voice's language.
  const same = list.filter((v) => plain(v.name) === plain(name));
  const wanted = String(lang ?? "").toLowerCase();
  const match = same.find((v) => v.lang === wanted) ?? same.find((v) => v.lang.split("-")[0] === wanted.split("-")[0]) ?? (same.length === 1 ? same[0] : null);
  if (!match) throw new Error(`The voice "${name}" isn't available to render`);
  return match.name;
}

/** One sentence (or a few) as 16-bit mono WAV bytes. */
async function render({ text, voice, lang, rate }) {
  const words = String(text ?? "").slice(0, 4000);
  if (!words.trim()) throw new Error("Nothing to say");
  try {
    const wav = await helperRender({ text: words, voice, lang, rate });
    if (wav) return wav;
  } catch (error) {
    console.warn("Speech helper:", error.message);
  }
  return renderWithSay({ words, voice, lang, rate });
}

async function renderWithSay({ words, voice, lang, rate }) {
  const file = path.join(os.tmpdir(), `adt-speech-${crypto.randomUUID()}.wav`);
  const args = ["-o", file, "--file-format=WAVE", `--data-format=LEI16@${SAMPLE_RATE}`];
  // Passed as its own argument, never through a shell.
  const name = await sayVoice(voice, lang);
  if (name) args.push("-v", name);
  // speechSynthesis rate 1 is about 180 words a minute.
  if (typeof rate === "number" && Number.isFinite(rate) && rate !== 1) args.push("-r", String(Math.round(180 * Math.min(3, Math.max(0.3, rate)))));
  // The text goes in on stdin, so words starting with "-" are never read as options.
  args.push("-f", "-");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/say", args, { stdio: ["pipe", "ignore", "pipe"] });
    running.add(child);
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      running.delete(child);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      running.delete(child);
      try {
        if (code !== 0) throw new Error(errors.trim() || `say exited with ${code}`);
        resolve(new Uint8Array(await fs.readFile(file)));
      } catch (error) {
        reject(error);
      } finally {
        fs.rm(file, { force: true }).catch(() => undefined);
      }
    });
    child.stdin.end(words);
  });
}

exports.register = ({ app, ipcMain, onStopAll }) => {
  if (process.platform !== "darwin") return;
  ipcMain.handle("adt:speech:render", (_event, payload) => render(payload ?? {}));
  // Voice mode is opening: load the voice now, so the first sentence of the reply isn't slow.
  ipcMain.handle("adt:speech:warm", async (_event, payload) => {
    await helperRender({ ...(payload ?? {}), text: "Hi." })?.catch(() => undefined);
  });
  onStopAll(() => {
    running.forEach((child) => child.kill("SIGKILL"));
    stopHelper();
  });
  app.on("will-quit", stopHelper);
};

exports.render = render;
