/**
 * A small MCP client: JSON-RPC 2.0 over any transport (Streamable HTTP, legacy HTTP+SSE, or a local
 * process on desktop). Handles the initialize/initialized handshake, protocol version negotiation,
 * tools/list pagination, ping, progress, cancellation and timeouts.
 */
import {
  CALL_TIMEOUT_MS,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  LATEST_PROTOCOL_VERSION,
  LIST_TIMEOUT_MS,
  type McpCallResult,
  McpClosedError,
  McpError,
  McpTimeoutError,
  type McpTool,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol";

export interface McpTransport {
  /** Open the connection (legacy SSE waits for its endpoint, a process starts). */
  start(signal?: AbortSignal): Promise<void>;
  /** Deliver one message. Replies arrive through onmessage. Rejects when delivery failed. */
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Streamable HTTP sends the negotiated version as a header on every later request. */
  setProtocolVersion?(version: string): void;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  /** "streamable-http", "sse" or "stdio": shown in the UI. */
  readonly kind: string;
}

export type ServerInfo = { name?: string; version?: string; title?: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (text: string) => void };

export type RequestOptions = { timeoutMs?: number; signal?: AbortSignal; onProgress?: (text: string) => void; what?: string };

export class McpClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private progressTokens = new Map<string | number, JsonRpcId>();
  closed = false;
  closeError?: Error;
  protocolVersion = "";
  serverInfo: ServerInfo = {};
  instructions = "";
  capabilities: Record<string, unknown> = {};
  /** Called for server notifications (e.g. notifications/tools/list_changed). */
  onNotification?: (method: string, params: Record<string, unknown> | undefined) => void;
  onClose?: (error?: Error) => void;

  constructor(
    readonly transport: McpTransport,
    private clientInfo = { name: "ADT Bot", version: "1.0.0" },
  ) {
    transport.onmessage = (message) => this.receive(message);
    transport.onclose = (error) => this.handleClose(error);
  }

  /** Handshake: initialize → check version → notifications/initialized. */
  async connect(timeoutMs = LIST_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    await withTimeout(this.transport.start(signal), timeoutMs, "Connecting");
    const result = (await this.request(
      "initialize",
      { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
      { timeoutMs, signal, what: "The handshake" },
    )) as { protocolVersion?: string; serverInfo?: ServerInfo; capabilities?: Record<string, unknown>; instructions?: string };
    const version = String(result?.protocolVersion ?? "");
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      await this.close();
      throw new Error(`The server speaks MCP version "${version || "unknown"}", which ADT Bot doesn't support (${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}).`);
    }
    this.protocolVersion = version;
    this.serverInfo = result.serverInfo ?? {};
    this.capabilities = result.capabilities ?? {};
    this.instructions = typeof result.instructions === "string" ? result.instructions : "";
    this.transport.setProtocolVersion?.(version);
    await this.notify("notifications/initialized");
  }

  /** All tools, following nextCursor (at most 50 pages). */
  async listTools(timeoutMs = LIST_TIMEOUT_MS, signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, { timeoutMs, signal, what: "Listing tools" })) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === "string") tools.push(tool);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options: RequestOptions = {}): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args }, { timeoutMs: CALL_TIMEOUT_MS, what: `The tool ${name}`, ...options })) as McpCallResult;
  }

  ping(timeoutMs = 10_000) {
    return this.request("ping", {}, { timeoutMs, what: "Ping" });
  }

  request(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new McpClosedError());
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    const controller = new AbortController();
    const body: Record<string, unknown> = { ...params };
    if (options.onProgress) {
      body._meta = { progressToken: id };
      this.progressTokens.set(id, id);
    }
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.progressTokens.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (reason: string) => {
        controller.abort();
        if (method !== "initialize") void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => undefined);
      };
      const onAbort = () => {
        cleanup();
        cancel("Stopped by the user");
        reject(new DOMException("Stopped", "AbortError"));
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        cancel("Timed out");
        reject(new McpTimeoutError(options.what ?? method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        onProgress: options.onProgress,
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params: body }, controller.signal).catch((error: Error) => {
        if (controller.signal.aborted) return;
        this.pending.get(id)?.reject(error);
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.transport.send(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.handleClose();
    await this.transport.close().catch(() => undefined);
  }

  private handleClose(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error instanceof McpClosedError ? error : new McpClosedError(error?.message);
    for (const pending of [...this.pending.values()]) pending.reject(this.closeError);
    this.pending.clear();
    this.onClose?.(error);
  }

  private receive(message: JsonRpcMessage) {
    if (isResponse(message)) {
      const pending = message.id === null ? undefined : this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new McpError(message.error.code, message.error.message || `Error ${message.error.code}`, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (isRequest(message)) {
      // We declare no client capabilities (sampling, roots, elicitation), so only ping is answered.
      const reply =
        message.method === "ping"
          ? { jsonrpc: "2.0" as const, id: message.id, result: {} }
          : { jsonrpc: "2.0" as const, id: message.id, error: { code: -32601, message: `Method not supported by ADT Bot: ${message.method}` } };
      void this.transport.send(reply).catch(() => undefined);
      return;
    }
    if (isNotification(message)) {
      if (message.method === "notifications/progress") {
        const token = message.params?.progressToken as string | number | undefined;
        const id = token === undefined ? undefined : this.progressTokens.get(token);
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (pending?.onProgress) {
          const p = message.params ?? {};
          const amount = typeof p.total === "number" && p.total > 0 ? ` (${Math.round((Number(p.progress) / p.total) * 100)}%)` : "";
          pending.onProgress(`${typeof p.message === "string" ? p.message : "Working…"}${amount}`);
        }
        return;
      }
      this.onNotification?.(message.method, message.params);
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpTimeoutError(what, ms)), ms);
    }),
  ]);
}
