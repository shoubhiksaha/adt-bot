/**
 * Minimal type shims so the OpenBOT files (MIT, see LICENSE) compile unchanged inside ADT Bot.
 * The originals live in OpenBOT's src/shared/types.ts and src/main/backends/types.ts.
 */
export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[]; [key: string]: unknown };
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
  computerUse?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type ApprovalPolicy = "ask-every-time" | "ask-first-time" | "allowlist" | "auto-run";
export interface ApprovalRequest {
  kind: "shell" | "write" | "edit" | "fetch" | "computer" | "mcp";
}
export interface Settings {
  approvalPolicy?: ApprovalPolicy;
  allowlist?: string[];
  denylist?: string[];
}
export interface MemoryEntry {
  text?: string;
}
export type ChatChunk = { type: "text"; delta?: string } | { type: "tool_call"; call: ToolCall } | { type: "done" } | { type: "reasoning"; delta?: string };
export type ProviderMessage = { role: string; content: unknown };
