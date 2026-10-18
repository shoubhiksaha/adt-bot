/**
 * Remote MCP transports: Streamable HTTP (current spec) and the legacy HTTP+SSE transport
 * (2024-11-05), with the spec's backwards-compatible fallback from the first to the second.
 * The fetch function is injected: the app routes it through its CORS relay; tests use plain fetch.
 *
 * Adapted from CopilotKit OpenBot, MIT, (c) 2026 CopilotKit — authorizationHeader (server/src/plugins/mcp.ts).
 */
import { McpClient, type McpTransport } from "./client";
import {
  type JsonRpcMessage,
  LIST_TIMEOUT_MS,
  McpClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  parseMessages,
  readSse,
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

export class StreamableHttpTransport implements McpTransport {
  readonly kind = "streamable-http";
  sessionId?: string;
  private protocolVersion?: string;
  private closed = false;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private fetchFn: FetchFn,
  ) {}

  async start() {}

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  private requestHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    return h;
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal) {
    if (this.closed) throw new McpClosedError();
    const res = await this.fetchFn(this.url, { method: "POST", headers: this.requestHeaders(), body: JSON.stringify(message), signal });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (res.status === 404 && this.sessionId) throw new McpSessionExpiredError();
    if (!res.ok) {
      // A JSON-RPC error inside an HTTP error (some servers answer 400 with one): surface it.
      const text = await res.clone().text().catch(() => "");
      const messages = parseMessages(text);
      if (messages.length && "error" in messages[0] && messages[0].error && !("method" in messages[0])) {
        const err = messages[0].error;
        throw Object.assign(new McpError(err.code, err.message), { status: res.status });
      }
      throw await failure(res, "method" in message ? message.method : "Request");
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && res.body) {
      await readSse(res.body, (event) => {
        if (event.event === "message") for (const m of parseMessages(event.data)) this.onmessage?.(m);
      });
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    const messages = parseMessages(text);
    if (!messages.length && "id" in message) throw new Error(`The server answered with something that isn't JSON-RPC (${type || "no content type"}).`);
    for (const m of messages) this.onmessage?.(m);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // Best effort: tell the server it can drop the session.
    if (this.sessionId) {
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

  async send(message: JsonRpcMessage, signal?: AbortSignal) {
    if (this.closed || !this.endpoint) throw new McpClosedError();
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(message),
      signal,
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
 * Connects to a remote server: Streamable HTTP first; if the server answers the POST with a
 * 4xx that isn't about credentials (the legacy transport has no POST on the base URL), tries the
 * legacy SSE transport on the same URL.
 */
export async function connectHttp(config: HttpServerConfig, fetchFn: FetchFn, timeoutMs = LIST_TIMEOUT_MS, signal?: AbortSignal): Promise<McpClient> {
  const headers = httpHeaders(config);
  const client = new McpClient(new StreamableHttpTransport(config.url, headers, fetchFn));
  try {
    await client.connect(timeoutMs, signal);
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
