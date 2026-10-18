/**
 * Model Context Protocol, client side: the pure parts (messages, SSE parsing, tool naming, risk,
 * result conversion). No network or platform code here, so all of it runs in tests.
 *
 * Adapted from CopilotKit OpenBot, MIT, (c) 2026 CopilotKit — result conversion
 * (server/src/plugins/mcp.ts: visible truncation at 20 000 characters, resource links shown as
 * labelled lines, structuredContent when content is empty, an explicit "nothing returned").
 */
import type { ToolDisplay } from "../types";

/** What we ask for; the server may answer with any version in SUPPORTED_PROTOCOL_VERSIONS. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const LIST_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 60_000;
export const MAX_RESULT_CHARS = 20_000;

export type JsonRpcId = string | number;
export type JsonRpcRequest = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: Record<string, unknown> };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => "id" in m && !("method" in m);
export const isRequest = (m: JsonRpcMessage): m is JsonRpcRequest => "method" in m && "id" in m && m.id !== undefined && m.id !== null;
export const isNotification = (m: JsonRpcMessage): m is JsonRpcNotification => "method" in m && !("id" in m && m.id !== undefined && m.id !== null);

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** A tool as tools/list describes it (only the fields we use). */
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri?: string; mimeType?: string; text?: string; blob?: string } }
  | { type: "resource_link"; uri?: string; name?: string; title?: string; description?: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

export type McpCallResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

/** A JSON-RPC error returned by the server. */
export class McpError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** An HTTP failure from a remote server (status kept so the caller can decide to fall back). */
export class McpHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

/** The server forgot our session (HTTP 404 with a session id): reconnect and try again. */
export class McpSessionExpiredError extends Error {
  constructor() {
    super("The server ended the session.");
    this.name = "McpSessionExpiredError";
  }
}

/** The transport is gone (process exited, stream closed). Reconnecting may help. */
export class McpClosedError extends Error {
  constructor(message = "The connection to the server closed.") {
    super(message);
    this.name = "McpClosedError";
  }
}

export class McpTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s.`);
    this.name = "McpTimeoutError";
  }
}

// SSE -------------------------------------------------------------------------------------

export type SseEvent = { event: string; data: string; id?: string };

/** Incremental text/event-stream parser (handles \n, \r\n, multi-line data, comments). */
export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  const dispatch = () => {
    if (data.length) onEvent({ event: event || "message", data: data.join("\n"), id });
    event = "";
    data = [];
  };
  const line = (raw: string) => {
    if (raw === "") return dispatch();
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const isCrLf = buffer[index] === "\r" && buffer[index + 1] === "\n";
        // A lone \r at the very end may be the first half of \r\n: wait for more.
        if (buffer[index] === "\r" && index === buffer.length - 1) break;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + (isCrLf ? 2 : 1));
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = "";
      dispatch();
    },
  };
}

/** Reads a fetch body as SSE until it ends or the signal aborts. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void): Promise<void> {
  const parser = createSseParser(onEvent);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

/** One or many JSON-RPC messages from a JSON body or SSE data line. Invalid input is ignored. */
export function parseMessages(text: string): JsonRpcMessage[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list.filter((m): m is JsonRpcMessage => Boolean(m) && typeof m === "object" && (m as { jsonrpc?: unknown }).jsonrpc === "2.0");
}

// Naming and risk ---------------------------------------------------------------------------

/** 32-bit FNV-1a, base 36: short, stable suffix that keeps truncated names unique. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const clean = (text: string) =>
  text
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");

/** "My GitHub!" → "my_github". Used as the server part of tool names. */
export function serverSlug(name: string): string {
  return clean(name.toLowerCase()).slice(0, 24).replace(/[_-]+$/, "") || "server";
}

/**
 * `mcp_<server>_<tool>`, only [a-zA-Z0-9_-], at most 64 characters. When cleaning changed the name
 * or it had to be cut, a hash of the original is appended so two tools never collide.
 */
export function agentToolName(server: string, tool: string): string {
  const slug = serverSlug(server);
  const cleanedTool = clean(tool) || "tool";
  const full = `mcp_${slug}_${cleanedTool}`;
  if (full.length <= 64 && cleanedTool === tool) return full;
  const suffix = `_${shortHash(`${server}\u0000${tool}`)}`;
  if (full.length + suffix.length <= 64) return `${full}${suffix}`;
  return `${full.slice(0, 64 - suffix.length).replace(/[_-]+$/, "")}${suffix}`;
}

/**
 * Risk from the server's annotations: readOnlyHint → read (never asks), destructiveHint → destructive
 * (always asks), anything else → external (asks according to the approval policy). A tool claiming
 * both read-only and destructive is treated as destructive.
 */
export function riskFromAnnotations(annotations: McpToolAnnotations | undefined): "read" | "external" | "destructive" {
  if (annotations?.destructiveHint === true) return "destructive";
  if (annotations?.readOnlyHint === true) return "read";
  return "external";
}

/** A JSON schema the providers accept: always an object schema. */
export function toolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || schema.type !== "object") return { type: "object", properties: {} };
  const { $schema: _ignored, ...rest } = schema;
  return { properties: {}, ...rest };
}

// Results -------------------------------------------------------------------------------------

const LINK_FIELD_CHARS = 400;
const bounded = (value: string) => (value.length > LINK_FIELD_CHARS ? `${value.slice(0, LINK_FIELD_CHARS)}…` : value);
const field = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

/** What the model reads (text) and what the chat shows (first image) from a tools/call result. */
export function convertResult(result: McpCallResult): { text: string; display?: ToolDisplay; truncated: boolean } {
  const parts = Array.isArray(result.content) ? result.content : [];
  let display: ToolDisplay | undefined;
  const lines = parts.map((part): string => {
    if (!part || typeof part !== "object") return "[unknown content]";
    const item = part as Record<string, unknown>;
    switch (item.type) {
      case "text":
        return typeof item.text === "string" ? item.text : "";
      case "image": {
        const mime = field(item.mimeType) ?? "image/png";
        if (!display && typeof item.data === "string") display = { kind: "image", src: `data:${mime};base64,${item.data}` };
        return `[image (${mime}) — shown to the user]`;
      }
      case "audio":
        return `[audio (${field(item.mimeType) ?? "unknown type"})]`;
      case "resource": {
        const resource = (item.resource ?? {}) as Record<string, unknown>;
        const uri = field(resource.uri);
        if (typeof resource.text === "string") return uri ? `[resource ${uri}]\n${resource.text}` : resource.text;
        const mime = field(resource.mimeType);
        if (!display && typeof resource.blob === "string" && mime?.startsWith("image/")) {
          display = { kind: "image", src: `data:${mime};base64,${resource.blob}` };
          return `[image resource ${uri ?? ""} (${mime}) — shown to the user]`;
        }
        return `[binary resource${uri ? ` ${uri}` : ""}${mime ? ` (${mime})` : ""}]`;
      }
      case "resource_link": {
        const out: string[] = [];
        const uri = field(item.uri);
        if (uri) out.push(`uri: ${uri}`);
        const title = field(item.title) ?? field(item.name);
        if (title) out.push(`${field(item.title) ? "title" : "name"}: ${bounded(title)}`);
        const description = field(item.description);
        if (description) out.push(`description: ${bounded(description)}`);
        return out.length ? out.join("\n") : "[resource_link]";
      }
      default:
        return `[${String(item.type ?? "unknown")} content]`;
    }
  });
  let text = lines.join("\n");
  if (text.trim() === "") {
    const structured =
      result.structuredContent !== null && typeof result.structuredContent === "object" ? JSON.stringify(result.structuredContent) : "";
    text = structured || "The tool returned no content. Nothing was found, so there is nothing here to answer from.";
  }
  if (text.length <= MAX_RESULT_CHARS) return { text, display, truncated: false };
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    display,
    truncated: true,
  };
}
