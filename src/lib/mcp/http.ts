/**
 * Remote MCP transports: Streamable HTTP (current spec) and the legacy HTTP+SSE transport
 * (2024-11-05), with the spec's backwards-compatible fallback from the first to the second.
 * The fetch function is injected: the app routes it through its CORS relay; tests use plain fetch.
 *
 * Adapted from CopilotKit OpenBot, MIT, (c) 2026 CopilotKit — authorizationHeader (server/src/plugins/mcp.ts).
 */
import { type Era, McpClient, McpStreamEndedError, type McpTransport, type SendOptions } from "./client";
import {
  isResponse,
  type JsonRpcMessage,
  LIST_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  McpClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  parseMessages,
  readSse,
  standardHeaders,
} from "./protocol";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

/** Authorization header from a pasted token: "Bearer" is added unless a scheme is already there. */
export function authorizationHeader(token: string): string {
  const trimmed = token.trim();
  return /^(basic|bearer)\s+\S/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

async function failure(res: Response, what: string): Promise<McpHttpError> {
  let detail = "";
  try {
    const text = (await res.text()).trim();
    try {
      const body = JSON.parse(text);
      detail = body?.error?.message ?? body?.error_description ?? body?.message ?? (typeof body?.error === "string" ? body.error : "");
    } catch {
      detail = text.startsWith("<") ? "" : text;
    }
  } catch {
    // no body
  }
  detail = String(detail).slice(0, 300);
  const hint =
    res.status === 401
      ? " The server wants a sign-in: add a bearer token or API key header."
      : res.status === 403
        ? " The server refused the credentials."
        : "";
  return new McpHttpError(res.status, `${what} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}.${hint}`);
}

/**
 * Streamable HTTP. Legacy versions (2025-03-26 … 2025-11-25) keep a session (Mcp-Session-Id, ended
 * with DELETE). 2026-07-28 has no sessions; every POST names its method (Mcp-Method), its tool,
 * resource or task (Mcp-Name), and any parameters the tool mirrors into headers (Mcp-Param-*).
 */
export class StreamableHttpTransport implements McpTransport {
  readonly kind = "streamable-http";
  sessionId?: string;
  private protocolVersion?: string;
  private era: Era = "legacy";
  private closed = false;
  onmessage?: (message: JsonRpcMessage, relatedId?: string | number) => void;
  onclose?: (error?: Error) => void;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private fetchFn: FetchFn,
  ) {}

  async start() {}

  setProtocolVersion(version: string, era: Era = "legacy") {
    this.protocolVersion = version || undefined;
    this.era = era;
    if (era === "modern") this.sessionId = undefined;
  }

  private requestHeaders(message?: JsonRpcMessage, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...this.headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.sessionId && this.era === "legacy") h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    // Modern requests only: an older server's CORS rules may not allow headers it doesn't know.
    if (this.era === "modern" && message) Object.assign(h, standardHeaders(message), extra);
    return h;
  }

  async send(message: JsonRpcMessage, options: SendOptions = {}) {
    if (this.closed) throw new McpClosedError();
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: this.requestHeaders(message, options.headers),
      body: JSON.stringify(message),
      signal: options.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid && this.era === "legacy") this.sessionId = sid;
    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (res.status === 404 && this.sessionId && this.era === "legacy") throw new McpSessionExpiredError();
    if (!res.ok) {
      // A JSON-RPC error inside an HTTP error (modern servers answer 400 with one): surface it.
      const text = await res.clone().text().catch(() => "");
      const messages = parseMessages(text);
      if (messages.length && "error" in messages[0] && messages[0].error && !("method" in messages[0])) {
        const err = messages[0].error;
        throw Object.assign(new McpError(err.code, err.message, err.data), { status: res.status });
      }
      throw await failure(res, "method" in message ? message.method : "Request");
    }
    // Messages on this response belong to this request (a legacy server's question finds its tool call).
    const id = "method" in message && "id" in message ? message.id : undefined;
    let answered = false;
    const deliver = (m: JsonRpcMessage) => {
      if (id !== undefined && isResponse(m) && m.id === id) answered = true;
      this.onmessage?.(m, id ?? undefined);
    };
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && res.body) {
      await readSse(res.body, (event) => {
        if (event.event === "message") for (const m of parseMessages(event.data)) deliver(m);
      });
      if (id !== undefined && !answered && !options.signal?.aborted) throw new McpStreamEndedError();
      return;
    }
    const text = await textUpTo(res, MAX_MESSAGE_CHARS);
    if (!text.trim()) {
      if (id !== undefined) throw new McpStreamEndedError();
      return;
    }
    const messages = parseMessages(text);
    if (!messages.length && id !== undefined) throw new Error(`The server answered with something that isn't JSON-RPC (${type || "no content type"}).`);
    for (const m of messages) deliver(m);
    if (id !== undefined && !answered) {
      // An error the server couldn't tie to our request (id null) is still the answer.
      const orphan = messages.find((m): m is JsonRpcMessage & { error: { code: number; message: string } } => isResponse(m) && m.id === null && Boolean(m.error));
      if (orphan) throw new McpError(orphan.error.code, orphan.error.message);
      throw new McpStreamEndedError();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // Best effort: tell a legacy server it can drop the session.
    if (this.sessionId && this.era === "legacy") {
      void this.fetchFn(this.url, { method: "DELETE", headers: this.requestHeaders(), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    }
    this.onclose?.();
  }
}

/** HTTP+SSE (protocol 2024-11-05): a long GET stream carries replies; requests are POSTed to the "endpoint" it names. */
export class LegacySseTransport implements McpTransport {
  readonly kind = "sse";
  private endpoint?: string;
  private controller = new AbortController();
  private closed = false;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private fetchFn: FetchFn,
  ) {}

  start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => this.controller.abort(), { once: true });
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const fail = (error: Error) => {
        if (!ready) reject(error);
        else this.shutdown(error);
      };
      void (async () => {
        const res = await this.fetchFn(this.url, {
          method: "GET",
          headers: { ...this.headers, accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!res.ok) throw await failure(res, "Opening the event stream");
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
          throw new Error("The server did not answer with an event stream.");
        }
        await readSse(res.body, (event) => {
          if (event.event === "endpoint") {
            try {
              const endpoint = new URL(event.data.trim(), this.url);
              if (endpoint.origin !== new URL(this.url).origin) throw new Error("The server named an endpoint on another site.");
              this.endpoint = endpoint.toString();
              ready = true;
              resolve();
            } catch (error) {
              fail(error as Error);
            }
          } else if (event.event === "message") {
            for (const m of parseMessages(event.data)) this.onmessage?.(m);
          }
        });
        fail(new McpClosedError("The server closed the event stream."));
      })().catch((error: Error) => {
        if (this.closed) return;
        fail(error.name === "AbortError" ? new McpClosedError() : error);
      });
    });
  }

  async send(message: JsonRpcMessage, options: SendOptions = {}) {
    if (this.closed || !this.endpoint) throw new McpClosedError();
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: options.signal,
    });
    if (!res.ok) throw await failure(res, "method" in message ? message.method : "Request");
    await res.body?.cancel().catch(() => undefined);
  }

  private shutdown(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.onclose?.(error);
  }

  async close() {
    this.shutdown();
  }
}

export type HttpServerConfig = { url: string; headers?: Record<string, string>; token?: string };

export function httpHeaders(config: HttpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) if (key.trim()) headers[key.trim().toLowerCase()] = String(value);
  if (config.token?.trim()) headers.authorization = authorizationHeader(config.token);
  return headers;
}

/**
 * Connects to a remote server. Streamable HTTP first, speaking the newest protocol the server
 * supports (a 2026-07-28 server/discover probe, else the legacy initialize handshake). If the
 * handshake's POST gets a 4xx that isn't about credentials (the HTTP+SSE transport has no POST on
 * the base URL), tries the legacy SSE transport on the same URL.
 */
export async function connectHttp(
  config: HttpServerConfig,
  fetchFn: FetchFn,
  timeoutMs = LIST_TIMEOUT_MS,
  signal?: AbortSignal,
  prefer?: Era,
): Promise<McpClient> {
  const headers = httpHeaders(config);
  const client = new McpClient(new StreamableHttpTransport(config.url, headers, fetchFn));
  try {
    await client.connect(timeoutMs, signal, prefer);
    return client;
  } catch (error) {
    await client.close();
    const status = (error as McpHttpError).status;
    const fallback = typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 403 && !(error instanceof McpError);
    if (!fallback) throw error;
    const legacy = new McpClient(new LegacySseTransport(config.url, headers, fetchFn));
    try {
      await legacy.connect(timeoutMs, signal);
      return legacy;
    } catch (legacyError) {
      await legacy.close();
      throw new Error(`${(error as Error).message} (The legacy SSE transport didn't work either: ${(legacyError as Error).message})`);
    }
  }
}

/** A response body as text, refusing one larger than `max` characters (a server can't exhaust memory). */
async function textUpTo(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max * 4) throw new Error("The connector sent a message too large to read.");
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) {
      void reader.cancel().catch(() => undefined);
      throw new Error("The connector sent a message too large to read.");
    }
  }
  return text + decoder.decode();
}
