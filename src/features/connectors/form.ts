import type { ConnectorConfig } from "../../lib/mcp/connectors";
import { commandLine } from "../../lib/mcp/security";

const SECRET_NAME = /key|token|secret|passw|auth|credential|cookie/i;

/**
 * What the user confirms before a local server first runs: the whole command line, never
 * shortened (values of variables that look like secrets are hidden; everything else is shown).
 */
export function launchConfirmText(c: Pick<ConnectorConfig, "name" | "command" | "args" | "env" | "cwd">): string {
  const env = Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, SECRET_NAME.test(k) && v ? "•••" : v]));
  return (
    `Run this command on your computer for the "${c.name}" connector?\n\n${commandLine({ ...c, env })}\n\n` +
    "It runs with your permissions: it can read and change your files and use the network. Only allow servers you trust."
  );
}

/** Splits a command line into arguments, honouring "double" and 'single' quotes and backslashes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      current += text[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (has || current) out.push(current);
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`)).join(" ");
}

/** "Name: value" (headers) or "NAME=value" (env) per line. */
export function parsePairs(text: string, separator: ":" | "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key) out[key] = line.slice(index + 1).trim();
  }
  return out;
}

export function formatPairs(pairs: Record<string, string> | undefined, separator: ":" | "="): string {
  return Object.entries(pairs ?? {})
    .map(([k, v]) => `${k}${separator === ":" ? ": " : "="}${v}`)
    .join("\n");
}

export type Draft = {
  name: string;
  transport: "http" | "stdio";
  url: string;
  token: string;
  headers: string;
  direct: boolean;
  command: string;
  args: string;
  env: string;
  cwd: string;
  timeoutSec: string;
  /** The server acts on this computer (screen, apps, files): it follows Computer access. */
  controlsComputer: boolean;
};

export const emptyDraft = (transport: Draft["transport"] = "http"): Draft => ({
  name: "",
  transport,
  url: "",
  token: "",
  headers: "",
  direct: false,
  command: "",
  args: "",
  env: "",
  cwd: "",
  timeoutSec: "",
  controlsComputer: false,
});

export function draftFrom(c: ConnectorConfig): Draft {
  return {
    name: c.name,
    transport: c.transport,
    url: c.url ?? "",
    token: c.token ?? "",
    headers: formatPairs(c.headers, ":"),
    direct: Boolean(c.direct),
    command: c.command ?? "",
    args: joinArgs(c.args ?? []),
    env: formatPairs(c.env, "="),
    cwd: c.cwd ?? "",
    timeoutSec: c.timeoutSec ? String(c.timeoutSec) : "",
    controlsComputer: Boolean(c.controlsComputer),
  };
}

/** The saved fields for a draft, or an error message. */
export function configFromDraft(d: Draft): { error: string } | { config: Omit<ConnectorConfig, "id" | "disabledTools" | "enabled" | "tools"> } {
  const name = d.name.trim();
  if (!name) return { error: "Give the connector a name." };
  const timeout = Number(d.timeoutSec);
  const timeoutSec = d.timeoutSec.trim() && Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.round(timeout), 3600) : undefined;
  if (d.transport === "http") {
    const url = d.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return { error: "Enter the server's full URL, starting with https://" };
    return {
      config: { name, transport: "http", url, token: d.token.trim() || undefined, headers: parsePairs(d.headers, ":"), direct: d.direct || undefined, timeoutSec, controlsComputer: d.controlsComputer || undefined },
    };
  }
  // Allow pasting a whole command line into the command field.
  let command = d.command.trim();
  let args = splitArgs(d.args);
  if (!command) return { error: "Enter the command that starts the server (for example npx)." };
  if (/\s/.test(command) && !args.length) {
    const parts = splitArgs(command);
    command = parts[0] ?? "";
    args = parts.slice(1);
  }
  return { config: { name, transport: "stdio", command, args, env: parsePairs(d.env, "="), cwd: d.cwd.trim() || undefined, timeoutSec, controlsComputer: d.controlsComputer || undefined } };
}

/**
 * Open-source Mac-control servers that work as connectors. ADT Bot already controls Mac apps
 * through accessibility (mac_ui, mac_press…); these add extras such as OCR, window management,
 * recipes or Chrome DevTools. Each needs installing once, from a terminal.
 */
export const COMPUTER_PRESETS: { label: string; hint: string; install: string; license: string; url: string; draft: Partial<Draft> }[] = [
  {
    label: "Peekaboo",
    hint: "Screenshots with element maps, menus, windows, Dock, dialogs, Spaces and the clipboard. Needs macOS 15+. Works in the background unless you add --allow-foreground.",
    install: "brew install openclaw/tap/peekaboo",
    license: "MIT",
    url: "https://github.com/openclaw/Peekaboo",
    draft: { name: "Peekaboo", transport: "stdio", command: "peekaboo", args: "mcp", controlsComputer: true, timeoutSec: "120" },
  },
  {
    label: "Ghost OS",
    hint: "Find, click and type by name, wait for UI changes, and replay recorded recipes. Apple silicon, macOS 14+. Skip its optional 3 GB vision model on 8 GB Macs.",
    install: "brew install ghostwright/ghost-os/ghost-os",
    license: "MIT",
    url: "https://github.com/ghostwright/ghost-os",
    draft: { name: "Ghost OS", transport: "stdio", command: "ghost", args: "mcp", controlsComputer: true, timeoutSec: "120" },
  },
  {
    label: "macOS Computer Use Kit",
    hint: "Accessibility snapshots with change diffs, menus by path (File > Export…), on-device OCR and waits. Needs uv (brew install uv).",
    install: "brew install uv",
    license: "MIT",
    url: "https://github.com/Sur-Cai/macos-computer-use-kit",
    draft: { name: "Computer Use Kit", transport: "stdio", command: "uvx", args: "macos-computer-use-kit mcp", controlsComputer: true, timeoutSec: "120" },
  },
];

/** Examples shown in the add form. None of them are needed for anything to work. */
export const PRESETS: { label: string; hint: string; draft: Partial<Draft>; desktopOnly?: boolean }[] = [
  {
    label: "DeepWiki (remote, no sign-in)",
    hint: "A public server that answers questions about GitHub repositories.",
    draft: { name: "DeepWiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
  {
    label: "Remote server with a token",
    hint: "Most hosted servers (GitHub, Linear, Notion…) give you a URL and an API key or personal access token.",
    draft: { name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", token: "" },
  },
  {
    label: "Everything (local test server)",
    hint: "The MCP reference test server. Needs Node.js.",
    draft: { name: "Everything", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-everything" },
    desktopOnly: true,
  },
  {
    label: "Files in a folder (local)",
    hint: "Lets bots read and write files in one folder. Needs Node.js.",
    draft: { name: "Files", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-filesystem ~/Documents" },
    desktopOnly: true,
  },
];
