import { desktopInvoke, isDesktop } from "../desktop";
import { generateImage, resolveImageModel } from "../imagine";
import { knowledgeContext } from "../knowledge";
import { readPage, webSearch } from "../search";
import { addMemory, useStore } from "../store";
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

registerTool({
  name: "read_url",
  group: "web",
  risk: "read",
  description: "Read the text of a web page.",
  parameters: { type: "object", properties: { url: { type: "string", description: "Full http(s) URL" } }, required: ["url"] },
  async run(args, ctx) {
    const url = str(args, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("Give a full http(s) URL.");
    const text = await readPage(url, ctx.settings.useProxy, ctx.signal);
    if (!text) throw new Error("Couldn't read that page (blocked, not text, or unreachable).");
    return { content: text, untrustedSource: url };
  },
});

registerTool({
  name: "search_knowledge",
  group: "knowledge",
  risk: "read",
  description: "Search the user's knowledge files (company documents, handbooks, product docs) for passages relevant to a question.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  available: ({ settings, bot }) => settings.knowledge.length + (bot.knowledge?.length ?? 0) > 0,
  async run(args, ctx) {
    const result = await knowledgeContext([...ctx.settings.knowledge, ...(ctx.bot.knowledge ?? [])], str(args, "query"));
    return result.prompt ? { content: result.prompt, untrustedSource: "knowledge files" } : "Nothing relevant found.";
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

const DANGEROUS = /\b(rm\s+-[a-z]*[rf]|sudo|mkfs|dd\s+if=|shutdown|reboot|chmod\s+-R|chown\s+-R|kill(all)?\b|launchctl|diskutil\s+erase|curl[^|]*\|\s*(ba|z)?sh|>\s*\/dev\/)/i;

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
  riskFor: (args): ToolRisk => (DANGEROUS.test(String(args.command ?? "")) ? "destructive" : "write"),
  timeoutMs: 300_000,
  async run(args) {
    const result = await desktopInvoke<{ code: number; output: string }>("adt:system:exec", { command: str(args, "command"), cwd: str(args, "cwd") || undefined });
    const text = `${result.output.trim() || "(no output)"}\n[exit code ${result.code}]`;
    return { content: text, display: { kind: "terminal", text: `$ ${str(args, "command")}\n${text}` }, untrustedSource: "command output" };
  },
});

const insideWorkspace = (p: string) => !p || (!p.startsWith("/") && !p.startsWith("~") && !/^[a-zA-Z]:\\/.test(p) && !p.includes(".."));

registerTool({
  name: "read_file",
  group: "local",
  risk: "write",
  kind: "fetch",
  platforms: ["desktop"],
  description: "Read a text file on this computer. Relative paths are inside the ADT Bot Workspace folder.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  riskFor: (args) => (insideWorkspace(String(args.path ?? "")) ? "read" : "write"),
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
  description: "Create or overwrite a text file on this computer (relative paths go in the ADT Bot Workspace folder). Set append to add to the end.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } },
    required: ["path", "content"],
  },
  async run(args) {
    const result = await desktopInvoke<{ path: string; size: number }>("adt:system:write", { path: str(args, "path"), content: str(args, "content"), append: Boolean(args.append) });
    return `Saved ${result.path} (${result.size} bytes).`;
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
  async run(args) {
    await desktopInvoke("adt:system:open", { target: str(args, "target") });
    return `Opened ${str(args, "target")}.`;
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
