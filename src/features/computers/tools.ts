/** Agent tools for a bot's own computer (a Docker container on this machine, desktop app only). */
import { num, registerTool, registerToolGroup, str, type ToolContext } from "../../lib/agent/tools";
import { isDesktop } from "../../lib/desktop";
import { computers, newRunId, onOutput } from "./api";
import { fetchesWeb, formatBytes, riskForCommand } from "./logic";
import { configFor, hasComputer, loadComputers } from "./store";

registerToolGroup({
  id: "computer",
  label: "Own computer",
  description: "The bot's own Linux computer (a Docker container on this machine): run commands, keep files, browse.",
  platforms: ["desktop"],
});

if (isDesktop()) void loadComputers();

const available = (ctx: Pick<ToolContext, "bot">) => hasComputer(ctx.bot.id);
const where = (ctx: ToolContext) => `${ctx.bot.name}'s computer`;

registerTool({
  name: "computer_run",
  group: "computer",
  risk: "write",
  kind: "shell",
  platforms: ["desktop"],
  available,
  description:
    "Run a bash command on your own Linux computer (Debian, user `bot`, working folder /workspace; python3, node, git and curl are installed). " +
    "Files in /workspace persist. It is a sandbox separate from the user's machine. Use it to code, run scripts, process data or download things.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command (runs in /workspace unless cwd is given)" },
      cwd: { type: "string", description: "Working folder inside the computer" },
      timeout_seconds: { type: "number", description: "Stop after this many seconds (default 120, max 600)" },
    },
    required: ["command"],
  },
  riskFor: (args) => riskForCommand(str(args, "command")),
  timeoutMs: 620_000,
  async run(args, ctx) {
    const command = str(args, "command");
    const runId = newRunId();
    let tail = "";
    const off = onOutput((e) => {
      if (e.runId !== runId) return;
      tail = (tail + e.chunk).slice(-400);
      const last = tail.trimEnd().split("\n").pop();
      if (last) ctx.progress(last.slice(0, 120));
    });
    const abort = () => void computers.cancel(runId).catch(() => undefined);
    ctx.signal.addEventListener("abort", abort, { once: true });
    ctx.progress(`Running in ${where(ctx)}…`);
    try {
      const timeoutMs = Math.min(600, Math.max(1, num(args, "timeout_seconds", 120))) * 1000;
      const result = await computers.exec(ctx.bot.id, command, { runId, timeoutMs, cwd: str(args, "cwd") || undefined });
      const text = `${result.output.trim() || "(no output)"}\n[exit code ${result.code}]`;
      return {
        content: text,
        display: { kind: "terminal", text: `bot@computer:${str(args, "cwd") || "/workspace"}$ ${command}\n${text}` },
        untrustedSource: fetchesWeb(command) ? `web content fetched by a command in ${where(ctx)}` : `command output from ${where(ctx)}`,
      };
    } finally {
      off();
      ctx.signal.removeEventListener("abort", abort);
    }
  },
});

registerTool({
  name: "computer_read_file",
  group: "computer",
  risk: "read",
  platforms: ["desktop"],
  available,
  description: "Read a text file on your own computer. Relative paths are inside /workspace.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run(args, ctx) {
    const file = await computers.read(ctx.bot.id, str(args, "path"));
    if (file.binary) return `${file.path} is a binary file (${formatBytes(file.size)}).`;
    return { content: `${file.text}${file.truncated ? `\n[file cut; ${formatBytes(file.size)} in total]` : ""}`, untrustedSource: `${file.path} in ${where(ctx)}` };
  },
});

registerTool({
  name: "computer_write_file",
  group: "computer",
  risk: "write",
  kind: "write",
  platforms: ["desktop"],
  available,
  description: "Create or overwrite a text file on your own computer (relative paths go in /workspace; folders are created). Set append to add to the end.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const result = await computers.write(ctx.bot.id, str(args, "path"), str(args, "content"), Boolean(args.append));
    return `Saved ${result.path} (${formatBytes(result.size)}) in ${where(ctx)}.`;
  },
});

registerTool({
  name: "computer_list_files",
  group: "computer",
  risk: "read",
  platforms: ["desktop"],
  available,
  description: "List a folder on your own computer (default /workspace).",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  async run(args, ctx) {
    const result = await computers.listFiles(ctx.bot.id, str(args, "path") || "/workspace");
    const lines = result.entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "file" ? ` (${formatBytes(e.size)})` : ""}`);
    return { content: `${result.path}\n${lines.join("\n") || "(empty)"}`, untrustedSource: `file names in ${where(ctx)}` };
  },
});

registerTool({
  name: "computer_browse",
  group: "computer",
  risk: "external",
  kind: "fetch",
  platforms: ["desktop"],
  available: (ctx) => hasComputer(ctx.bot.id) && Boolean(configFor(ctx.bot.id).browser) && configFor(ctx.bot.id).network,
  description: "Open a web page in the headless Chromium on your own computer; returns the page text and a screenshot.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  timeoutMs: 150_000,
  async run(args, ctx) {
    const runId = newRunId();
    const abort = () => void computers.cancel(runId).catch(() => undefined);
    ctx.signal.addEventListener("abort", abort, { once: true });
    ctx.progress(`Opening ${str(args, "url")}…`);
    try {
      const page = await computers.browse(ctx.bot.id, str(args, "url"), runId);
      return {
        content: page.text.slice(0, 40000) || "(the page has no readable text)",
        display: page.screenshot ? { kind: "image", src: page.screenshot, caption: page.url } : undefined,
        untrustedSource: page.url,
      };
    } finally {
      ctx.signal.removeEventListener("abort", abort);
    }
  },
});
