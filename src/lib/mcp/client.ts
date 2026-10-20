/**
 * A small MCP client: JSON-RPC 2.0 over any transport (Streamable HTTP, legacy HTTP+SSE, or a local
 * process on desktop).
 *
 * It speaks the newest protocol a server supports. 2026-07-28 ("modern") servers are stateless:
 * there's no handshake, every request carries its version, client info and capabilities in _meta,
 * and server/discover says what the server supports. Older ("legacy") servers open with the
 * initialize handshake. connect() probes with server/discover and falls back to initialize on
 * anything that isn't a modern answer, as the spec describes for dual-era clients.
 *
 * Also handles tools/list pagination and freshness (ttlMs), progress, cancellation, timeouts,
 * questions from the server (elicitation: input_required results, or elicitation/create requests
 * from older servers) and long-running calls (the tasks extension).
 */
import { type ElicitAnswer, type InputRequest } from "./elicitation";
import {
  CALL_TIMEOUT_MS,
  isModernError,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  HEADER_MISMATCH,
  LATEST_LEGACY_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  LIST_TIMEOUT_MS,
  type McpCallResult,
  McpClosedError,
  McpError,
  type McpHeaderParam,
  mcpHeaderParams,
  McpTimeoutError,
  type McpTool,
  META,
  MODERN_PROTOCOL_VERSIONS,
  paramHeaders,
  resultTypeOf,
  supportedFrom,
  TASKS_EXTENSION,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./protocol";
import { Budget, followTask, isTask } from "./tasks";

export type Era = "modern" | "legacy";
export type SendOptions = { signal?: AbortSignal; headers?: Record<string, string> };

export interface McpTransport {
  /** Open the connection (legacy SSE waits for its endpoint, a process starts). */
  start(signal?: AbortSignal): Promise<void>;
  /** Deliver one message. Replies arrive through onmessage. Rejects when delivery failed. */
  send(message: JsonRpcMessage, options?: SendOptions): Promise<void>;
  close(): Promise<void>;
  /** Streamable HTTP sends the version as a header, and drops sessions for modern versions. */
  setProtocolVersion?(version: string, era: Era): void;
  /** relatedId: the request whose HTTP response carried this message, when known. */
  onmessage?: (message: JsonRpcMessage, relatedId?: JsonRpcId) => void;
  onclose?: (error?: Error) => void;
  /** "streamable-http", "sse" or "stdio": shown in the UI. */
  readonly kind: string;
}

export type ServerInfo = { name?: string; version?: string; title?: string };

/** Answers a server's question (an elicitation request) with the user's answer. */
export type Asker = (request: InputRequest) => Promise<ElicitAnswer>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (text: string) => void;
  pause: () => void;
  resume: () => void;
};

export type RequestOptions = {
  /** 0 = no time limit (a subscription stream). */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  what?: string;
  /** Extra HTTP headers (Mcp-Param-*). */
  headers?: Record<string, string>;
  /** Client capabilities for this request (modern versions). */
  capabilities?: Record<string, unknown>;
  /** Questions from an older server while this request runs go here. */
  asker?: Asker;
  onId?: (id: JsonRpcId) => void;
  /** Set on the one re-send after a response stream broke. */
  retried?: boolean;
};

export type CallOptions = Omit<RequestOptions, "headers" | "capabilities" | "asker"> & {
  /** Shows the server's questions to the user; without it, the server is told we can't ask. */
  ask?: Asker;
  /** The tool's input schema, for its Mcp-Param-* headers. */
  inputSchema?: Record<string, unknown>;
};

/** The probe made a server process exit: start a new one and use the legacy handshake. */
export class McpProbeClosedError extends Error {
  constructor() {
    super("The server stopped when asked which protocol versions it speaks.");
    this.name = "McpProbeClosedError";
  }
}

/** The HTTP response stream ended before the answer (2026-07-28: the request is lost; send it again). */
export class McpStreamEndedError extends McpClosedError {
  constructor() {
    super("The server closed the response before answering.");
    this.name = "McpStreamEndedError";
  }
}

/** On stdio, wait this long for a server/discover answer before also trying the legacy handshake. */
export const PROBE_WAIT_MS = 3_000;
const MAX_INPUT_ROUNDS = 8;

export class McpClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private progressTokens = new Map<string | number, JsonRpcId>();
  /** Questions from legacy servers find their tool call here (by request id). */
  private askers = new Map<JsonRpcId, Asker>();
  private headerParams = new Map<string, McpHeaderParam[]>();
  private lifetime = new AbortController();
  private listenId?: JsonRpcId;
  closed = false;
  closeError?: Error;
  era: Era = "legacy";
  protocolVersion = "";
  serverInfo: ServerInfo = {};
  instructions = "";
  capabilities: Record<string, unknown> = {};
  /** The last tools/list: when it arrived, how long it stays fresh (ttlMs, if the server said) and tools left out. */
  lastList?: { at: number; ttlMs?: number; rejected: { name: string; reason: string }[] };
  /** Called for server notifications (e.g. notifications/tools/list_changed). */
  onNotification?: (method: string, params: Record<string, unknown> | undefined) => void;
  onClose?: (error?: Error) => void;
  probeWaitMs = PROBE_WAIT_MS;

  constructor(
    readonly transport: McpTransport,
    private clientInfo = { name: "ADT Bot", version: "1.0.0" },
  ) {
    transport.onmessage = (message, relatedId) => this.receive(message, relatedId);
    transport.onclose = (error) => this.handleClose(error);
  }

  /**
   * Starts the transport and settles on a protocol version: server/discover first (modern), the
   * initialize handshake when the answer isn't a modern one. `prefer: "legacy"` skips the probe
   * (the server answered as a legacy server before).
   */
  async connect(timeoutMs = LIST_TIMEOUT_MS, signal?: AbortSignal, prefer?: Era): Promise<void> {
    await withTimeout(this.transport.start(signal), timeoutMs, "Connecting");
    if (prefer === "legacy" || this.transport.kind === "sse") return this.initialize(timeoutMs, signal);
    const probe = await this.probe(timeoutMs, signal);
    if (probe.modern) return;
    if (this.closed) throw new McpProbeClosedError();
    try {
      await this.initialize(timeoutMs, signal);
    } catch (error) {
      // A slow modern server may still answer the probe: then it was modern after all.
      const late = await probe.late;
      if (late && !this.closed) return this.useDiscover(late.result, late.version);
      throw error;
    }
  }

  /** server/discover. Modern answer → use it; anything else (bar sign-in and modern errors) → legacy. */
  private async probe(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ modern: true } | { modern: false; late?: Promise<{ result: DiscoverResult; version: string } | null> }> {
    const stdio = this.transport.kind === "stdio";
    const legacy = () => {
      this.setVersion("", "legacy");
      return { modern: false as const };
    };
    // Newest first; an UnsupportedProtocolVersion answer moves on to the next version we share.
    for (const version of MODERN_PROTOCOL_VERSIONS) {
      this.setVersion(version, "modern");
      const attempt = this.request("server/discover", {}, { timeoutMs, signal, what: "Connecting" });
      let result: unknown;
      try {
        if (stdio) {
          // Some older stdio servers never answer an unknown request: don't wait for the full timeout.
          const slow = Symbol("slow");
          attempt.catch(() => undefined);
          result = await Promise.race([attempt, delay(this.probeWaitMs, signal).then(() => slow)]);
          if (result === slow) {
            const late = attempt.then(
              (r) => (isDiscover(r) && pickModern(r.supportedVersions) ? { result: r, version: pickModern(r.supportedVersions)! } : null),
              () => null,
            );
            return { ...legacy(), late };
          }
        } else {
          result = await attempt;
        }
      } catch (error) {
        const e = error as Error & { status?: number };
        if (e.name === "AbortError") throw error;
        if (error instanceof McpError && error.code === UNSUPPORTED_PROTOCOL_VERSION) {
          const supported = supportedFrom(error);
          if (supported.some((v) => MODERN_PROTOCOL_VERSIONS.includes(v) && v !== version)) continue;
          if (supported.some((v) => LEGACY_PROTOCOL_VERSIONS.includes(v))) return legacy();
          throw unsupported(supported);
        }
        // A modern server that refused the request itself, or a sign-in problem: report it.
        if (isModernError(error) || e.status === 401 || e.status === 403) throw error;
        if (error instanceof McpTimeoutError && !stdio) throw error;
        return legacy(); // anything else (an error, an HTTP 4xx, a closed process): an older server
      }
      if (!isDiscover(result)) return legacy();
      const modern = pickModern(result.supportedVersions);
      if (modern) {
        this.useDiscover(result, modern);
        return { modern: true };
      }
      if (result.supportedVersions.some((v) => LEGACY_PROTOCOL_VERSIONS.includes(v))) return legacy();
      throw unsupported(result.supportedVersions);
    }
    return legacy();
  }

  private setVersion(version: string, era: Era) {
    this.era = era;
    this.protocolVersion = version;
    this.transport.setProtocolVersion?.(version, era);
  }

  private useDiscover(result: DiscoverResult, version: string) {
    this.setVersion(version, "modern");
    const meta = (result._meta ?? {}) as Record<string, unknown>;
    this.serverInfo = ((meta[META.serverInfo] ?? result.serverInfo ?? {}) as ServerInfo) || {};
    this.capabilities = result.capabilities && typeof result.capabilities === "object" ? result.capabilities : {};
    this.instructions = typeof result.instructions === "string" ? result.instructions : "";
  }

  /** Legacy handshake: initialize → check version → notifications/initialized. */
  private async initialize(timeoutMs: number, signal?: AbortSignal) {
    this.setVersion("", "legacy");
    const result = (await this.request(
      "initialize",
      // Questions (elicitation) are answered in the chat, as forms. Sampling and roots aren't offered.
      { protocolVersion: LATEST_LEGACY_VERSION, capabilities: { elicitation: { form: {} } }, clientInfo: this.clientInfo },
      { timeoutMs, signal, what: "The handshake" },
    )) as { protocolVersion?: string; serverInfo?: ServerInfo; capabilities?: Record<string, unknown>; instructions?: string };
    const version = String(result?.protocolVersion ?? "");
    if (!LEGACY_PROTOCOL_VERSIONS.includes(version)) {
      await this.close();
      throw unsupported(version ? [version] : []);
    }
    this.setVersion(version, "legacy");
    this.serverInfo = result.serverInfo ?? {};
    this.capabilities = result.capabilities ?? {};
    this.instructions = typeof result.instructions === "string" ? result.instructions : "";
    await this.notify("notifications/initialized");
  }

  /**
   * All tools, following nextCursor (at most 50 pages). Remembers how long the list stays fresh
   * (the smallest ttlMs of its pages). On Streamable HTTP with a modern server, tools whose
   * x-mcp-header annotations are invalid are left out, as the spec requires.
   */
  async listTools(timeoutMs = LIST_TIMEOUT_MS, signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const rejected: { name: string; reason: string }[] = [];
    let ttlMs: number | undefined;
    let cursor: string | undefined;
    const at = Date.now();
    const checkHeaders = this.era === "modern" && this.transport.kind === "streamable-http";
    const headerParams = new Map<string, McpHeaderParam[]>();
    for (let page = 0; page < 50; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, { timeoutMs, signal, what: "Listing tools" })) as {
        tools?: McpTool[];
        nextCursor?: string;
        ttlMs?: unknown;
      };
      if (resultTypeOf(result) !== "complete") throw new Error(`The server answered tools/list with a ${resultTypeOf(result)} result.`);
      if (typeof result?.ttlMs === "number") ttlMs = Math.min(ttlMs ?? Infinity, Math.max(0, result.ttlMs));
      for (const tool of result?.tools ?? []) {
        if (!tool || typeof tool.name !== "string") continue;
        if (checkHeaders) {
          const check = mcpHeaderParams(tool.inputSchema);
          if ("error" in check) {
            rejected.push({ name: tool.name, reason: check.error });
            console.warn(`MCP: left out the tool "${tool.name}": ${check.error}`);
            continue;
          }
          if (check.params.length) headerParams.set(tool.name, check.params);
        }
        tools.push(tool);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    this.headerParams = headerParams;
    this.lastList = { at, ttlMs, rejected };
    return tools;
  }

  /**
   * Calls a tool and returns its final result. With a modern server that means following
   * input_required results (the user answers, the call is retried with the answers) and tasks
   * (polled until done). The time limit counts the server's time, not the user's.
   */
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<McpCallResult> {
    const { ask, inputSchema, ...rest } = options;
    const what = rest.what ?? `The tool ${name}`;
    const budget = new Budget(rest.timeoutMs ?? CALL_TIMEOUT_MS);
    let extra: { inputResponses?: Record<string, unknown>; requestState?: string } = {};
    let refreshedSchema = false;
    for (let round = 0; ; round++) {
      if (budget.left() <= 0) throw new McpTimeoutError(what, budget.totalMs);
      let result: unknown;
      try {
        result = await this.request(
          "tools/call",
          { name, arguments: args, ...extra },
          { ...rest, what, timeoutMs: budget.left(), headers: this.callHeaders(name, args, inputSchema), capabilities: this.clientCapabilities(Boolean(ask)), asker: ask },
        );
      } catch (error) {
        // The server wants Mcp-Param headers we didn't send: re-read the tool's schema once and retry.
        if (error instanceof McpError && error.code === HEADER_MISMATCH && this.era === "modern" && !refreshedSchema) {
          refreshedSchema = true;
          await this.listTools(LIST_TIMEOUT_MS, rest.signal).catch(() => undefined);
          round--;
          continue;
        }
        throw error;
      }
      const type = resultTypeOf(result);
      if (type === "complete") return result as McpCallResult;
      if (this.era !== "modern") throw new Error(`The server sent a result of an unknown type (${type.slice(0, 40)}).`);
      if (type === "task") {
        if (!isTask(result)) throw new Error("The server sent a task without a task id.");
        const final = await followTask(
          {
            get: (taskId, timeoutMs) => this.request("tasks/get", { taskId }, { timeoutMs, signal: rest.signal, what }),
            update: (taskId, inputResponses, timeoutMs) => this.request("tasks/update", { taskId, inputResponses }, { timeoutMs, signal: rest.signal, what }),
            cancel: (taskId) => this.request("tasks/cancel", { taskId }, { timeoutMs: 10_000, what }),
            answer: (requests) => this.answerAll(requests, ask),
            progress: rest.onProgress,
          },
          result,
          { budget, signal: rest.signal, what },
        );
        if (resultTypeOf(final) !== "complete") throw new Error("The server finished the task with an unfinished result.");
        return final as McpCallResult;
      }
      if (type !== "input_required") throw new Error(`The server sent a result of an unknown type (${type.slice(0, 40)}).`);
      if (round >= MAX_INPUT_ROUNDS) throw new Error("The server kept asking for more input; stopped after several rounds.");
      const r = result as { inputRequests?: Record<string, InputRequest>; requestState?: unknown };
      const requests = r.inputRequests && typeof r.inputRequests === "object" ? r.inputRequests : undefined;
      if (!requests && typeof r.requestState !== "string") throw new Error("The server asked for input without saying what.");
      // Only the user answers; the answers go back with the same call (new id), plus the server's state.
      const inputResponses = requests && Object.keys(requests).length ? await budget.paused(() => this.answerAll(requests, ask)) : undefined;
      if (!inputResponses) await delay(Math.min(250 * (round + 1), 2_000), rest.signal);
      extra = { ...(inputResponses ? { inputResponses } : {}), ...(typeof r.requestState === "string" ? { requestState: r.requestState } : {}) };
    }
  }

  /** Asks the user each question in turn. Throws when nobody can answer (voice mode, list refresh). */
  private async answerAll(requests: Record<string, InputRequest>, ask: Asker | undefined): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [key, request] of Object.entries(requests)) {
      if (!ask) throw new Error("The connector asked a question that needs your answer, and it can't be shown here. Run it from a chat.");
      if (!request || typeof request !== "object" || request.method !== "elicitation/create") {
        throw new Error(`The server asked for something ADT Bot doesn't support (${String(request?.method ?? "unknown").slice(0, 60)}).`);
      }
      out[key] = await ask(request);
    }
    return out;
  }

  private clientCapabilities(canAsk: boolean): Record<string, unknown> {
    return { ...(canAsk ? { elicitation: { form: {}, url: {} } } : {}), extensions: { [TASKS_EXTENSION]: {} } };
  }

  private callHeaders(name: string, args: Record<string, unknown>, inputSchema?: Record<string, unknown>): Record<string, string> | undefined {
    if (this.era !== "modern" || this.transport.kind !== "streamable-http") return undefined;
    let params = this.headerParams.get(name);
    if (!params && inputSchema) {
      const check = mcpHeaderParams(inputSchema);
      params = "params" in check ? check.params : [];
    }
    return params?.length ? paramHeaders(params, args) : undefined;
  }

  /**
   * Modern stdio servers send list changes only to a subscription: opens one (no time limit;
   * it ends when the connection closes). Does nothing for other servers.
   */
  listen() {
    if (this.era !== "modern" || this.transport.kind !== "stdio" || this.listenId !== undefined) return;
    const tools = (this.capabilities.tools ?? {}) as { listChanged?: unknown };
    if (tools.listChanged !== true) return;
    void this.request(
      "subscriptions/listen",
      { notifications: { toolsListChanged: true } },
      { timeoutMs: 0, signal: this.lifetime.signal, what: "Listening for changes", onId: (id) => (this.listenId = id) },
    )
      .catch(() => undefined)
      .finally(() => (this.listenId = undefined));
  }

  /** Legacy servers only (2026-07-28 removed ping). */
  ping(timeoutMs = 10_000) {
    return this.request("ping", {}, { timeoutMs, what: "Ping" });
  }

  request(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new McpClosedError());
    const id = this.nextId++;
    options.onId?.(id);
    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    const controller = new AbortController();
    const body: Record<string, unknown> = { ...params };
    const meta: Record<string, unknown> = { ...((params._meta as Record<string, unknown>) ?? {}) };
    if (options.onProgress) {
      meta.progressToken = id;
      this.progressTokens.set(id, id);
    }
    if (this.era === "modern" && this.protocolVersion) {
      meta[META.protocolVersion] = this.protocolVersion;
      meta[META.clientInfo] = this.clientInfo;
      meta[META.clientCapabilities] = options.capabilities ?? this.clientCapabilities(false);
    }
    if (Object.keys(meta).length) body._meta = meta;
    if (options.asker) this.askers.set(id, options.asker);
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let remaining = timeoutMs;
      let armedAt = 0;
      let paused = 0;
      const arm = () => {
        if (timeoutMs <= 0) return;
        armedAt = Date.now();
        timer = setTimeout(onTimeout, Math.max(remaining, 0));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.progressTokens.delete(id);
        this.askers.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (reason: string) => {
        controller.abort();
        // On Streamable HTTP a modern server takes the closed response as the cancellation.
        if (method !== "initialize") void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => undefined);
      };
      const onAbort = () => {
        cleanup();
        cancel("Stopped by the user");
        reject(new DOMException("Stopped", "AbortError"));
      };
      const onTimeout = () => {
        cleanup();
        cancel("Timed out");
        reject(new McpTimeoutError(options.what ?? method, timeoutMs));
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      arm();
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
        // While the user answers a legacy server's question, the request's clock stops.
        pause: () => {
          if (paused++ || !timer) return;
          clearTimeout(timer);
          timer = undefined;
          remaining -= Date.now() - armedAt;
        },
        resume: () => {
          if (--paused > 0 || !this.pending.has(id)) return;
          paused = 0;
          arm();
        },
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params: body }, { signal: controller.signal, headers: options.headers }).catch((error: Error) => {
        if (controller.signal.aborted) return;
        // 2026-07-28: a broken response stream loses the request; send it again (new id), once.
        if (error instanceof McpStreamEndedError && this.era === "modern" && method !== "subscriptions/listen" && !options.retried) {
          if (!this.pending.has(id)) return;
          cleanup();
          resolve(this.request(method, params, { ...options, retried: true }));
          return;
        }
        this.pending.get(id)?.reject(error);
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    // 2026-07-28 defines no client notifications over HTTP (closing a response cancels it).
    if (this.era === "modern" && this.transport.kind === "streamable-http") return Promise.resolve();
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
    this.lifetime.abort();
    this.closeError = error instanceof McpClosedError ? error : new McpClosedError(error?.message);
    for (const pending of [...this.pending.values()]) pending.reject(this.closeError);
    this.pending.clear();
    this.onClose?.(error);
  }

  private receive(message: JsonRpcMessage, relatedId?: JsonRpcId) {
    if (isResponse(message)) {
      const pending = message.id === null ? undefined : this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new McpError(message.error.code, message.error.message || `Error ${message.error.code}`, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (isRequest(message)) {
      void this.answerRequest(message.id, message.method, message.params, relatedId);
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
      // Subscription notifications name their subscription: ignore ones that aren't ours.
      const subscription = (message.params?._meta as Record<string, unknown> | undefined)?.[META.subscriptionId];
      if (subscription !== undefined && subscription !== this.listenId) return;
      if (message.method === "notifications/subscriptions/acknowledged") return;
      this.onNotification?.(message.method, message.params);
    }
  }

  /** Requests from (legacy) servers: ping, and questions for the user (elicitation/create). */
  private async answerRequest(id: JsonRpcId, method: string, params: Record<string, unknown> | undefined, relatedId?: JsonRpcId) {
    const reply = (body: { result: unknown } | { error: { code: number; message: string } }) =>
      void this.transport.send({ jsonrpc: "2.0", id, ...body } as JsonRpcMessage).catch(() => undefined);
    if (method === "ping") return reply({ result: {} });
    if (method !== "elicitation/create") return reply({ error: { code: -32601, message: `Method not supported by ADT Bot: ${method}` } });
    // The tool call it belongs to: the request whose HTTP stream carried it, else the latest one.
    const asker = (relatedId !== undefined ? this.askers.get(relatedId) : undefined) ?? [...this.askers.values()].at(-1);
    if (!asker) return reply({ error: { code: -32603, message: "ADT Bot can only ask the user during a tool call started from a chat." } });
    const waiting = [...this.pending.values()];
    waiting.forEach((p) => p.pause());
    try {
      reply({ result: await asker({ method, params }) });
    } catch (error) {
      reply({ error: { code: -32603, message: (error as Error).message || "The question couldn't be shown." } });
    } finally {
      waiting.forEach((p) => p.resume());
    }
  }
}

type DiscoverResult = {
  supportedVersions: string[];
  capabilities?: Record<string, unknown>;
  instructions?: unknown;
  serverInfo?: ServerInfo;
  _meta?: unknown;
};

const isDiscover = (value: unknown): value is DiscoverResult =>
  Boolean(value) && Array.isArray((value as DiscoverResult).supportedVersions) && (value as DiscoverResult).supportedVersions.every((v) => typeof v === "string");

const pickModern = (supported: string[]) => MODERN_PROTOCOL_VERSIONS.find((v) => supported.includes(v));

function unsupported(versions: string[]): Error {
  return new Error(
    `The server speaks MCP version ${versions.length ? versions.map((v) => `"${v}"`).join(", ") : '"unknown"'}, which ADT Bot doesn't support (${[...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS].join(", ")}).`,
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
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
