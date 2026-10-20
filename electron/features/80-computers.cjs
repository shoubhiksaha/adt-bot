// Computers: every bot can have its own small Linux computer, a Docker container on this machine.
// The app decides what may run (approvals live in src/lib/agent/approvals.ts); this side only talks
// to the Docker engine through the `docker` CLI (Docker Desktop, colima, OrbStack, or Podman's
// docker-compatible CLI). Every docker call is spawned with an argv array, never through a host
// shell, so nothing a bot or a file name contains is interpreted on the host.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const IMAGE = "adtbot-computer:1";
const BROWSER_IMAGE = "adtbot-computer:1-browser";
const LABEL = "adtbot=1";
const MAX_OUTPUT = 200_000;
const MAX_READ = 400_000;
const MAX_WRITE = 5_000_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const LIMITS = { cpus: "1", memory: "1g", pids: "512" };
/** Root inside the container still can't do much without these; only added for "admin installs". */
const ADMIN_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"];

/** The computer image: Debian slim with the usual tools, a non-root user `bot` and /workspace. */
const DOCKERFILE = `FROM debian:bookworm-slim
ARG BROWSER=0
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \\
 && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 python3-venv nodejs procps less unzip xz-utils \\
 && if [ "$BROWSER" = "1" ]; then apt-get install -y --no-install-recommends chromium fonts-dejavu-core; fi \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd -m -s /bin/bash -u 1000 bot \\
 && mkdir -p /workspace \\
 && chown bot:bot /workspace
ENV HOME=/home/bot
USER bot
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;

// Finding docker ---------------------------------------------------------------------------------

/** Apps opened from the Dock don't get the shell PATH, so look where the usual installers put it. */
function candidateDirs() {
  const home = os.homedir();
  const fromPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const known =
    process.platform === "win32"
      ? ["C:\\Program Files\\Docker\\Docker\\resources\\bin", "C:\\Program Files\\RedHat\\Podman"]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          path.join(home, ".orbstack", "bin"),
          path.join(home, ".docker", "bin"),
          path.join(home, ".rd", "bin"),
          "/Applications/Docker.app/Contents/Resources/bin",
          "/opt/podman/bin",
        ];
  return [...new Set([...fromPath, ...known])];
}

let cachedBinary = null;

function findBinary() {
  if (cachedBinary && fs.existsSync(cachedBinary.path)) return cachedBinary;
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const name of ["docker", "podman"]) {
    for (const dir of candidateDirs()) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        cachedBinary = { path: file, name };
        return cachedBinary;
      } catch {}
    }
  }
  return null;
}

/** The docker CLI needs its helpers (credential stores, colima/OrbStack contexts) on PATH too. */
function dockerEnv() {
  return { ...process.env, PATH: candidateDirs().join(path.delimiter) };
}

// Pure helpers (unit tested) ---------------------------------------------------------------------

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*. Anything else gets replaced plus a short hash. */
function safeId(botId) {
  const raw = String(botId ?? "");
  let clean = raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 48);
  if (!clean || clean !== raw) clean = `${clean ? `${clean.replace(/-+$/, "")}-` : "bot-"}${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8)}`;
  return clean;
}

const containerName = (botId) => `adtbot-${safeId(botId)}`;
const volumeName = (botId) => `adtbot-ws-${safeId(botId)}`;

/** Normalises a bot's computer settings to the fields that affect how the container is created. */
function normaliseConfig(config = {}) {
  return {
    network: config.network !== false,
    browser: Boolean(config.browser),
    admin: Boolean(config.admin),
    sharedFolder: typeof config.sharedFolder === "string" && config.sharedFolder.trim() ? config.sharedFolder.trim() : "",
    sharedWritable: Boolean(config.sharedWritable),
  };
}

/** Changing any of these needs a new container (files in /workspace are kept). */
function configHash(config) {
  return crypto.createHash("sha1").update(JSON.stringify(normaliseConfig(config))).digest("hex").slice(0, 12);
}

/** A folder from this machine, mounted at /shared. Refuses paths docker's --mount syntax can't carry. */
function validateSharedFolder(folder) {
  if (!folder) return null;
  if (!path.isAbsolute(folder)) return "The shared folder must be a full path.";
  if (/[,\n\r\0"]/.test(folder)) return "The shared folder's path can't contain commas, quotes or line breaks.";
  const resolved = path.resolve(folder);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) return "Share a specific folder, not the whole disk or home folder.";
  // Folders that hold keys, app data or every user's files: a bot in the container could read or change them.
  const home = os.homedir();
  if (resolved === path.dirname(home)) return "Share a specific folder, not every user's home folder.";
  const sensitive = [
    path.join(home, "Library"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, "AppData"),
    "/etc",
    "/var",
    "/private",
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/root",
    "/Applications",
  ];
  const lower = (p) => (process.platform === "linux" ? p : p.toLowerCase());
  // iCloud Drive lives under ~/Library but holds ordinary documents.
  const icloud = path.join(home, "Library", "Mobile Documents");
  if (lower(resolved).startsWith(lower(icloud) + path.sep) && !path.basename(resolved).startsWith(".")) return null;
  for (const dir of sensitive) {
    if (lower(resolved) === lower(dir) || lower(resolved).startsWith(lower(dir) + path.sep)) return `Don't share ${dir} (it holds keys, settings or system files). Pick a project folder.`;
  }
  if (path.basename(resolved).startsWith(".")) return "Don't share a hidden folder (they hold keys and settings). Pick a project folder.";
  return null;
}

function createArgs(botId, config) {
  const c = normaliseConfig(config);
  const args = [
    "create",
    "--name", containerName(botId),
    "--label", LABEL,
    "--label", `adtbot.bot=${String(botId)}`,
    "--label", `adtbot.config=${configHash(c)}`,
    "--hostname", "computer",
    "--init",
    "--cpus", LIMITS.cpus,
    "--memory", LIMITS.memory,
    "--memory-swap", LIMITS.memory,
    "--pids-limit", LIMITS.pids,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "bot",
    "--workdir", "/workspace",
    "--mount", `type=volume,source=${volumeName(botId)},target=/workspace`,
  ];
  if (c.admin) for (const cap of ADMIN_CAPS) args.push("--cap-add", cap);
  if (!c.network) args.push("--network", "none");
  if (c.sharedFolder) {
    const problem = validateSharedFolder(c.sharedFolder);
    if (problem) throw new Error(problem);
    args.push("--mount", `type=bind,source=${path.resolve(c.sharedFolder)},target=/shared${c.sharedWritable ? "" : ",readonly"}`);
  }
  args.push(c.browser ? BROWSER_IMAGE : IMAGE);
  return args;
}

/** Paths inside the container: relative ones are under /workspace. Always absolute, so never an option. */
function containerPath(input) {
  const raw = String(input ?? "").trim() || "/workspace";
  if (raw.includes("\0")) throw new Error("Invalid path.");
  const full = raw === "~" ? "/home/bot" : raw.startsWith("~/") ? `/home/bot/${raw.slice(2)}` : raw.startsWith("/") ? raw : `/workspace/${raw}`;
  return path.posix.normalize(full).replace(/(.)\/+$/, "$1");
}

const safeRunId = (runId) => String(runId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || crypto.randomUUID();

function clampTimeout(ms) {
  const n = Number(ms);
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS));
}

/**
 * docker exec for one command. The command is a single argv element handed to bash *inside* the
 * container. The wrapper records the pid (for cancel) and lets coreutils `timeout` stop it there.
 */
function execArgs(name, { command, runId, timeoutMs, cwd, root = false }) {
  const secs = String(Math.ceil(clampTimeout(timeoutMs) / 1000));
  return [
    "exec", "-i",
    "-u", root ? "root" : "bot",
    "-w", containerPath(cwd || "/workspace"),
    name,
    "bash", "-c", 'echo $$ > "/tmp/.adtbot-run-$1"; exec timeout -k 5 "$2" bash -lc "$3"',
    "adtbot", safeRunId(runId), secs, String(command ?? ""),
  ];
}

function cancelArgs(name, runId, root = false) {
  return ["exec", "-u", root ? "root" : "bot", name, "sh", "-c", 'p=$(cat "/tmp/.adtbot-run-$1" 2>/dev/null) && kill -TERM "$p"; rm -f "/tmp/.adtbot-run-$1"', "adtbot", safeRunId(runId)];
}

const readArgs = (name, file, maxBytes) => [
  "exec", "-u", "bot", name, "sh", "-c", 'stat -c %s -- "$1" && head -c "$2" -- "$1"', "adtbot", containerPath(file), String(maxBytes + 1),
];

const writeArgs = (name, file, append) => [
  "exec", "-i", "-u", "bot", name, "sh", "-c",
  append ? 'mkdir -p -- "$(dirname -- "$1")" && cat >> "$1"' : 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
  "adtbot", containerPath(file),
];

const listArgs = (name, dir) => ["exec", "-u", "bot", name, "find", containerPath(dir), "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\t%s\\t%T@\\t%f\\n"];

/** Keeps the first `max` characters of a stream and remembers that the rest was dropped. */
function createCap(max = MAX_OUTPUT) {
  let text = "";
  let cut = false;
  return {
    /** Returns the part of the chunk that was kept ("" once full). */
    push(chunk) {
      const s = String(chunk);
      if (cut) return "";
      const room = max - text.length;
      if (s.length <= room) {
        text += s;
        return s;
      }
      cut = true;
      const kept = s.slice(0, Math.max(0, room));
      text += kept;
      return kept;
    },
    get text() {
      return cut ? `${text}\n[output cut at ${max} characters]` : text;
    },
    get truncated() {
      return cut;
    },
  };
}

/** Which engine is behind the docker CLI, from `docker info --format '{{json .}}'`. */
function detectRuntime(info, binaryName = "docker") {
  if (binaryName === "podman") return "Podman";
  const os_ = String(info?.OperatingSystem ?? "");
  const name = String(info?.Name ?? "");
  if (/docker desktop/i.test(os_)) return "Docker Desktop";
  if (/orbstack/i.test(os_) || /orbstack/i.test(name)) return "OrbStack";
  if (/colima/i.test(name) || /colima/i.test(os_)) return "colima";
  if (/podman/i.test(os_) || info?.host?.remoteSocket) return "Podman";
  if (/rancher/i.test(os_) || /rancher/i.test(name)) return "Rancher Desktop";
  return "Docker Engine";
}

function setupHints(platform = process.platform, state = "missing") {
  if (state === "stopped") {
    return platform === "darwin"
      ? ["Start your Docker engine: run `colima start` in Terminal, or open Docker Desktop / OrbStack."]
      : platform === "win32"
        ? ["Open Docker Desktop and wait until it says the engine is running."]
        : ["Start the Docker service: `sudo systemctl start docker` (or `systemctl --user start podman.socket`)."];
  }
  if (platform === "darwin") {
    return [
      "Lightweight and free: `brew install colima docker && colima start`",
      "Or install OrbStack (orbstack.dev) or Docker Desktop (docker.com).",
    ];
  }
  if (platform === "win32") return ["Install Docker Desktop (docker.com) with the WSL 2 backend, then open it once."];
  return ["Install Docker Engine (`curl -fsSL https://get.docker.com | sh`) or Podman, then add yourself to the docker group."];
}

/** Turns the result of `docker info` into the status the app shows. */
function parseStatus({ binary, code, stdout, stderr, platform = process.platform }) {
  if (!binary) return { installed: false, running: false, runtime: null, hints: setupHints(platform, "missing") };
  if (code !== 0) {
    return {
      installed: true,
      running: false,
      runtime: null,
      binary: binary.path,
      error: String(stderr || stdout || "").trim().split("\n").slice(-2).join(" ").slice(0, 300),
      hints: setupHints(platform, "stopped"),
    };
  }
  let info = {};
  try {
    info = JSON.parse(String(stdout).trim().split("\n").pop() || "{}");
  } catch {}
  return {
    installed: true,
    running: true,
    runtime: detectRuntime(info, binary.name),
    binary: binary.path,
    version: info.ServerVersion || info.version?.Version || "",
    cpus: info.NCPU ?? null,
    memory: info.MemTotal ?? null,
    hints: [],
  };
}

/** One JSON object per line (docker ps/stats --format '{{json .}}'). */
function parseJsonLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

function parseLabels(labels) {
  if (labels && typeof labels === "object") return labels;
  const out = {};
  for (const part of String(labels || "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function parseList(psText, statsText) {
  const stats = new Map(parseJsonLines(statsText).map((s) => [s.Name || s.Container, s]));
  return parseJsonLines(psText).map((c) => {
    const name = String(c.Names || "").split(",")[0];
    const labels = parseLabels(c.Labels);
    const s = stats.get(name);
    return {
      name,
      botId: labels["adtbot.bot"] || "",
      state: String(c.State || "").toLowerCase(),
      status: c.Status || "",
      image: c.Image || "",
      cpu: s?.CPUPerc ?? null,
      memory: s?.MemUsage ?? null,
      memoryPercent: s?.MemPerc ?? null,
    };
  });
}

function parseListing(text) {
  const types = { d: "dir", f: "file", l: "link" };
  return String(text || "")
    .split("\n")
    .filter(Boolean)
    .slice(0, 1000)
    .map((line) => {
      const [type, size, mtime, ...rest] = line.split("\t");
      return { name: rest.join("\t"), type: types[type] || "other", size: Number(size) || 0, modified: Math.round(Number(mtime) * 1000) || 0 };
    })
    .sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
}

/** Crude page text from HTML (the model gets readable text, not markup). */
function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// Running docker ---------------------------------------------------------------------------------

/**
 * Runs the docker CLI with an argv array. Resolves {code, stdout, stderr} (stdout capped).
 * @param {string[]} args
 * @param {{ input?: string | Buffer, timeoutMs?: number, onData?: (s: string) => void, binary?: boolean, max?: number, signalRef?: { kill?: () => void } }} [options]
 */
function docker(args, options = {}) {
  const bin = findBinary();
  if (!bin) return Promise.resolve({ code: -1, stdout: "", stderr: "Docker is not installed.", missing: true });
  return new Promise((resolve) => {
    const child = spawn(bin.path, args, { env: dockerEnv(), windowsHide: true });
    const out = [];
    let outBytes = 0;
    const max = options.max ?? MAX_OUTPUT * 4;
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      if (outBytes < max) {
        out.push(chunk);
        outBytes += chunk.length;
      }
      options.onData?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    if (options.signalRef) options.signalRef.kill = () => child.kill("SIGKILL");
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(error.message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const buffer = Buffer.concat(out);
      resolve({ code: timedOut ? -2 : code ?? -1, stdout: options.binary ? buffer : buffer.toString("utf8"), stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function fail(result, what) {
  const message = String(result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 500);
  throw new Error(`${what}: ${message || `docker exited with code ${result.code}`}`);
}

async function status() {
  const binary = findBinary();
  if (!binary) return parseStatus({ binary: null });
  const r = await docker(["info", "--format", "{{json .}}"], { timeoutMs: 15000 });
  return parseStatus({ binary, code: r.code, stdout: r.stdout, stderr: r.stderr });
}

async function imageExists(tag) {
  const r = await docker(["image", "inspect", "--format", "{{.Id}}", tag], { timeoutMs: 15000 });
  return r.code === 0;
}

const builds = new Map();

/** Builds the computer image once (streams the build log as "adt:computers:build"). */
function ensureImage(send, browser = false) {
  const tag = browser ? BROWSER_IMAGE : IMAGE;
  if (builds.has(tag)) return builds.get(tag);
  const job = (async () => {
    if (await imageExists(tag)) return { tag, built: false };
    send?.("adt:computers:build", { tag, chunk: `Preparing the computer image ${tag} (first time only, a few minutes)…\n` });
    const forward = (chunk) => send?.("adt:computers:build", { tag, chunk });
    const r = await docker(["build", "-t", tag, "--label", LABEL, "--build-arg", `BROWSER=${browser ? 1 : 0}`, "-"], {
      input: DOCKERFILE,
      timeoutMs: 30 * 60_000,
      onData: forward,
      onStderr: forward,
    });
    if (r.code !== 0) fail(r, "Building the computer image failed");
    send?.("adt:computers:build", { tag, chunk: "Image ready.\n", done: true });
    return { tag, built: true };
  })().finally(() => builds.delete(tag));
  builds.set(tag, job);
  return job;
}

async function inspect(botId) {
  const r = await docker(["container", "inspect", "--format", "{{json .}}", containerName(botId)], { timeoutMs: 15000 });
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(String(r.stdout).trim());
    return { state: String(data.State?.Status || ""), running: Boolean(data.State?.Running), labels: data.Config?.Labels || {} };
  } catch {
    return null;
  }
}

async function create(botId, config, send) {
  const args = createArgs(botId, config);
  await ensureImage(send, normaliseConfig(config).browser);
  const r = await docker(args, { timeoutMs: 60000 });
  if (r.code !== 0) fail(r, "Creating the computer failed");
}

async function removeContainer(botId) {
  const r = await docker(["rm", "-f", containerName(botId)], { timeoutMs: 60000 });
  if (r.code !== 0 && !/no such container/i.test(r.stderr)) fail(r, "Removing the computer failed");
}

async function removeVolume(botId) {
  const r = await docker(["volume", "rm", "-f", volumeName(botId)], { timeoutMs: 60000 });
  if (r.code !== 0 && !/no such volume/i.test(r.stderr)) fail(r, "Removing the computer's files failed");
}

/** Creates/recreates/starts the container so it matches the bot's settings, then returns its state. */
async function ensureRunning(botId, config, send) {
  let current = await inspect(botId);
  if (current && current.labels["adtbot.config"] !== configHash(config)) {
    await removeContainer(botId);
    current = null;
  }
  if (!current) await create(botId, config, send);
  if (!current?.running) {
    const r = await docker(["start", containerName(botId)], { timeoutMs: 60000 });
    if (r.code !== 0) fail(r, "Starting the computer failed");
  }
  return { name: containerName(botId), state: "running" };
}

async function stop(botId) {
  const r = await docker(["stop", "-t", "5", containerName(botId)], { timeoutMs: 60000 });
  if (r.code !== 0 && !/no such container/i.test(r.stderr)) fail(r, "Stopping the computer failed");
  return { state: "exited" };
}

/** Fresh container from the image; /workspace is kept unless wipe. */
async function reset(botId, config, wipe, send) {
  await removeContainer(botId);
  if (wipe) await removeVolume(botId);
  return ensureRunning(botId, config, send);
}

async function remove(botId, wipe) {
  await removeContainer(botId);
  if (wipe) await removeVolume(botId);
  return { removed: true };
}

async function list() {
  const ps = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{json .}}"], { timeoutMs: 20000 });
  if (ps.code !== 0) fail(ps, "Listing computers failed");
  const running = parseJsonLines(ps.stdout).filter((c) => String(c.State).toLowerCase() === "running").map((c) => String(c.Names).split(",")[0]);
  let statsText = "";
  if (running.length) {
    const stats = await docker(["stats", "--no-stream", "--format", "{{json .}}", ...running], { timeoutMs: 20000 });
    if (stats.code === 0) statsText = stats.stdout;
  }
  return parseList(ps.stdout, statsText);
}

// Commands ---------------------------------------------------------------------------------------

/** Live runs, for cancel: runId → { name, kill, root } */
const runs = new Map();

/** @param {{ maxOutput?: number, stream?: boolean }} [internal] options not reachable over IPC */
async function exec(payload, send, internal = {}) {
  const { botId, config, command, cwd, root } = payload ?? {};
  if (!String(command ?? "").trim()) throw new Error("No command given.");
  const c = normaliseConfig(config);
  if (root && !c.admin) throw new Error("Admin commands are off for this computer.");
  await ensureRunning(botId, config, send);
  const runId = safeRunId(payload.runId);
  const name = containerName(botId);
  const timeoutMs = clampTimeout(payload.timeoutMs);
  const cap = createCap(internal.maxOutput ?? MAX_OUTPUT);
  const ref = {};
  const started = Date.now();
  runs.set(runId, { name, root: Boolean(root), ref });
  const onChunk = (chunk) => {
    const kept = cap.push(chunk);
    if (kept && internal.stream !== false) send?.("adt:computers:output", { runId, chunk: kept });
  };
  try {
    const r = await docker(execArgs(name, { command, runId, timeoutMs, cwd, root: Boolean(root) }), {
      timeoutMs: timeoutMs + 15000,
      onData: onChunk,
      onStderr: onChunk,
      signalRef: ref,
      max: 1,
    });
    const cancelled = runs.get(runId)?.cancelled;
    const timedOut = r.code === 124 || r.timedOut;
    let output = cap.text;
    if (timedOut) output += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`;
    if (cancelled) output += "\n[cancelled]";
    return { runId, code: r.code, output, truncated: cap.truncated, timedOut: Boolean(timedOut), cancelled: Boolean(cancelled), ms: Date.now() - started };
  } finally {
    runs.delete(runId);
  }
}

async function cancel(runId) {
  const run = runs.get(safeRunId(runId));
  if (!run) return { cancelled: false };
  run.cancelled = true;
  await docker(cancelArgs(run.name, runId, run.root), { timeoutMs: 10000 });
  setTimeout(() => run.ref.kill?.(), 3000);
  return { cancelled: true };
}

// Files ------------------------------------------------------------------------------------------

async function readFile({ botId, config, path: file, maxBytes }, send) {
  await ensureRunning(botId, config, send);
  const limit = Math.min(MAX_READ * 5, Math.max(1, Number(maxBytes) || MAX_READ));
  const r = await docker(readArgs(containerName(botId), file, limit), { binary: true, timeoutMs: 30000, max: limit + 64 });
  if (r.code !== 0) fail(r, `Could not read ${containerPath(file)}`);
  const buffer = r.stdout;
  const newline = buffer.indexOf(10);
  const size = Number(buffer.subarray(0, newline).toString()) || 0;
  const body = buffer.subarray(newline + 1, newline + 1 + limit);
  const truncated = size > limit;
  if (body.includes(0)) return { path: containerPath(file), binary: true, size, text: "" };
  return { path: containerPath(file), binary: false, size, text: body.toString("utf8"), truncated };
}

async function writeFile({ botId, config, path: file, content, append }, send) {
  const text = String(content ?? "");
  if (Buffer.byteLength(text) > MAX_WRITE) throw new Error("That file is too big to write in one go (5 MB max).");
  await ensureRunning(botId, config, send);
  const r = await docker(writeArgs(containerName(botId), file, Boolean(append)), { input: text, timeoutMs: 60000 });
  if (r.code !== 0) fail(r, `Could not write ${containerPath(file)}`);
  return { path: containerPath(file), size: Buffer.byteLength(text) };
}

async function listFiles({ botId, config, path: dir }, send) {
  await ensureRunning(botId, config, send);
  const r = await docker(listArgs(containerName(botId), dir), { timeoutMs: 30000 });
  if (r.code !== 0) fail(r, `Could not list ${containerPath(dir)}`);
  return { path: containerPath(dir), entries: parseListing(r.stdout) };
}

function uniqueTarget(dir, base) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "file";
  let candidate = path.join(dir, base);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/** Copies a file or folder out of the computer into Downloads (only from a click in the app). */
async function download({ botId, path: file }, downloadsDir) {
  const source = containerPath(file);
  const base = path.posix.basename(source).replace(/[\\/:*?"<>|]/g, "_") || "download";
  const target = uniqueTarget(downloadsDir, base);
  const r = await docker(["cp", `${containerName(botId)}:${source}`, target], { timeoutMs: 120000 });
  if (r.code !== 0) fail(r, `Could not copy ${source}`);
  return { path: target };
}

// Browser ----------------------------------------------------------------------------------------

async function browse({ botId, config, url, runId }, send) {
  const c = normaliseConfig(config);
  if (!c.browser) throw new Error("The browser is off for this computer (Settings → Computers).");
  if (!c.network) throw new Error("This computer has no network.");
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error("Only http(s) pages can be opened.");
  await ensureRunning(botId, config, send);
  const name = containerName(botId);
  const flags = "--headless --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars --window-size=1280,800 --virtual-time-budget=8000";
  const script = `f=/tmp/.adtbot-shot-$$.png; chromium ${flags} --dump-dom "$1" 2>/dev/null; echo; echo "@@ADTBOT-SHOT@@"; chromium ${flags} --screenshot="$f" "$1" >/dev/null 2>&1 || true; [ -f "$f" ] && base64 -w0 "$f"; rm -f "$f"`;
  const result = await exec({ botId, config, runId, timeoutMs: 90000, command: `bash -c ${shQuote(script)} adtbot ${shQuote(target.toString())}` }, send, { maxOutput: 8_000_000, stream: false });
  const [html, shot = ""] = result.output.split("@@ADTBOT-SHOT@@");
  const text = htmlToText(html).slice(0, 60000);
  const png = shot.replace(/\s+/g, "").replace(/\[.*$/, "");
  return { url: target.toString(), text, screenshot: /^[A-Za-z0-9+/=]{100,}$/.test(png) ? `data:image/png;base64,${png}` : null };
}

/** POSIX single-quote for text handed to bash *inside* the container. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// IPC --------------------------------------------------------------------------------------------

exports.register = ({ app, ipcMain, getWindow, send }) => {
  const { dialog } = require("electron");
  const handle = (op, fn) => ipcMain.handle(`adt:computers:${op}`, (_e, payload) => fn(payload ?? {}));
  handle("status", () => status());
  handle("ensure-image", ({ browser }) => ensureImage(send, Boolean(browser)));
  handle("list", () => list());
  handle("start", ({ botId, config }) => ensureRunning(botId, config, send));
  handle("stop", ({ botId }) => stop(botId));
  handle("reset", ({ botId, config, wipe }) => reset(botId, config, Boolean(wipe), send));
  handle("delete", ({ botId, wipe }) => remove(botId, Boolean(wipe)));
  handle("exec", (payload) => exec(payload, send));
  handle("cancel", ({ runId }) => cancel(runId));
  handle("read", (payload) => readFile(payload, send));
  handle("write", (payload) => writeFile(payload, send));
  handle("list-files", (payload) => listFiles(payload, send));
  handle("download", (payload) => download(payload, app.getPath("downloads")));
  handle("browse", (payload) => browse(payload, send));
  handle("pick-folder", async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, { title: "Folder to share with the bot's computer", properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return { path: null };
    const problem = validateSharedFolder(result.filePaths[0]);
    if (problem) throw new Error(problem);
    return { path: result.filePaths[0] };
  });
};

exports._test = {
  IMAGE,
  BROWSER_IMAGE,
  DOCKERFILE,
  LIMITS,
  safeId,
  containerName,
  volumeName,
  normaliseConfig,
  configHash,
  validateSharedFolder,
  createArgs,
  containerPath,
  execArgs,
  cancelArgs,
  readArgs,
  writeArgs,
  listArgs,
  createCap,
  detectRuntime,
  parseStatus,
  parseList,
  parseListing,
  htmlToText,
  // Real engine (used by the end-to-end script, not the unit tests).
  docker,
  status,
  ensureImage,
  ensureRunning,
  stop,
  reset,
  remove,
  list,
  exec,
  cancel,
  readFile,
  writeFile,
  listFiles,
  download,
  browse,
};
