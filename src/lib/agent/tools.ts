import type { Platform } from "../transport";
import type { ToolImage } from "../llm";
import type { Bot, ProviderConfig, Settings, ToolDisplay } from "../types";
import type { JsonSchema, ToolSchema } from "./vendor/openbot/types";

export type { JsonSchema, ToolSchema };

/**
 * How risky a tool is. "read" tools (search, reading pages, listing files) never ask for approval;
 * everything else goes through the approval gate. "destructive" always asks, whatever the policy.
 */
export type ToolRisk = "read" | "write" | "external" | "destructive";

/** Groups the user can switch on/off per bot (Bot settings → Tools). */
export type ToolGroup = {
  id: string;
  label: string;
  description: string;
  /** Platforms where the group exists at all. */
  platforms?: Platform[];
};

export type ToolContext = {
  bot: Bot;
  conversationId: string;
  settings: Settings;
  providers: ProviderConfig[];
  platform: Platform;
  signal: AbortSignal;
  /** Short progress line shown under the tool while it runs. */
  progress: (text: string) => void;
};

export type ToolResult =
  | string
  | {
      /** What the model reads. */
      content: string;
      /** What the chat shows (screenshot, terminal output…). */
      display?: ToolDisplay;
      /** Name the outside source when the content came from the web, a file, another program… */
      untrustedSource?: string;
      /** An image the model should see (e.g. a screenshot), sent with the result to models that can view images. */
      image?: ToolImage;
    };

export type AgentTool = ToolSchema & {
  group: string;
  risk: ToolRisk;
  /** Approval-card category (shell, write, fetch, computer, mcp). */
  kind?: "shell" | "write" | "edit" | "fetch" | "computer" | "mcp";
  /** Platforms where this tool can run (default: everywhere). */
  platforms?: Platform[];
  /** Extra runtime check, e.g. "Docker is running" or "an image model is configured". */
  available?: (ctx: Pick<ToolContext, "settings" | "providers" | "platform" | "bot">) => boolean;
  /** Per-call risk: e.g. a GET is read-only, a POST needs approval. */
  riskFor?: (args: Record<string, unknown>) => ToolRisk;
  /** Give up after this long (default 120 s). */
  timeoutMs?: number;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

const tools = new Map<string, AgentTool>();
const groups = new Map<string, ToolGroup>();
const listeners = new Set<() => void>();

export function registerToolGroup(group: ToolGroup) {
  groups.set(group.id, group);
  listeners.forEach((l) => l());
}

/** Adds (or replaces) a tool. Features call this at startup; MCP connectors call it at runtime. */
export function registerTool(tool: AgentTool) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
  tools.set(tool.name, tool);
  listeners.forEach((l) => l());
}

export function unregisterTool(name: string) {
  tools.delete(name);
  listeners.forEach((l) => l());
}

export function onToolsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTool(name: string): AgentTool | undefined {
  return tools.get(name);
}

export function allTools(): AgentTool[] {
  return [...tools.values()];
}

export function allToolGroups(): ToolGroup[] {
  return [...groups.values()];
}

/** Tools this bot may use right now on this platform. */
export function toolsFor(ctx: Pick<ToolContext, "settings" | "providers" | "platform" | "bot">): AgentTool[] {
  if (!ctx.settings.agent.enabled) return [];
  const wanted = ctx.bot.toolGroups ?? "all";
  return allTools().filter((tool) => {
    if (wanted !== "all" && !wanted.includes(tool.group)) return false;
    const group = groups.get(tool.group);
    if (group?.platforms && !group.platforms.includes(ctx.platform)) return false;
    if (tool.platforms && !tool.platforms.includes(ctx.platform)) return false;
    try {
      return tool.available ? tool.available(ctx) : true;
    } catch {
      return false;
    }
  });
}

/** Normalises a tool's return value. */
export function toResult(value: ToolResult): Exclude<ToolResult, string> {
  return typeof value === "string" ? { content: value } : value;
}

/** Arguments helpers for tool implementations. */
export function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);
}
export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = Number(args[key]);
  return Number.isFinite(v) ? v : fallback;
}
