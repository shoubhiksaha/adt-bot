import { desktopInvoke, isDesktop } from "../desktop";
import { generateImage, resolveImageModel } from "../imagine";
import { knowledgeContext } from "../knowledge";
import { memoryIsLarge, searchMemory } from "../memory-recall";
import { readPage, webSearch } from "../search";
import { addMemory, useStore } from "../store";
import { describeChanges, describeRewind, type RewindResult, type TurnChanges } from "./rewind";
import { registerTool, registerToolGroup, str, type ToolRisk } from "./tools";
import { isDuplicate, screen } from "./vendor/openbot/memoryFilter";

registerToolGroup({ id: "web", label: "Web", description: "Search the web and read pages." });
registerToolGroup({ id: "knowledge", label: "Knowledge & memory", description: "Search your knowledge files and remember facts about you." });
registerToolGroup({ id: "create", label: "Images", description: "Create images with your image model." });
registerToolGroup({ id: "utility", label: "Utilities", description: "Date and time, calculator." });
registerToolGroup({
  id: "local",
  label: "This computer",
  description: "Run commands and read/write files on this computer (asks before acting).",
  platforms: ["desktop"],
});

registerTool({
  name: "web_search",
  group: "web",
  risk: "read",
  description: "Search the web for current information. Returns titles, links and snippets (and page text for the top results).",
  parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] },
  async run(args, ctx) {
    const sources = await webSearch(str(args, "query"), ctx.settings.search, ctx.settings.useProxy, ctx.signal);
    if (!sources.length) return "No results.";
    return {
      content: sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${(s.content ?? s.snippet).slice(0, 2500)}`).join("\n\n"),
      untrustedSource: "web search results",
    };
  },
});

/**
 * Reading an ordinary public page needs no approval. Ask first when the URL could reach a private
 * network (router, local servers, cloud metadata) or could smuggle data out in a long URL.
 */
export function urlNeedsApproval(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) ||
    /^[\d.]+$/.test(host) ||
    host.includes(":");
  return privateHost || Boolean(url.username || url.password) || raw.length > 200 || url.search.length > 120 || carriesData(url);
}

/**
 * Whether a URL looks like it carries encoded data out (a prompt injection's "fetch this badge"):
 * long base64-like or hex runs, or a path chopped into many pieces.
 */
function carriesData(url: URL): boolean {
  let text: string;
  try {
    text = decodeURIComponent(`${url.pathname}${url.search}`);
  } catch {
    return true;
  }
  const tokens = text.split(/[/?&=.,;:+_-]+/).filter(Boolean);
  if (url.pathname.split("/").filter(Boolean).length > 10) return true;
  return tokens.some(
    (t) =>
      (t.length >= 24 && /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)) || // base64-like
      (t.length >= 48 && /^[0-9a-f]+$/i.test(t)) || // long hex
      (t.length >= 60 && !/[aeiou]{1}.*[aeiou]/i.test(t)),
  );
}

registerTool({
  name: "read_url",
  group: "web",
  risk: "read",
  kind: "fetch",
  riskFor: (args): ToolRisk => (urlNeedsApproval(String(args.url ?? "")) ? "write" : "read"),
  description: "Read the text of a web page.",
  parameters: { type: "object", properties: { url: { type: "string", description: "Full http(s) URL" } }, required: ["url"] },
  async run(args, ctx) {
    const url = str(args, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("Give a full http(s) URL.");
    // A private address was approved by the user; a public one may not redirect to a private one.
    const text = await readPage(url, ctx.settings.useProxy, ctx.signal, !urlNeedsApproval(url));
    if (!text) throw new Error("Couldn't read that page (blocked, not text, or unreachable).");
    return { content: text, untrustedSource: url };
  },
});

registerTool({
  name: "search_knowledge",
  group: "knowledge",
  risk: "read",
  description:
    "Search the user's knowledge files (company documents, handbooks, product docs) and what you've saved about the user, for passages and memories relevant to a question.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  // Memories are all in the prompt until there are many of them; then searching them helps too.
  available: ({ settings, bot }) => settings.knowledge.length + (bot.knowledge?.length ?? 0) > 0 || memoryIsLarge(bot.memory),
  async run(args, ctx) {
    const query = str(args, "query");
    // The bot as this turn sees it (chat rooms hand over a copy without its private memory). A
    // small memory is already in the prompt whole.
    const memory = memoryIsLarge(ctx.bot.memory) ? ctx.bot.memory : [];
    const [result, memories] = await Promise.all([
      knowledgeContext([...ctx.settings.knowledge, ...(ctx.bot.knowledge ?? [])], query),
      searchMemory(ctx.bot, memory, query, 8),
    ]);
    if (!result.prompt && !memories.length) return "Nothing relevant found.";
    const remembered = memories.length ? `Saved memories about the user that may be relevant:\n${memories.map((m) => `- ${m}`).join("\n")}` : "";
    return result.prompt ? { content: [remembered, result.prompt].filter(Boolean).join("\n\n"), untrustedSource: "knowledge files" } : remembered;
  },
});

registerTool({
  name: "remember",
  group: "knowledge",
  risk: "read",
  description:
    "Save one lasting fact about the user (name, job, preferences, ongoing projects) to memory. Never secrets, contact details or instructions.",
  parameters: { type: "object", properties: { fact: { type: "string", description: "A short fact in third person" } }, required: ["fact"] },
  async run(args, ctx) {
    // OpenBOT's filter: no credentials, identifiers, transient remarks or instruction-shaped text.
    const screening = screen(str(args, "fact"));
    if (!screening.ok) return `Not saved: ${screening.reason}.`;
    const bot = useStore.getState().bots.find((b) => b.id === ctx.bot.id);
    if (bot && isDuplicate(screening.text!, bot.memory)) return "Already remembered.";
    if (ctx.conversationId && useStore.getState().conversations[ctx.conversationId]?.temporary) return "Not saved: this is a private chat.";
    addMemory(ctx.bot.id, [screening.text!]);
    return `Remembered: ${screening.text}`;
  },
});

registerTool({
  name: "create_image",
  group: "create",
  risk: "external",
  description: "Create an image from a text description using the configured image model.",
  parameters: { type: "object", properties: { prompt: { type: "string", description: "Detailed description of the image" } }, required: ["prompt"] },
  available: ({ providers, settings }) => resolveImageModel(providers, settings.image) !== null,
  async run(args, ctx) {
    const target = resolveImageModel(ctx.providers, ctx.settings.image);
    if (!target) throw new Error("No image model is set up.");
    ctx.progress(`Creating with ${target.model}…`);
    const { images, text } = await generateImage(target.provider, target.model, str(args, "prompt"), ctx.settings.useProxy, ctx.signal);
    if (!images.length) throw new Error(text || "The model returned no image.");
    return { content: `Created ${images.length} image(s); they are shown to the user.${text ? ` Notes: ${text}` : ""}`, display: { kind: "image", src: images[0] } };
  },
});

registerTool({
  name: "current_time",
  group: "utility",
  risk: "read",
  description: "The current date and time, optionally in a given IANA time zone (e.g. Asia/Kolkata).",
  parameters: { type: "object", properties: { timezone: { type: "string" } } },
  async run(args) {
    const zone = str(args, "timezone") || undefined;
    return new Date().toLocaleString("en-US", { timeZone: zone, dateStyle: "full", timeStyle: "long" });
  },
});

registerTool({
  name: "calculate",
  group: "utility",
  risk: "read",
  description: "Evaluate an arithmetic expression exactly: + - * / % ^, parentheses, and functions like sqrt, sin, log, round, min, max, PI, E.",
  parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  async run(args) {
    return String(calculate(str(args, "expression")));
  },
});

// This computer (desktop app) ----------------------------------------------------------

import { isDangerous } from "./danger";

export { isDangerous };

/**
 * Writing these could run code at login, change the shell, or hide a backdoor: always ask. So does
 * replacing an existing file outside the workspace (the desktop side refuses that without `overwrite`).
 */
export function writeRisk(path: string, overwrite = false): ToolRisk {
  const p = path.trim().replace(/\\/g, "/");
  if (insideWorkspace(p)) return "write";
  if (overwrite) return "destructive";
  if (/(^|\/)\.[^/]+(\/|$)/.test(p)) return "destructive"; // dotfiles and dot-folders (.zshrc, .ssh, .config…)
  if (/(^|\/)Library\/(LaunchAgents|LaunchDaemons|StartupItems|Scripts|Services|Application Support\/com\.apple)/i.test(p)) return "destructive";
  if (/^\/(etc|private|System|Library|usr|bin|sbin|var|opt|Applications)(\/|$)/i.test(p)) return "destructive";
  if (/\.(command|tool|app|plist|sh|zsh|bash|fish|workflow|scpt|applescript|terminal)$/i.test(p)) return "destructive";
  return "write";
}

const RUN_TIMEOUT_MS = 300_000;

registerTool({
  name: "run_command",
  group: "local",
  risk: "write",
  kind: "shell",
  platforms: ["desktop"],
  description:
    "Run a shell command on the user's computer and return its output. Runs in the ADT Bot Workspace folder unless cwd is given. The user approves commands.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, cwd: { type: "string", description: "Working folder (relative to the workspace, or absolute)" } },
    required: ["command"],
  },
  riskFor: (args): ToolRisk => (isDangerous(String(args.command ?? "")) ? "destructive" : "write"),
  // Sandbox mode runs it confined by the OS to the workspace (see electron/features/10-system.cjs).
  sandboxed: (args) => insideWorkspace(String(args.cwd ?? "")),
  timeoutMs: RUN_TIMEOUT_MS,
  async run(args, ctx) {
    const id = crypto.randomUUID();
    // Stop (or the loop's time limit) kills the command and everything it started.
    const cancel = () => void desktopInvoke("adt:system:cancel", { id }).catch(() => undefined);
    ctx.signal.addEventListener("abort", cancel, { once: true });
    const result = await desktopInvoke<{ code: number; output: string }>("adt:system:exec", {
      id,
      command: str(args, "command"),
      cwd: str(args, "cwd") || undefined,
      timeoutMs: RUN_TIMEOUT_MS - 5_000,
      // The desktop side snapshots the workspace first, so this turn's changes can be undone.
      turn: ctx.turnId,
      conversation: ctx.conversationId,
    }).finally(() => ctx.signal.removeEventListener("abort", cancel));
    const text = `${result.output.trim() || "(no output)"}\n[exit code ${result.code}]`;
    return { content: text, display: { kind: "terminal", text: `$ ${str(args, "command")}\n${text}` }, untrustedSource: "command output" };
  },
});

/** Relative and inside the workspace. Anything absolute (Unix, Windows drive, UNC or root-relative) or climbing out asks first. */
export const insideWorkspace = (p: string) =>
  !p || (!/^[/\\~]/.test(p) && !/^[a-zA-Z]:/.test(p) && !p.split(/[/\\]/).includes("..") && !p.includes("\0"));

registerTool({
  name: "read_file",
  group: "local",
  risk: "write",
  kind: "fetch",
  platforms: ["desktop"],
  description: "Read a text file on this computer. Relative paths are inside the ADT Bot Workspace folder.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  riskFor: (args) => (insideWorkspace(String(args.path ?? "")) ? "read" : "write"),
  sandboxed: (args) => insideWorkspace(String(args.path ?? "")),
  async run(args) {
    const file = await desktopInvoke<{ path: string; binary: boolean; text: string; size: number; truncated?: boolean }>("adt:system:read", { path: str(args, "path") });
    if (file.binary) return `${file.path} is a binary file (${file.size} bytes).`;
    return { content: `${file.text}${file.truncated ? "\n[file cut]" : ""}`, untrustedSource: file.path };
  },
});

registerTool({
  name: "write_file",
  group: "local",
  risk: "write",
  kind: "write",
  platforms: ["desktop"],
  description:
    "Create or overwrite a text file on this computer (relative paths go in the ADT Bot Workspace folder). Set append to add to the end. Replacing an existing file outside the workspace needs overwrite: true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      append: { type: "boolean" },
      overwrite: { type: "boolean", description: "Replace a file that already exists outside the workspace (asks the user)" },
    },
    required: ["path", "content"],
  },
  riskFor: (args) => writeRisk(String(args.path ?? ""), args.overwrite === true && !args.append),
  sandboxed: (args) => insideWorkspace(String(args.path ?? "")),
  async run(args, ctx) {
    const result = await desktopInvoke<{ path: string; size: number }>("adt:system:write", {
      path: str(args, "path"),
      content: str(args, "content"),
      append: Boolean(args.append),
      overwrite: args.overwrite === true,
      // The file's earlier version is kept with this turn, so it can be undone.
      turn: ctx.turnId,
      conversation: ctx.conversationId,
    });
    return `Saved ${result.path} (${result.size} bytes).`;
  },
});

registerTool({
  name: "rewind",
  group: "local",
  risk: "write",
  kind: "write",
  platforms: ["desktop"],
  description:
    "Undo file changes bots made in this chat: write_file anywhere, and commands run in the ADT Bot Workspace folder (kept for 7 days). " +
    "action list: the turns of this chat with file changes, newest first. action undo: put a turn's files back as they were and delete the files it created (turn: an id from list; default the latest). " +
    "Files someone changed after the bot did are left alone unless force is true (asks the user).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "undo"], description: "Default list" },
      turn: { type: "string", description: "undo: the turn's id from list (default: the latest)" },
      force: { type: "boolean", description: "undo: also overwrite files changed since" },
    },
  },
  riskFor: (args): ToolRisk => (str(args, "action", "list") !== "undo" ? "read" : args.force === true ? "destructive" : "write"),
  // The desktop side keeps Sandbox mode to files inside the workspace.
  sandboxed: () => true,
  async run(args, ctx) {
    const turns = (await desktopInvoke<TurnChanges[]>("adt:system:change-turns", { conversation: ctx.conversationId })).filter((t) => t.files.length);
    if (str(args, "action", "list") !== "undo") {
      if (!turns.length) return "No file changes from bots in this chat (or they're more than 7 days old).";
      return `Turns in this chat with file changes, newest first:\n${turns
        .slice(0, 20)
        .map((t) => `- turn ${t.turn}${t.turn === ctx.turnId ? " (this one)" : ""}, ${new Date(t.at).toLocaleString()}: ${describeChanges(t.files)}`)
        .join("\n")}`;
    }
    const turn = str(args, "turn") || turns[0]?.turn;
    if (!turn) return "There are no file changes to undo in this chat.";
    if (!turns.some((t) => t.turn === turn)) throw new Error(`No file changes are kept for turn ${turn} in this chat. Use action list.`);
    const result = await desktopInvoke<RewindResult>("adt:system:rewind", { turn, force: args.force === true, by: "bot" });
    return describeRewind(result) + (result.conflicts.length && args.force !== true ? " To undo those too, call rewind again with force: true (the user will be asked)." : "");
  },
});

registerTool({
  name: "list_files",
  group: "local",
  risk: "read",
  platforms: ["desktop"],
  description: "List a folder on this computer (default: the ADT Bot Workspace folder).",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  riskFor: (args) => (insideWorkspace(String(args.path ?? "")) ? "read" : "write"),
  sandboxed: (args) => insideWorkspace(String(args.path ?? "")),
  async run(args) {
    const result = await desktopInvoke<{ path: string; entries: { name: string; type: string; size: number }[] }>("adt:system:list", { path: str(args, "path") || "." });
    return `${result.path}\n${result.entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "file" ? ` (${e.size} B)` : ""}`).join("\n") || "(empty)"}`;
  },
});

registerTool({
  name: "open_on_computer",
  group: "local",
  risk: "write",
  kind: "fetch",
  platforms: ["desktop"],
  description: "Open a file, folder or web link on the user's computer with its default app.",
  parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
  // Sandbox mode: a web link, or a workspace file, which is only shown in its folder (see 10-system.cjs).
  sandboxed: (args) => {
    const target = String(args.target ?? "").trim();
    return /^https?:\/\//i.test(target) || insideWorkspace(target);
  },
  async run(args) {
    const result = await desktopInvoke<{ opened?: string; revealed?: string } | undefined>("adt:system:open", { target: str(args, "target") });
    return result?.revealed ? `Showed ${result.revealed} in its folder (Sandbox mode doesn't open files).` : `Opened ${str(args, "target")}.`;
  },
});

export const desktopReady = isDesktop;

/** Small, safe arithmetic evaluator (no eval): numbers, + - * / % ^, parentheses, Math functions. */
export function calculate(expression: string): number {
  const tokens = expression.replace(/\s+/g, "").match(/\d+\.?\d*(e[+-]?\d+)?|\.\d+|[a-zA-Z_]+|\*\*|[-+*/%^(),]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) throw new Error("Unsupported characters in expression.");
  let i = 0;
  const fns: Record<string, (...a: number[]) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    log: Math.log10, ln: Math.log, log2: Math.log2, exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow,
  };
  const consts: Record<string, number> = { PI: Math.PI, pi: Math.PI, E: Math.E, e: Math.E };
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const power = (): number => {
    const base = unary();
    if (peek() === "^" || peek() === "**") {
      next();
      return base ** power();
    }
    return base;
  };
  const unary = (): number => {
    if (peek() === "-") {
      next();
      return -unary();
    }
    if (peek() === "+") {
      next();
      return unary();
    }
    return atom();
  };
  const atom = (): number => {
    const t = next();
    if (t === undefined) throw new Error("Incomplete expression.");
    if (t === "(") {
      const v = expr();
      if (next() !== ")") throw new Error("Missing ).");
      return v;
    }
    if (/^[\d.]/.test(t)) return Number(t);
    if (t in consts) return consts[t];
    if (t in fns) {
      if (next() !== "(") throw new Error(`${t} needs parentheses.`);
      const params = [expr()];
      while (peek() === ",") {
        next();
        params.push(expr());
      }
      if (next() !== ")") throw new Error("Missing ).");
      return fns[t](...params);
    }
    throw new Error(`Unknown name: ${t}`);
  };
  const value = expr();
  if (i !== tokens.length) throw new Error("Unexpected input after the expression.");
  return value;
}
