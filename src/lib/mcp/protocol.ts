/**
 * Model Context Protocol, client side: the pure parts (messages, SSE parsing, tool naming, risk,
 * result conversion). No network or platform code here, so all of it runs in tests.
 *
 * Adapted from CopilotKit OpenBot, MIT, (c) 2026 CopilotKit — result conversion
 * (server/src/plugins/mcp.ts: visible truncation at 20 000 characters, resource links shown as
 * labelled lines, structuredContent when content is empty, an explicit "nothing returned").
 */
import type { ToolDisplay } from "../types";
import { stripHidden } from "./unicode";

/**
 * "Modern" versions (2026-07-28 on) are stateless: no handshake, every request carries its version
 * and capabilities in _meta. "Legacy" versions open with initialize. Newest first: the client
 * speaks the newest one the server supports.
 */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** What we ask for in initialize; the server may answer with any older legacy version. */
export const LATEST_LEGACY_VERSION = LEGACY_PROTOCOL_VERSIONS[0];
export const LATEST_PROTOCOL_VERSION = MODERN_PROTOCOL_VERSIONS[0];
export const SUPPORTED_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

export const LIST_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 60_000;
export const MAX_RESULT_CHARS = 20_000;

/** Error codes the 2026-07-28 spec defines; seeing one means the server is modern. */
export const HEADER_MISMATCH = -32020;
export const MISSING_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const MODERN_ERROR_CODES = [HEADER_MISMATCH, MISSING_CLIENT_CAPABILITY, UNSUPPORTED_PROTOCOL_VERSION];

/** Per-request _meta keys (modern versions). */
export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const;
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** A result's type; servers before 2026-07-28 leave it out, which means "complete". */
export function resultTypeOf(result: unknown): string {
  const type = (result as { resultType?: unknown } | null)?.resultType;
  return typeof type === "string" ? type : "complete";
}

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

/** Whether an error is one only 2026-07-28-or-later servers send. */
export function isModernError(error: unknown): boolean {
  return error instanceof McpError && MODERN_ERROR_CODES.includes(error.code);
}

/** The versions a server listed (UnsupportedProtocolVersion error or server/discover). */
export function supportedFrom(error: unknown): string[] {
  const data = error instanceof McpError ? (error.data as { supported?: unknown } | undefined) : undefined;
  return Array.isArray(data?.supported) ? data.supported.filter((v): v is string => typeof v === "string") : [];
}

// HTTP request headers (2026-07-28) ---------------------------------------------------------------

const SENTINEL = /^=\?base64\?.*\?=$/s;

/**
 * A header-safe value: plain visible ASCII as is; anything else (non-ASCII, control characters,
 * leading/trailing spaces, or text that looks like the encoding) as =?base64?…?=.
 */
export function headerValue(value: string): string {
  if (/^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !SENTINEL.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?base64?${btoa(binary)}?=`;
}

/** Mcp-Method and Mcp-Name for a request (tools/call name, resources/read uri, task id…). */
export function standardHeaders(message: JsonRpcMessage): Record<string, string> {
  if (!("method" in message)) return {};
  const headers: Record<string, string> = { "mcp-method": message.method };
  const p = message.params ?? {};
  const name =
    message.method === "tools/call" || message.method === "prompts/get"
      ? p.name
      : message.method === "resources/read"
        ? p.uri
        : message.method.startsWith("tasks/")
          ? p.taskId
          : undefined;
  if (typeof name === "string") headers["mcp-name"] = headerValue(name);
  return headers;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DATA_KEYWORDS = new Set(["default", "examples", "const", "enum"]);

export type McpHeaderParam = { header: string; path: string[] };

/**
 * The parameters a tool mirrors into Mcp-Param-* headers (x-mcp-header in its input schema), or why
 * the tool definition is invalid: the spec has clients drop such tools from the list.
 */
export function mcpHeaderParams(schema: unknown): { params: McpHeaderParam[] } | { error: string } {
  const params: McpHeaderParam[] = [];
  const seen = new Set<string>();
  let error = "";
  const visit = (node: unknown, path: string[], reachable: boolean, depth: number) => {
    if (error || !node || typeof node !== "object" || depth > 32) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path, false, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if ("x-mcp-header" in obj) {
      const name = obj["x-mcp-header"];
      if (!reachable || !path.length) error = "x-mcp-header is only allowed on properties reached through plain properties";
      else if (typeof name !== "string" || !TOKEN.test(name)) error = `x-mcp-header "${String(name)}" isn't a valid header name`;
      else if (seen.has(name.toLowerCase())) error = `x-mcp-header "${name}" is used twice`;
      else if (!["string", "integer", "boolean"].includes(String(obj.type))) error = `x-mcp-header "${name}" is on a ${String(obj.type ?? "untyped")} parameter`;
      else {
        seen.add(name.toLowerCase());
        params.push({ header: name, path });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (DATA_KEYWORDS.has(key) || key === "x-mcp-header") continue;
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [prop, child] of Object.entries(value)) visit(child, [...path, prop], reachable, depth + 1);
      } else {
        visit(value, path, false, depth + 1);
      }
    }
  };
  visit(schema, [], true, 0);
  return error ? { error } : { params };
}

/** Mcp-Param-* headers for a call's arguments; absent or null values send no header. */
export function paramHeaders(params: McpHeaderParam[], args: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { header, path } of params) {
    let value: unknown = args;
    for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    let text: string | undefined;
    if (typeof value === "string") text = value;
    else if (typeof value === "boolean") text = String(value);
    else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
    if (text !== undefined) headers[`mcp-param-${header.toLowerCase()}`] = headerValue(text);
  }
  return headers;
}

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
/** The most a connector may send in one message (32 MB of text). */
export const MAX_MESSAGE_CHARS = 32 * 1024 * 1024;

export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = "";
  let dataSize = 0;
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  const dispatch = () => {
    if (data.length) onEvent({ event: event || "message", data: data.join("\n"), id });
    event = "";
    data = [];
    dataSize = 0;
  };
  const line = (raw: string) => {
    if (raw === "") return dispatch();
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      dataSize += value.length;
      if (dataSize > MAX_MESSAGE_CHARS) throw new Error("The connector sent a message too large to read.");
    }
    else if (field === "id") id = value;
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      // A line that never ends would grow without limit: a server can't use up the app's memory.
      if (buffer.length > MAX_MESSAGE_CHARS) throw new Error("The connector sent a message too large to read.");
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
 * Risk from the server's annotations: destructiveHint → destructive (always asks), anything else →
 * external (asks according to the approval policy). A server's own readOnlyHint is only a claim (a
 * compromised server can label a write tool read-only), so it counts as read (never asks) only when
 * the user marked that tool read-only in Settings → Connectors (`trustedReadOnly`). A tool claiming
 * both read-only and destructive is treated as destructive.
 */
export function riskFromAnnotations(annotations: McpToolAnnotations | undefined, trustedReadOnly = false): "read" | "external" | "destructive" {
  if (annotations?.destructiveHint === true) return "destructive";
  if (trustedReadOnly) return "read";
  return "external";
}

/** What the server says about a tool, for the Connectors settings ("says it only reads"). */
export function claimsReadOnly(annotations: McpToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
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

/**
 * What the model reads (text) and what the chat shows (first image) from a tools/call result.
 * Hidden characters are removed (and counted): results are read by the model too.
 */
export function convertResult(result: McpCallResult): { text: string; display?: ToolDisplay; truncated: boolean; hidden: number } {
  const converted = convertParts(result);
  const { text, removed } = stripHidden(converted.text);
  if (!removed) return { ...converted, hidden: 0 };
  return { ...converted, text: `${text}\n\n[ADT Bot removed ${removed} hidden character${removed === 1 ? "" : "s"} from this result.]`, hidden: removed };
}

function convertParts(result: McpCallResult): { text: string; display?: ToolDisplay; truncated: boolean } {
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
