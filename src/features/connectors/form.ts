import type { ConnectorConfig } from "../../lib/mcp/connectors";

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
    return { config: { name, transport: "http", url, token: d.token.trim() || undefined, headers: parsePairs(d.headers, ":"), direct: d.direct || undefined, timeoutSec } };
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
  return { config: { name, transport: "stdio", command, args, env: parsePairs(d.env, "="), cwd: d.cwd.trim() || undefined, timeoutSec } };
}

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
