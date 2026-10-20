// Coding agents: drive command-line AI tools (Claude Code, Codex, Gemini CLI, OpenCode, Aider)
// non-interactively and stream their output to the app as normalised events.
//
// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors —
// its agent-CLI backends (login-shell PATH hydration, version probes, process-group spawning,
// Claude stream-json / Codex JSONL event mapping). Those parts of OpenBOT were themselves adapted
// from Synara (github.com/Emanuele-web04/synara), MIT, (c) 2026 T3 Tools Inc., (c) 2026 Emanuele
// Di Pietro. Both are used under the MIT License: permission is hereby granted, free of charge,
// to any person obtaining a copy of this software and associated documentation files, to deal in
// the Software without restriction, subject to including the copyright notices and this
// permission notice; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Safety: prompts never pass through a shell. The CLI is spawned directly with an argument array;
// free text goes over stdin or as "--flag=value", so it can't be read as an extra flag. Each run
// leads its own process group, so cancel/timeout kills the CLI and everything it started.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_STDOUT = 20_000_000; // bytes of CLI output we are willing to parse per run
const MAX_LINE = 1_000_000; // one JSON line (tool results can be big)
const MAX_TEXT = 200_000; // assistant text kept for the final summary
const MAX_TOOL_OUTPUT = 4000; // tool output forwarded per event
const MAX_LOG_EVENTS = 200;
const MAX_RUNS = 4;
const DEFAULT_TIMEOUT = 15 * 60_000;
const KILL_GRACE_MS = 2000;

const AGENTS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    homepage: "https://claude.com/claude-code",
    resume: true,
    models: ["default", "sonnet", "opus", "haiku"],
  },
  codex: {
    id: "codex",
    name: "Codex",
    bin: "codex",
    install: "npm install -g @openai/codex",
    homepage: "https://developers.openai.com/codex/cli",
    resume: true,
    models: ["default"],
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    install: "npm install -g @google/gemini-cli",
    homepage: "https://github.com/google-gemini/gemini-cli",
    resume: true,
    models: ["default", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    install: "npm install -g opencode-ai",
    homepage: "https://opencode.ai",
    resume: true,
    models: ["default"],
  },
  aider: {
    id: "aider",
    name: "Aider",
    bin: "aider",
    install: "python -m pip install aider-install && aider-install",
    homepage: "https://aider.chat",
    resume: false,
    models: ["default"],
  },
};

/** Permission levels the app exposes, translated per CLI in buildInvocation. */
const PERMISSIONS = ["plan", "default", "edit", "bypass"];

// Environment ---------------------------------------------------------------------------------

function workspaceDir() {
  const dir = path.join(os.homedir(), "ADT Bot Workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Relative folders are inside the workspace; "~" is the home folder. */
function resolveFolder(input) {
  const raw = String(input || "").trim();
  if (!raw) return workspaceDir();
  if (raw === "~" || raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(1));
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(workspaceDir(), raw);
}

const ENV_MARKER = "__adt_env__";
const CAPTURE = ["PATH", "SSH_AUTH_SOCK", "HOMEBREW_PREFIX", "NVM_DIR", "PNPM_HOME", "BUN_INSTALL", "PYENV_ROOT", "CARGO_HOME", "GOPATH", "LANG", "LC_ALL"];

function parseEnvOutput(stdout) {
  const at = String(stdout).lastIndexOf(ENV_MARKER);
  const body = at === -1 ? String(stdout) : String(stdout).slice(at + ENV_MARKER.length);
  const out = {};
  for (const line of body.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m && CAPTURE.includes(m[1])) out[m[1]] = m[2];
  }
  return out.PATH ? out : null;
}

function mergePaths(...lists) {
  const seen = new Set();
  const parts = [];
  for (const list of lists) {
    for (const dir of String(list || "").split(path.delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        parts.push(dir);
      }
    }
  }
  return parts.join(path.delimiter);
}

/** Folders CLIs commonly install into, in case the login shell can't tell us. */
function commonBinDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].join(path.delimiter);
}

function captureShellEnv(shell, args) {
  return new Promise((resolve) => {
    execFile(shell, args, { encoding: "utf8", timeout: 6000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(parseEnvOutput(stdout || (error && error.stdout) || ""));
    });
  });
}

let envPromise = null;
/** The user's login-shell environment (apps started from the Dock get a bare PATH). Cached. */
function loginEnv() {
  envPromise ??= (async () => {
    const base = { ...process.env };
    if (process.platform === "win32") return base;
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const command = `printf '\\n%s\\n' '${ENV_MARKER}'; env`;
    const captured = (await captureShellEnv(shell, ["-ilc", command])) || (await captureShellEnv(shell, ["-lc", command]));
    if (captured) for (const [k, v] of Object.entries(captured)) if (v) base[k] = v;
    base.PATH = mergePaths(captured && captured.PATH, process.env.PATH, commonBinDirs());
    return base;
  })().catch(() => ({ ...process.env, PATH: mergePaths(process.env.PATH, commonBinDirs()) }));
  return envPromise;
}

/** Finds an executable on PATH without a shell. */
function which(bin, envPath) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of String(envPath || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, bin + ext.toLowerCase());
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

function parseVersion(text) {
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/.exec(String(text || ""));
  return m ? m[1] : null;
}

function probeVersion(file, env) {
  return new Promise((resolve) => {
    execFile(file, ["--version"], { env, timeout: 15000, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const text = `${stdout || ""}\n${stderr || ""}`.trim();
      resolve({ version: parseVersion(text), ok: !error, output: text.slice(0, 300) });
    });
  });
}

async function detect() {
  const env = await loginEnv();
  const agents = await Promise.all(
    Object.values(AGENTS).map(async (spec) => {
      const base = { id: spec.id, name: spec.name, install: spec.install, homepage: spec.homepage, resume: spec.resume, models: spec.models };
      const file = which(spec.bin, env.PATH);
      if (!file) return { ...base, installed: false };
      const probe = await probeVersion(file, env);
      return { ...base, installed: true, path: file, version: probe.version, error: probe.ok ? undefined : probe.output || "Didn't answer --version" };
    }),
  );
  return { agents, workspace: workspaceDir() };
}

// Arguments -----------------------------------------------------------------------------------

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** Model names and session ids go on the command line: allow only plain tokens. */
function token(value, what) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!SAFE_TOKEN.test(v)) throw new Error(`Invalid ${what}: ${v.slice(0, 40)}`);
  return v;
}

/** A positional argument that can never be mistaken for a flag. */
function positional(text) {
  const t = String(text);
  return t.startsWith("-") ? ` ${t}` : t;
}

/**
 * The command line for one run. Returns { args, stdin } — stdin is the text written to the CLI's
 * standard input (null = no stdin). Never builds a shell string.
 */
function buildInvocation({ agent, prompt, model, resumeSession, permission = "default", system, light = false }) {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`Unknown coding agent "${agent}". Use one of: ${Object.keys(AGENTS).join(", ")}.`);
  const text = String(prompt || "").trim();
  if (!text) throw new Error("The task is empty.");
  if (!PERMISSIONS.includes(permission)) throw new Error(`Unknown permission mode "${permission}". Use ${PERMISSIONS.join(", ")}.`);
  const m = token(model, "model");
  const useModel = m && m !== "default" ? m : "";
  const session = token(resumeSession, "session id");
  const sys = String(system || "").trim();
  const withSystem = sys ? `${sys}\n\n---\n\n${text}` : text;

  switch (agent) {
    case "claude": {
      // stream-json in print mode requires --verbose; partial messages give token-by-token text.
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
      if (permission === "plan") args.push("--permission-mode", "plan");
      else if (permission === "edit") args.push("--permission-mode", "acceptEdits");
      else if (permission === "bypass") args.push("--dangerously-skip-permissions");
      if (light) args.push("--tools", "", "--no-session-persistence");
      if (useModel) args.push("--model", useModel);
      if (session) args.push("--resume", session);
      if (sys) args.push(`--append-system-prompt=${sys}`);
      return { args, stdin: text };
    }
    case "codex": {
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (permission === "plan") args.push("--sandbox", "read-only");
      else if (permission === "edit") args.push("--full-auto");
      else if (permission === "bypass") args.push("--dangerously-bypass-approvals-and-sandbox");
      if (useModel) args.push("-m", useModel);
      if (session) args.push("resume", session);
      args.push("-"); // "-" = read the prompt from stdin
      return { args, stdin: withSystem };
    }
    case "gemini": {
      const args = ["--output-format", "stream-json"];
      // Without approval flags, Gemini CLI's headless mode leaves out tools that would need asking.
      if (permission === "edit") args.push("--approval-mode", "auto_edit");
      else if (permission === "bypass") args.push("--yolo");
      if (useModel) args.push("-m", useModel);
      if (session) args.push("--resume", session);
      args.push(`--prompt=${withSystem}`);
      return { args, stdin: null };
    }
    case "opencode": {
      const args = ["run", "--format", "json"];
      if (useModel) args.push("-m", useModel);
      if (session) args.push("--session", session);
      args.push(positional(withSystem));
      return { args, stdin: null };
    }
    case "aider": {
      const args = ["--no-pretty", "--no-stream", "--no-check-update"];
      if (permission === "plan") args.push("--dry-run");
      else if (permission === "edit" || permission === "bypass") args.push("--yes-always");
      if (useModel) args.push(`--model=${useModel}`);
      args.push(`--message=${withSystem}`);
      return { args, stdin: null };
    }
  }
  throw new Error(`Unknown coding agent "${agent}".`);
}

// Stream parsing ------------------------------------------------------------------------------
// Every CLI's output is turned into these events:
//   { type: "session", sessionId, model? }
//   { type: "text", text }                 assistant text (a delta; concatenate)
//   { type: "reasoning", text }
//   { type: "tool", phase: "start"|"end", id?, name, summary?, output?, isError? }
//   { type: "result", text, sessionId?, isError?, costUsd?, durationMs?, turns? }
//   { type: "error", message }
//   { type: "log", text }                  stderr / non-JSON noise

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const s = (v) => (typeof v === "string" ? v : "");
const cut = (text, max = MAX_TOOL_OUTPUT) => {
  const t = typeof text === "string" ? text : text === undefined || text === null ? "" : JSON.stringify(text);
  return t.length > max ? `${t.slice(0, max)}… [${t.length - max} more]` : t;
};

/** One-line summary of a tool's input: the command, path or query when there is one. */
function summarize(input) {
  if (!isObj(input)) return cut(input, 200);
  for (const key of ["command", "cmd", "file_path", "path", "filePath", "pattern", "query", "url", "description", "prompt"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return cut(v.trim(), 200);
    if (Array.isArray(v) && v.length) return cut(v.join(" "), 200);
  }
  return cut(
    Object.entries(input)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${cut(typeof v === "string" ? v : JSON.stringify(v), 60)}`)
      .join(", "),
    200,
  );
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isObj(b) ? s(b.text) : typeof b === "string" ? b : "")).filter(Boolean).join("\n");
}

/** Claude Code `--output-format stream-json` (Anthropic-shaped messages, one per line). */
function claudeParser() {
  const streamed = new Set(); // message ids whose text already arrived as deltas
  const tools = new Map(); // tool_use id -> name
  let currentId = "";
  return {
    json(value) {
      if (!isObj(value)) return [];
      const type = s(value.type);
      if (type === "system" && s(value.subtype) === "init") return [{ type: "session", sessionId: s(value.session_id), model: s(value.model) || undefined }];
      if (type === "stream_event" && isObj(value.event)) {
        const ev = value.event;
        if (ev.type === "message_start" && isObj(ev.message)) currentId = s(ev.message.id);
        if (ev.type === "content_block_delta" && isObj(ev.delta)) {
          if (ev.delta.type === "text_delta" && s(ev.delta.text)) {
            streamed.add(currentId);
            return [{ type: "text", text: ev.delta.text }];
          }
          if (ev.delta.type === "thinking_delta" && s(ev.delta.thinking)) {
            streamed.add(currentId);
            return [{ type: "reasoning", text: ev.delta.thinking }];
          }
        }
        return [];
      }
      if (type === "assistant" && isObj(value.message)) {
        const msg = value.message;
        if (value.is_api_error_message === true || value.error) return [{ type: "error", message: blockText(msg.content) || s(value.error) || "Claude Code reported an error" }];
        const already = streamed.has(s(msg.id));
        const out = [];
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (!isObj(block)) continue;
          if (block.type === "text" && s(block.text) && !already) out.push({ type: "text", text: block.text });
          else if (block.type === "thinking" && s(block.thinking) && !already) out.push({ type: "reasoning", text: block.thinking });
          else if (block.type === "tool_use") {
            tools.set(s(block.id), s(block.name));
            out.push({ type: "tool", phase: "start", id: s(block.id), name: s(block.name) || "tool", summary: summarize(block.input) });
          }
        }
        return out;
      }
      if (type === "user" && isObj(value.message) && Array.isArray(value.message.content)) {
        return value.message.content
          .filter((b) => isObj(b) && b.type === "tool_result")
          .map((b) => ({
            type: "tool",
            phase: "end",
            id: s(b.tool_use_id),
            name: tools.get(s(b.tool_use_id)) || "tool",
            output: cut(blockText(b.content) || b.content),
            isError: b.is_error === true,
          }));
      }
      if (type === "result") {
        const isError = value.is_error === true || (s(value.subtype) && s(value.subtype) !== "success");
        const text = s(value.result) || (Array.isArray(value.errors) ? value.errors.join("\n") : "");
        return [
          {
            type: "result",
            text: text || (isError ? `Claude Code stopped (${s(value.subtype) || "error"})` : ""),
            sessionId: s(value.session_id) || undefined,
            isError,
            costUsd: typeof value.total_cost_usd === "number" ? value.total_cost_usd : undefined,
            durationMs: typeof value.duration_ms === "number" ? value.duration_ms : undefined,
            turns: typeof value.num_turns === "number" ? value.num_turns : undefined,
          },
        ];
      }
      if (type === "error") return [{ type: "error", message: s(value.message) || s(value.error) || "Claude Code reported an error" }];
      return [];
    },
  };
}

function codexError(record) {
  if (!isObj(record)) return "";
  return s(record.message) || s(record.error) || (isObj(record.error) ? s(record.error.message) : "");
}

/** Codex `exec --json` JSONL: thread/turn/item events (newer) or a `msg` envelope (older builds). */
function codexParser() {
  let last = "";
  let done = false;
  const itemEvents = (phase, item) => {
    const kind = s(item.type);
    const id = s(item.id);
    if (kind === "agent_message" || kind === "assistant_message") {
      if (phase !== "end" || !s(item.text)) return [];
      last = item.text;
      return [{ type: "text", text: `${item.text}\n` }];
    }
    if (kind === "reasoning") return phase === "end" && s(item.text) ? [{ type: "reasoning", text: `${item.text}\n` }] : [];
    if (kind === "command_execution") {
      const ev = { type: "tool", phase, id, name: "shell", summary: cut(item.command, 200) };
      if (phase === "end") {
        ev.output = cut(item.aggregated_output);
        ev.isError = typeof item.exit_code === "number" ? item.exit_code !== 0 : s(item.status) === "failed";
      }
      return [ev];
    }
    if (kind === "file_change") {
      const files = Array.isArray(item.changes) ? item.changes.map((c) => `${s(c.kind)} ${s(c.path)}`.trim()).join(", ") : "";
      return phase === "end" ? [{ type: "tool", phase: "end", id, name: "edit", summary: cut(files, 200), isError: s(item.status) === "failed" }] : [];
    }
    if (kind === "mcp_tool_call") return [{ type: "tool", phase, id, name: `${s(item.server)}.${s(item.tool)}`, summary: summarize(item.arguments), isError: s(item.status) === "failed" }];
    if (kind === "web_search") return [{ type: "tool", phase, id, name: "web_search", summary: cut(item.query, 200) }];
    if (kind === "error") return s(item.message) ? [{ type: "log", text: `warning: ${item.message}` }] : [];
    return [];
  };
  return {
    json(value) {
      if (!isObj(value)) return [];
      const type = s(value.type);
      if (type === "thread.started") return [{ type: "session", sessionId: s(value.thread_id) }];
      if (type === "item.started" && isObj(value.item)) return itemEvents("start", value.item);
      if (type === "item.completed" && isObj(value.item)) return itemEvents("end", value.item);
      if (type === "turn.completed") {
        done = true;
        return [{ type: "result", text: last }];
      }
      if (type === "turn.failed") return [{ type: "error", message: codexError(value.error) || codexError(value) || "Codex turn failed" }];
      if (type === "error") return [{ type: "error", message: codexError(value) || "Codex reported an error" }];
      if (isObj(value.msg)) {
        const msg = value.msg;
        const t = s(msg.type);
        if (t === "session_configured") return [{ type: "session", sessionId: s(msg.session_id), model: s(msg.model) || undefined }];
        if (t === "agent_message" && s(msg.message)) {
          last = msg.message;
          return [{ type: "text", text: `${msg.message}\n` }];
        }
        if (t === "agent_reasoning" && s(msg.text)) return [{ type: "reasoning", text: msg.text }];
        if (t === "exec_command_begin") return [{ type: "tool", phase: "start", id: s(msg.call_id), name: "shell", summary: cut(Array.isArray(msg.command) ? msg.command.join(" ") : msg.command, 200) }];
        if (t === "exec_command_end")
          return [{ type: "tool", phase: "end", id: s(msg.call_id), name: "shell", output: cut(s(msg.stdout) || s(msg.aggregated_output) || s(msg.stderr)), isError: msg.exit_code !== 0 }];
        if (t === "task_complete") {
          done = true;
          return [{ type: "result", text: s(msg.last_agent_message) || last }];
        }
        if (t === "error" || t === "stream_error") return [{ type: "error", message: s(msg.message) || "Codex reported an error" }];
      }
      return [];
    },
    finish() {
      return done ? [] : last ? [{ type: "result", text: last }] : [];
    },
  };
}

/** Gemini CLI `--output-format stream-json` (init / message / tool_use / tool_result / result). */
function geminiParser() {
  let text = "";
  const tools = new Map();
  return {
    json(value) {
      if (!isObj(value)) return [];
      const type = s(value.type);
      if (type === "init") return [{ type: "session", sessionId: s(value.session_id), model: s(value.model) || undefined }];
      if (type === "message") {
        if (s(value.role) !== "assistant" || !s(value.content)) return [];
        text += value.content;
        return [{ type: "text", text: value.content }];
      }
      if (type === "tool_use") {
        tools.set(s(value.tool_id), s(value.tool_name));
        return [{ type: "tool", phase: "start", id: s(value.tool_id), name: s(value.tool_name) || "tool", summary: summarize(value.parameters) }];
      }
      if (type === "tool_result")
        return [
          {
            type: "tool",
            phase: "end",
            id: s(value.tool_id),
            name: tools.get(s(value.tool_id)) || "tool",
            output: cut(value.output ?? (isObj(value.error) ? value.error.message : "")),
            isError: s(value.status) === "error",
          },
        ];
      if (type === "error") {
        const message = s(value.message) || "Gemini CLI reported an error";
        return s(value.severity) === "warning" ? [{ type: "log", text: `warning: ${message}` }] : [{ type: "error", message }];
      }
      if (type === "result") {
        const isError = s(value.status) && s(value.status) !== "success";
        return [{ type: "result", text: text || (isObj(value.error) ? s(value.error.message) : ""), isError: Boolean(isError) }];
      }
      // `--output-format json` (one object at the end) from older builds.
      if (typeof value.response === "string") {
        text += value.response;
        return [
          { type: "text", text: value.response },
          { type: "result", text: value.response, sessionId: s(value.session_id) || undefined },
        ];
      }
      return [];
    },
    // A build without stream-json prints plain text.
    line(raw) {
      text += `${raw}\n`;
      return [{ type: "text", text: `${raw}\n` }];
    },
    finish() {
      return [];
    },
  };
}

/** OpenCode `run --format json`: { type, sessionID, part } records. */
function opencodeParser() {
  let session = "";
  let text = "";
  let cost = 0;
  return {
    json(value) {
      if (!isObj(value)) return [];
      const out = [];
      const sid = s(value.sessionID) || (isObj(value.part) ? s(value.part.sessionID) : "");
      if (sid && sid !== session) {
        session = sid;
        out.push({ type: "session", sessionId: sid });
      }
      const type = s(value.type);
      const part = isObj(value.part) ? value.part : {};
      if (type === "text" && s(part.text)) {
        text += part.text;
        out.push({ type: "text", text: part.text });
      } else if (type === "reasoning" && s(part.text)) out.push({ type: "reasoning", text: part.text });
      else if (type === "tool_use" || type === "tool") {
        const state = isObj(part.state) ? part.state : {};
        const finished = state.status === "completed" || state.status === "error";
        out.push({
          type: "tool",
          phase: finished ? "end" : "start",
          id: s(part.callID) || s(part.id),
          name: s(part.tool) || "tool",
          summary: summarize(state.input),
          ...(finished ? { output: cut(state.output ?? state.error), isError: state.status === "error" } : {}),
        });
      } else if (type === "step_finish" && typeof part.cost === "number") cost += part.cost;
      else if (type === "error") {
        const err = isObj(value.error) ? value.error : {};
        out.push({ type: "error", message: (isObj(err.data) && s(err.data.message)) || s(err.message) || s(err.name) || s(value.message) || "OpenCode reported an error" });
      }
      return out;
    },
    line(raw) {
      text += `${raw}\n`;
      return [{ type: "text", text: `${raw}\n` }];
    },
    finish() {
      return [{ type: "result", text: text.trim(), sessionId: session || undefined, costUsd: cost || undefined }];
    },
  };
}

/** Aider prints plain text. */
function aiderParser() {
  let text = "";
  return {
    json() {
      return [];
    },
    line(raw) {
      text += `${raw}\n`;
      return [{ type: "text", text: `${raw}\n` }];
    },
    finish() {
      return [{ type: "result", text: text.trim() }];
    },
  };
}

function createParser(agent) {
  const make = { claude: claudeParser, codex: codexParser, gemini: geminiParser, opencode: opencodeParser, aider: aiderParser }[agent];
  if (!make) throw new Error(`Unknown coding agent "${agent}".`);
  const p = make();
  return {
    /** One line of stdout → events. JSON lines go to the CLI's mapper; other lines are noise or text. */
    line(raw) {
      const line = String(raw).replace(/\r$/, "");
      if (!line.trim()) return [];
      if (agent !== "aider" && line.trimStart().startsWith("{")) {
        try {
          return p.json(JSON.parse(line));
        } catch {}
      }
      return p.line ? p.line(line) : [{ type: "log", text: line }];
    },
    finish: () => (p.finish ? p.finish() : []),
  };
}

/** Splits a byte stream into lines, dropping (and reporting) absurdly long ones. */
class LineSplitter {
  constructor() {
    this.buffer = "";
    this.dropping = false;
  }
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_LINE) {
      this.buffer = "";
      this.dropping = true;
    }
    const out = [];
    for (const line of lines) {
      if (this.dropping) {
        this.dropping = false;
        continue; // tail of an over-long line
      }
      out.push(line);
    }
    return out;
  }
  flush() {
    const rest = this.dropping ? "" : this.buffer;
    this.buffer = "";
    this.dropping = false;
    return rest ? [rest] : [];
  }
}

// Running -------------------------------------------------------------------------------------

const runs = new Map();

function killTree(child, signal) {
  if (!child || typeof child.pid !== "number" || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/**
 * Runs one task to completion. `emit(event)` receives normalised events as they stream; the promise
 * resolves with a summary (never rejects for CLI failures — they're reported in the summary).
 */
async function runAgent(options, emit = () => undefined) {
  const runId = String(options.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const agent = String(options.agent || "");
  const started = Date.now();
  const summary = { runId, agent, ok: false, code: null, signal: null, cancelled: false, timedOut: false, sessionId: "", result: "", text: "", error: "", cwd: "" };
  const fail = (message) => {
    summary.error = message;
    emit({ type: "error", message });
    return { ...summary, durationMs: Date.now() - started };
  };

  if (runs.size >= MAX_RUNS) return fail(`Too many coding agents running (max ${MAX_RUNS}). Wait or cancel one.`);
  let invocation;
  try {
    invocation = buildInvocation({ ...options, agent, prompt: options.prompt ?? options.task });
  } catch (error) {
    return fail(error.message);
  }
  const cwd = resolveFolder(options.cwd ?? options.folder);
  summary.cwd = cwd;
  try {
    if (!fs.statSync(cwd).isDirectory()) return fail(`${cwd} is not a folder.`);
  } catch {
    return fail(`Folder not found: ${cwd}`);
  }
  const env = options.env ?? (await loginEnv());
  const file = options.binary || which(AGENTS[agent].bin, env.PATH);
  if (!file) return fail(`${AGENTS[agent].name} isn't installed (or not on your PATH). Install: ${AGENTS[agent].install}`);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) return fail(`${AGENTS[agent].name} is a .cmd script; running those isn't supported yet on Windows.`);

  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT, 5000), 2 * 60 * 60_000);
  const parser = createParser(agent);
  let text = "";
  let logs = 0;
  let bytes = 0;
  let capped = false;
  let finalResult = null;
  const errors = [];
  const stderrTail = [];

  const handle = (event) => {
    if (event.type === "text") {
      if (text.length < MAX_TEXT) text += event.text;
    } else if (event.type === "session" && event.sessionId) summary.sessionId = event.sessionId;
    else if (event.type === "result") {
      finalResult = event;
      if (event.sessionId) summary.sessionId = event.sessionId;
    } else if (event.type === "error") errors.push(event.message);
    else if (event.type === "log" && ++logs > MAX_LOG_EVENTS) return;
    emit(event);
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, invocation.args, {
        cwd,
        env,
        stdio: [invocation.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve(fail(`Couldn't start ${AGENTS[agent].name}: ${error.message}`));
      return;
    }
    let graceTimer = null;
    const stop = (signal = "SIGTERM") => {
      killTree(child, signal);
      if (!graceTimer) {
        graceTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
        graceTimer.unref?.();
      }
    };
    const entry = {
      agent,
      startedAt: started,
      cancel: () => {
        summary.cancelled = true;
        stop();
      },
    };
    runs.set(runId, entry);
    const timer = setTimeout(() => {
      summary.timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();
    emit({ type: "log", text: `$ ${path.basename(file)} ${invocation.args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).map((a) => (/[\s"']/.test(a) || !a ? JSON.stringify(a) : a)).join(" ")}\n  in ${cwd}` });

    const out = new LineSplitter();
    const err = new LineSplitter();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (capped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDOUT) {
        capped = true;
        handle({ type: "error", message: `Output limit reached (${Math.round(MAX_STDOUT / 1e6)} MB); stopped the agent.` });
        stop();
        return;
      }
      for (const line of out.push(chunk)) for (const ev of parser.line(line)) handle(ev);
    });
    child.stderr.on("data", (chunk) => {
      for (const line of err.push(chunk)) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        handle({ type: "log", text: line.slice(0, 2000) });
      }
    });
    if (invocation.stdin !== null) {
      child.stdin.on("error", () => undefined); // a CLI that exits at once breaks the pipe; its exit code tells why
      child.stdin.end(invocation.stdin.endsWith("\n") ? invocation.stdin : `${invocation.stdin}\n`);
    }

    let settled = false;
    const finish = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      runs.delete(runId);
      if (!capped) {
        for (const line of out.flush()) for (const ev of parser.line(line)) handle(ev);
        if (!finalResult) for (const ev of parser.finish()) handle(ev);
      }
      for (const line of err.flush()) stderrTail.push(line);
      summary.code = code;
      summary.signal = signal;
      summary.text = text;
      summary.result = (finalResult && finalResult.text) || text.trim();
      if (finalResult) {
        summary.costUsd = finalResult.costUsd;
        summary.turns = finalResult.turns;
      }
      if (spawnError) summary.error = `Couldn't start ${AGENTS[agent].name}: ${spawnError.message}`;
      else if (summary.cancelled) summary.error = "Cancelled.";
      else if (summary.timedOut) summary.error = `Stopped after ${Math.round(timeoutMs / 1000)} s (time limit).`;
      else if (finalResult && finalResult.isError) summary.error = finalResult.text || errors[0] || "The agent reported an error.";
      else if (errors.length) summary.error = errors[errors.length - 1];
      else if (code !== 0) summary.error = `${AGENTS[agent].name} exited with code ${code}${stderrTail.length ? `:\n${stderrTail.slice(-8).join("\n")}` : "."}`;
      summary.ok = !summary.error;
      if (spawnError || summary.cancelled || summary.timedOut) emit({ type: "error", message: summary.error });
      resolve({ ...summary, durationMs: Date.now() - started });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

function cancel(runId) {
  const entry = runs.get(String(runId));
  if (!entry) return { ok: false };
  entry.cancel();
  return { ok: true };
}

function cancelAll() {
  for (const entry of runs.values()) entry.cancel();
}

exports.register = ({ app, ipcMain, send, access }) => {
  ipcMain.handle("adt:cli:detect", () => detect());
  ipcMain.handle("adt:cli:run", (_e, payload = {}) => {
    // Coding agents run with your own permissions, outside any sandbox.
    if (access?.mode === "sandbox") throw new Error("Computer access is set to Sandbox, so coding agents can't run. Change it in Settings → Tools & safety.");
    const runId = String(payload.runId || `run-${Date.now()}`);
    return runAgent({ ...payload, runId, env: undefined, binary: undefined }, (event) => send("adt:cli:event", { runId, event }));
  });
  ipcMain.handle("adt:cli:cancel", (_e, { runId } = {}) => cancel(runId));
  ipcMain.handle("adt:cli:runs", () => [...runs.entries()].map(([runId, r]) => ({ runId, agent: r.agent, startedAt: r.startedAt })));
  app?.on?.("before-quit", cancelAll);
};

exports._test = {
  AGENTS,
  PERMISSIONS,
  buildInvocation,
  createParser,
  parseEnvOutput,
  parseVersion,
  mergePaths,
  which,
  resolveFolder,
  LineSplitter,
  loginEnv,
  detect,
  runAgent,
  cancel,
  cancelAll,
};
