/**
 * Connectors: the user's MCP servers, their live connections, and the agent tools they provide.
 * Kept free of app state and storage so it can be tested with a real server; src/lib/mcp/store.ts
 * wires it to the app.
 *
 * Adapted from CopilotKit OpenBot, MIT, (c) 2026 CopilotKit (server/src/plugins/mcp.ts:
 * 15 s listing / 60 s call timeouts, bearer-token handling, visible truncation).
 */
import { type AgentTool, registerTool, unregisterTool } from "../agent/tools";
import { McpClient, type ServerInfo } from "./client";
import { connectHttp, type FetchFn } from "./http";
import {
  agentToolName,
  CALL_TIMEOUT_MS,
  convertResult,
  LIST_TIMEOUT_MS,
  type McpCallResult,
  McpSessionExpiredError,
  type McpTool,
  riskFromAnnotations,
  toolParameters,
} from "./protocol";
import { type StdioBridge, StdioTransport } from "./stdio";

export type ConnectorConfig = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  /** Remote servers. */
  url?: string;
  headers?: Record<string, string>;
  token?: string;
  /** Skip the app's relay and call the server straight from the app (needs CORS on the server). */
  direct?: boolean;
  /** Local servers (desktop). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-call time limit in seconds (default 60). */
  timeoutSec?: number;
  /** Tool names (as the server calls them) the user switched off. */
  disabledTools: string[];
  /** Last tool list, so tools are available at start-up before the server is reached. */
  tools?: McpTool[];
};

export type ConnectorStatus = {
  state: "idle" | "connecting" | "connected" | "error";
  error?: string;
  transport?: string;
  server?: ServerInfo;
  protocolVersion?: string;
  instructions?: string;
  at?: number;
};

export type ConnectorDeps = {
  fetchFor: (config: ConnectorConfig) => FetchFn;
  stdioBridge?: StdioBridge;
  onStatus?: (id: string, status: ConnectorStatus) => void;
  onTools?: (id: string, tools: McpTool[]) => void;
};

/** Fields that require a new connection when they change. */
export function connectionKey(c: ConnectorConfig): string {
  return JSON.stringify(
    c.transport === "stdio" ? [c.transport, c.command, c.args, c.env, c.cwd] : [c.transport, c.url, c.headers, c.token, c.direct],
  );
}

export function displayError(error: unknown): string {
  const e = error as Error;
  if (e?.name === "AbortError") return "Stopped.";
  return e?.message || String(error);
}

export class ConnectorManager {
  private live = new Map<string, { key: string; promise: Promise<McpClient> }>();

  constructor(private deps: ConnectorDeps) {}

  private status(id: string, status: ConnectorStatus) {
    this.deps.onStatus?.(id, { ...status, at: Date.now() });
  }

  private async open(config: ConnectorConfig, signal?: AbortSignal): Promise<McpClient> {
    if (config.transport === "stdio") {
      if (!config.command?.trim()) throw new Error("Enter the command that starts the server.");
      const client = new McpClient(
        new StdioTransport(
          { id: config.id, command: config.command.trim(), args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd?.trim() || undefined },
          this.deps.stdioBridge,
        ),
      );
      try {
        await client.connect(LIST_TIMEOUT_MS * 2, signal); // first runs of npx/uvx download packages
      } catch (error) {
        await client.close();
        throw error;
      }
      return client;
    }
    const url = config.url?.trim() ?? "";
    if (!/^https?:\/\//i.test(url)) throw new Error("Enter the server's full http(s) URL.");
    return connectHttp({ url, headers: config.headers, token: config.token }, this.deps.fetchFor(config), LIST_TIMEOUT_MS, signal);
  }

  /** The live client for a server, connecting (or reconnecting after a config change) when needed. */
  async client(config: ConnectorConfig, signal?: AbortSignal): Promise<McpClient> {
    const key = connectionKey(config);
    const existing = this.live.get(config.id);
    if (existing && existing.key === key) {
      const client = await existing.promise.catch(() => null);
      if (client && !client.closed) return client;
      // Another caller already replaced the dead connection while we waited: use theirs.
      if (this.live.has(config.id) && this.live.get(config.id) !== existing) return this.client(config, signal);
    }
    // Claimed synchronously, so concurrent callers share one connection attempt.
    const previous = this.live.get(config.id);
    const promise = (async () => {
      if (previous) await (await previous.promise.catch(() => null))?.close();
      this.status(config.id, { state: "connecting" });
      return this.open(config, signal);
    })();
    this.live.set(config.id, { key, promise });
    try {
      const client = await promise;
      client.onClose = (error) => {
        if (this.live.get(config.id)?.promise !== promise) return;
        this.live.delete(config.id);
        this.status(config.id, error ? { state: "error", error: displayError(error) } : { state: "idle" });
      };
      client.onNotification = (method) => {
        if (method !== "notifications/tools/list_changed" || this.live.get(config.id)?.promise !== promise) return;
        void client
          .listTools()
          .then((tools) => this.deps.onTools?.(config.id, tools))
          .catch(() => undefined);
      };
      this.status(config.id, {
        state: "connected",
        transport: client.transport.kind,
        server: client.serverInfo,
        protocolVersion: client.protocolVersion,
        instructions: client.instructions || undefined,
      });
      return client;
    } catch (error) {
      if (this.live.get(config.id)?.promise === promise) this.live.delete(config.id);
      this.status(config.id, { state: "error", error: displayError(error) });
      throw error;
    }
  }

  /** Runs fn with a client; when the session expired or the connection had closed, reconnects once and retries. */
  private async withClient<T>(config: ConnectorConfig, fn: (client: McpClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const client = await this.client(config, signal);
    try {
      return await fn(client);
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      await this.disconnect(config.id, false);
      return fn(await this.client(config, signal));
    }
  }

  /** Connects (if needed) and lists the server's tools. */
  async listTools(config: ConnectorConfig, signal?: AbortSignal): Promise<McpTool[]> {
    try {
      const tools = await this.withClient(config, (client) => client.listTools(LIST_TIMEOUT_MS, signal), signal);
      this.deps.onTools?.(config.id, tools);
      return tools;
    } catch (error) {
      this.status(config.id, { state: "error", error: displayError(error) });
      throw error;
    }
  }

  async callTool(
    config: ConnectorConfig,
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {},
  ): Promise<McpCallResult> {
    const timeoutMs = (config.timeoutSec ?? CALL_TIMEOUT_MS / 1000) * 1000;
    return this.withClient(
      config,
      (client) => client.callTool(name, args, { timeoutMs, signal: options.signal, onProgress: options.onProgress, what: `${config.name} → ${name}` }),
      options.signal,
    );
  }

  async disconnect(id: string, report = true) {
    const existing = this.live.get(id);
    if (!existing) return;
    this.live.delete(id);
    const client = await existing.promise.catch(() => null);
    await client?.close();
    if (report) this.status(id, { state: "idle" });
  }

  async disconnectAll() {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id, false)));
  }

  isLive(id: string) {
    return this.live.has(id);
  }
}

// Agent tools -------------------------------------------------------------------------------

export const CONNECTORS_GROUP = "connectors";

/** The agent tools a set of connectors provides right now. */
export function buildAgentTools(configs: ConnectorConfig[], manager: ConnectorManager, latest: (id: string) => ConnectorConfig | undefined): AgentTool[] {
  const out: AgentTool[] = [];
  const used = new Set<string>();
  for (const config of configs) {
    if (!config.enabled) continue;
    for (const tool of config.tools ?? []) {
      if (config.disabledTools.includes(tool.name)) continue;
      let name = agentToolName(config.name, tool.name);
      // Two servers with the same name: keep both by adding the server id's hash.
      if (used.has(name)) name = agentToolName(`${config.name}_${config.id.slice(0, 6)}`, tool.name);
      if (used.has(name)) continue;
      used.add(name);
      const description = `[${config.name} connector] ${tool.title ?? tool.annotations?.title ?? ""}${tool.title || tool.annotations?.title ? ": " : ""}${tool.description ?? ""}`
        .trim()
        .slice(0, 1200);
      out.push({
        name,
        description,
        parameters: toolParameters(tool.inputSchema) as AgentTool["parameters"],
        group: CONNECTORS_GROUP,
        risk: riskFromAnnotations(tool.annotations),
        kind: "mcp",
        platforms: config.transport === "stdio" ? ["desktop"] : undefined,
        timeoutMs: (config.timeoutSec ?? CALL_TIMEOUT_MS / 1000) * 1000 + LIST_TIMEOUT_MS * 2,
        available: () => {
          const now = latest(config.id);
          return Boolean(now?.enabled && !now.disabledTools.includes(tool.name));
        },
        async run(args, ctx) {
          const now = latest(config.id) ?? config;
          if (!now.enabled) throw new Error(`The ${now.name} connector is switched off.`);
          ctx.progress(`Asking ${now.name}…`);
          const result = await manager.callTool(now, tool.name, args, { signal: ctx.signal, onProgress: ctx.progress });
          const { text, display } = convertResult(result);
          const source = `the "${now.name}" connector (MCP tool ${tool.name})`;
          if (result.isError) return { content: `The tool reported an error:\n${text}`, untrustedSource: source };
          return { content: text, display, untrustedSource: source };
        },
      });
    }
  }
  return out;
}

const registered = new Set<string>();
const signatures = new Map<string, string>();

/** Registers the tools connectors provide and removes the ones that went away. Returns the names. */
export function syncAgentTools(tools: AgentTool[]): string[] {
  const wanted = new Map(tools.map((t) => [t.name, t]));
  for (const name of [...registered]) {
    if (!wanted.has(name)) {
      unregisterTool(name);
      registered.delete(name);
      signatures.delete(name);
    }
  }
  for (const tool of tools) {
    const signature = JSON.stringify([tool.description, tool.parameters, tool.risk, tool.platforms, tool.timeoutMs]);
    if (registered.has(tool.name) && signatures.get(tool.name) === signature) continue;
    registerTool(tool);
    registered.add(tool.name);
    signatures.set(tool.name, signature);
  }
  return [...registered];
}

