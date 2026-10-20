/**
 * Trust checks for connectors, kept pure so they are tested directly:
 *
 * - Tool metadata is cleaned of hidden characters before the model or the user sees it.
 * - Tool definitions are pinned when the user adds a server. A tool whose description, inputs or
 *   safety hints change later ("rug pull"), or a tool that appears later, stays off until the
 *   user reviews it: a changed description is read by the model even if the tool is never called.
 * - A local server's command runs only after the user confirmed that exact command.
 */
import { type McpTool, shortHash } from "./protocol";
import { cleanDeep, stripHidden } from "./unicode";

// Hidden characters ------------------------------------------------------------------------------

const cleaned = new WeakMap<McpTool, { tool: McpTool; hidden: number }>();

/** The tool as the model and the user see it (hidden characters removed), and how many there were. */
export function cleanTool(tool: McpTool): { tool: McpTool; hidden: number } {
  const cached = cleaned.get(tool);
  if (cached) return cached;
  const name = stripHidden(tool.name);
  const title = stripHidden(tool.title ?? "");
  const description = stripHidden(tool.description ?? "");
  const schema = cleanDeep(tool.inputSchema);
  const annotations = cleanDeep(tool.annotations);
  const hidden = name.removed + title.removed + description.removed + schema.removed + annotations.removed;
  const out = {
    tool: hidden
      ? {
          ...tool,
          name: name.text,
          title: tool.title === undefined ? undefined : title.text,
          description: tool.description === undefined ? undefined : description.text,
          inputSchema: schema.value,
          annotations: annotations.value,
        }
      : tool,
    hidden,
  };
  cleaned.set(tool, out);
  return out;
}

/** Tools of a server whose metadata had hidden characters. */
export function toolsWithHidden(tools: McpTool[] | undefined): { name: string; hidden: number }[] {
  return (tools ?? []).map((t) => ({ name: cleanTool(t).tool.name, hidden: cleanTool(t).hidden })).filter((t) => t.hidden > 0);
}

// Pinned tool definitions ------------------------------------------------------------------------

/** Sorted-key JSON, so the same definition always gives the same text. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown, depth: number): unknown => {
    if (!v || typeof v !== "object" || depth > 64) return v;
    if (Array.isArray(v)) return v.map((x) => sort(x, depth + 1));
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sort((v as Record<string, unknown>)[k], depth + 1)]),
    );
  };
  return JSON.stringify(sort(value, 0)) ?? "";
}

/** Everything about a tool the model reads or the approval rules use, exactly as the server sent it. */
export function toolDefinition(tool: McpTool): string {
  return canonicalJson({ title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations });
}

export type ToolReview = {
  name: string;
  kind: "new" | "changed";
  /** What changed: "description", "inputs", "title", "safety hints". */
  changes: string[];
  /** Descriptions for the user to compare (hidden characters removed). */
  before?: string;
  after: string;
};

const parse = (definition: string): Partial<McpTool> => {
  try {
    return JSON.parse(definition) as Partial<McpTool>;
  } catch {
    return {};
  }
};

/** Tools that differ from what the user approved (new ones too). Nothing is pinned yet → nothing to review. */
export function toolsToReview(tools: McpTool[] | undefined, approved: Record<string, string> | undefined): ToolReview[] {
  if (!approved) return [];
  const out: ToolReview[] = [];
  for (const tool of tools ?? []) {
    const now = toolDefinition(tool);
    const pinned = Object.prototype.hasOwnProperty.call(approved, tool.name) ? approved[tool.name] : undefined;
    if (pinned === now) continue;
    const after = stripHidden(tool.description ?? "").text;
    if (pinned === undefined) {
      out.push({ name: tool.name, kind: "new", changes: [], after });
      continue;
    }
    const old = parse(pinned);
    const changes = [
      canonicalJson(old.description) !== canonicalJson(tool.description) && "description",
      canonicalJson(old.inputSchema) !== canonicalJson(tool.inputSchema) && "inputs",
      canonicalJson(old.title) !== canonicalJson(tool.title) && "title",
      canonicalJson(old.annotations) !== canonicalJson(tool.annotations) && "safety hints",
    ].filter((c): c is string => Boolean(c));
    out.push({ name: tool.name, kind: "changed", changes, before: stripHidden(old.description ?? "").text, after });
  }
  return out;
}

/** Pins the current definitions of the named tools (all of them when names is omitted). */
export function approveTools(approved: Record<string, string> | undefined, tools: McpTool[] | undefined, names?: string[]): Record<string, string> {
  const next = { ...(approved ?? {}) };
  for (const tool of tools ?? []) if (!names || names.includes(tool.name)) next[tool.name] = toolDefinition(tool);
  return next;
}

// Local commands --------------------------------------------------------------------------------

type Launch = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string };

/** Identifies exactly what a local server runs: command, arguments, environment and folder. */
export function launchKey(c: Launch): string {
  return shortHash(JSON.stringify([c.command?.trim() ?? "", c.args ?? [], Object.entries(c.env ?? {}).sort(), c.cwd?.trim() ?? ""]));
}

const quoteArg = (a: string) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/** The full command line, as shown to the user before it runs (never shortened). */
export function commandLine(c: Launch): string {
  const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${quoteArg(v)}`);
  const cmd = [c.command?.trim() ?? "", ...(c.args ?? [])].map(quoteArg).join(" ");
  return `${c.cwd?.trim() ? `cd ${quoteArg(c.cwd.trim())} && ` : ""}${env.length ? `${env.join(" ")} ` : ""}${cmd}`;
}
