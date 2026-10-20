/**
 * Connectors: the user's MCP servers, their live connections, and the agent tools they provide.
 * Kept free of app state and storage so it can be tested with a real server; src/lib/mcp/store.ts
 * wires it to the app.
 *
 * Adapted from CopilotKit OpenBot, MIT, (c) 2026 CopilotKit (server/src/plugins/mcp.ts:
 * 15 s listing / 60 s call timeouts, bearer-token handling, visible truncation).
 */
import { type AgentTool, registerTool, unregisterTool } from "../agent/tools";
import { type Asker, type Era, McpClient, McpProbeClosedError, type ServerInfo } from "./client";
import { askUser, QUESTION_TIMEOUT_MS, questionFromRequest } from "./elicitation";
import { connectHttp, type FetchFn } from "./http";
import {
  agentToolName,
  CALL_TIMEOUT_MS,
  convertResult,
  LIST_TIMEOUT_MS,
  type McpCallResult,
  McpError,
  McpSessionExpiredError,
  type McpTool,
  MISSING_CLIENT_CAPABILITY,
  riskFromAnnotations,
  shortHash,
  toolParameters,
} from "./protocol";
import { cleanTool, launchKey, toolDefinition, toolsToReview, toolsWithHidden } from "./security";
import { type StdioBridge, StdioTransport } from "./stdio";
import { stripHidden } from "./unicode";

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
  /** Tools (server names) the user marked read-only; servers' own read-only claims aren't trusted. */
  readOnlyTools?: string[];
  /** The server acts on this computer (screen, apps, files): Computer access applies to its tools. */
  controlsComputer?: boolean;
  /** Last tool list, so tools are available at start-up before the server is reached. */
  tools?: McpTool[];
  /**
   * Tool definitions as the user approved them (security.ts). Tools that differ (changed after
   * approval, or new) stay off until the user reviews them. Unset until the first listing.
   */
  approvedTools?: Record<string, string>;
  /** launchKey() of the local command the user confirmed. A local server never starts without it. */
  approvedLaunch?: string;
  /** How the server answered last time (legacy servers then skip the server/discover probe). */
  protocolEra?: { key: string; era: Era };
};

export type ConnectorStatus = {
  state: "idle" | "connecting" | "connected" | "error";
  error?: string;
  transport?: string;
  server?: ServerInfo;
  protocolVersion?: string;
  era?: Era;
  instructions?: string;
  /** Tools the client had to leave out (e.g. invalid x-mcp-header annotations). */
  skippedTools?: { name: string; reason: string }[];
  at?: number;
};

export type ConnectorDeps = {
  fetchFor: (config: ConnectorConfig) => FetchFn;
  stdioBridge?: StdioBridge;
  onStatus?: (id: string, status: ConnectorStatus) => void;
  onTools?: (id: string, tools: McpTool[]) => void;
  /** The protocol era a server answered with, to remember for next time. */
  onEra?: (id: string, era: { key: string; era: Era }) => void;
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
  return stripHidden(e?.message || String(error)).text;
}

/** A local server whose command the user hasn't confirmed on this device. */
export class LaunchNotApprovedError extends Error {
  constructor(name: string) {
    super(`The ${name} connector's command hasn't been confirmed yet. Open Settings → Connectors and press Test connection to review and allow it.`);
    this.name = "LaunchNotApprovedError";
  }
}

export const launchApproved = (c: ConnectorConfig) => c.transport !== "stdio" || c.approvedLaunch === launchKey(c);

type CachedList = { key: string; tools: McpTool[]; at: number; ttlMs?: number };

export class ConnectorManager {
  private live = new Map<string, { key: string; promise: Promise<McpClient> }>();
  /** tools/list results per server, fresh for the server's ttlMs (if it gave one). */
  private lists = new Map<string, CachedList>();

  constructor(private deps: ConnectorDeps) {}

  /** The last "connected" status per server, so later notes (skipped tools) keep its details. */
  private connected = new Map<string, ConnectorStatus>();

  private status(id: string, status: ConnectorStatus) {
    if (status.state === "connected") this.connected.set(id, status);
    else this.connected.delete(id);
    this.deps.onStatus?.(id, { ...status, at: Date.now() });
  }

  private async open(config: ConnectorConfig, signal?: AbortSignal): Promise<McpClient> {
    const key = shortHash(connectionKey(config));
    const prefer = config.protocolEra?.key === key ? config.protocolEra.era : undefined;
    let client: McpClient;
    if (config.transport === "stdio") {
      if (!config.command?.trim()) throw new Error("Enter the command that starts the server.");
      // Nothing starts a local server unless the user confirmed this exact command.
      if (!launchApproved(config)) throw new LaunchNotApprovedError(config.name);
      const start = async (era?: Era) => {
        const c = new McpClient(
          new StdioTransport(
            { id: config.id, command: config.command!.trim(), args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd?.trim() || undefined },
            this.deps.stdioBridge,
          ),
        );
        try {
          await c.connect(LIST_TIMEOUT_MS * 2, signal, era); // first runs of npx/uvx download packages
          return c;
        } catch (error) {
          await c.close();
          throw error;
        }
      };
      try {
        client = await start(prefer);
      } catch (error) {
        // The probe stopped an older server: start it again and use the handshake. A server that
        // turned modern since last time answers the handshake with an error: probe again.
        if (error instanceof McpProbeClosedError) client = await start("legacy");
        else if (prefer === "legacy" && error instanceof McpError) client = await start();
        else throw error;
      }
    } else {
      const url = config.url?.trim() ?? "";
      if (!/^https?:\/\//i.test(url)) throw new Error("Enter the server's full http(s) URL.");
      const connect = (era?: Era) => connectHttp({ url, headers: config.headers, token: config.token }, this.deps.fetchFor(config), LIST_TIMEOUT_MS, signal, era);
      try {
        client = await connect(prefer);
      } catch (error) {
        if (prefer === "legacy" && error instanceof McpError) client = await connect();
        else throw error;
      }
    }
    if (config.protocolEra?.key !== key || config.protocolEra.era !== client.era) this.deps.onEra?.(config.id, { key, era: client.era });
    return client;
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
        // The list changed: the cached one is stale now.
        this.lists.delete(config.id);
        void this.listTools(config, undefined, true).catch(() => undefined);
      };
      client.listen();
      this.status(config.id, {
        state: "connected",
        transport: client.transport.kind,
        server: client.serverInfo,
        protocolVersion: client.protocolVersion,
        era: client.era,
        instructions: stripHidden(client.instructions).text || undefined,
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

  /**
   * Connects (if needed) and lists the server's tools. A list the server said is still fresh
   * (ttlMs) is reused unless `force` (Test connection, a list_changed notification).
   */
  async listTools(config: ConnectorConfig, signal?: AbortSignal, force = false): Promise<McpTool[]> {
    const key = connectionKey(config);
    const cached = this.lists.get(config.id);
    if (!force && cached?.key === key && fresh(cached) && this.isLive(config.id)) return cached.tools;
    try {
      let skipped: ConnectorStatus["skippedTools"];
      const tools = await this.withClient(
        config,
        async (client) => {
          const list = await client.listTools(LIST_TIMEOUT_MS, signal);
          skipped = client.lastList?.rejected.length ? client.lastList.rejected : undefined;
          this.lists.set(config.id, { key, tools: list, at: client.lastList?.at ?? Date.now(), ttlMs: client.lastList?.ttlMs });
          return list;
        },
        signal,
      );
      const last = this.connected.get(config.id);
      if (last && JSON.stringify(last.skippedTools) !== JSON.stringify(skipped)) this.status(config.id, { ...last, skippedTools: skipped });
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
    options: { signal?: AbortSignal; onProgress?: (text: string) => void; ask?: Asker; inputSchema?: Record<string, unknown> } = {},
  ): Promise<McpCallResult> {
    const timeoutMs = (config.timeoutSec ?? CALL_TIMEOUT_MS / 1000) * 1000;
    try {
      return await this.withClient(
        config,
        (client) =>
          client.callTool(name, args, {
            timeoutMs,
            signal: options.signal,
            onProgress: options.onProgress,
            ask: options.ask,
            inputSchema: options.inputSchema,
            what: `${config.name} → ${name}`,
          }),
        options.signal,
      );
    } catch (error) {
      // "No such tool" or "bad arguments" may mean the list changed: refresh it in the background.
      if (error instanceof McpError && (error.code === -32601 || error.code === -32602)) this.refreshSoon(config, true);
      throw error;
    } finally {
      // The server said how long its list stays fresh: re-read it on use once that has passed. Not
      // polling, and at most every 30 s (a ttlMs of 0 would otherwise mean a listing per call).
      const cached = this.lists.get(config.id);
      if (cached?.ttlMs !== undefined && !fresh(cached) && Date.now() - cached.at > MIN_REFRESH_MS) this.refreshSoon(config);
    }
  }

  private refreshing = new Set<string>();
  private refreshSoon(config: ConnectorConfig, force = false) {
    if (this.refreshing.has(config.id)) return;
    this.refreshing.add(config.id);
    void this.listTools(config, undefined, force)
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(config.id));
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

const fresh = (list: CachedList) => list.ttlMs !== undefined && Date.now() < list.at + list.ttlMs;
const MIN_REFRESH_MS = 30_000;

// Agent tools -------------------------------------------------------------------------------

export const CONNECTORS_GROUP = "connectors";

/** What the approval card shows about a connector tool: where it comes from, its whole description. */
export type ConnectorToolInfo = {
  connectorId: string;
  connector: string;
  /** The tool's name on the server (hidden characters removed). */
  tool: string;
  title?: string;
  description: string;
  /** Hidden characters removed from this tool's name, description or schema. */
  hidden: number;
  /** Tools of this connector whose metadata had hidden characters. */
  connectorHidden: number;
};

const info = new Map<string, ConnectorToolInfo>();

/** Details for a connector tool's approval card (by agent tool name). */
export function connectorToolInfo(name: string): ConnectorToolInfo | undefined {
  return info.get(name);
}

const definitions = new WeakMap<McpTool, string>();
const definitionOf = (tool: McpTool) => {
  let d = definitions.get(tool);
  if (d === undefined) definitions.set(tool, (d = toolDefinition(tool)));
  return d;
};

/**
 * Whether this definition of the tool is the server's current one and the user approved it (or
 * nothing is pinned yet). A registration made before the server changed the tool fails this.
 */
export function toolApproved(config: ConnectorConfig, tool: McpTool): boolean {
  const current = config.tools?.find((t) => t.name === tool.name);
  if (current && current !== tool && definitionOf(current) !== definitionOf(tool)) return false;
  return !config.approvedTools || config.approvedTools[tool.name] === definitionOf(tool);
}

/** The agent tools a set of connectors provides right now. */
export function buildAgentTools(configs: ConnectorConfig[], manager: ConnectorManager, latest: (id: string) => ConnectorConfig | undefined): AgentTool[] {
  const out: AgentTool[] = [];
  const used = new Set<string>();
  info.clear();
  for (const config of configs) {
    if (!config.enabled) continue;
    const connectorHidden = toolsWithHidden(config.tools).length;
    // Changed or new tools wait for the user's review: even an uncalled tool's description reaches the model.
    const review = new Set(toolsToReview(config.tools, config.approvedTools).map((r) => r.name));
    for (const raw of config.tools ?? []) {
      if (config.disabledTools.includes(raw.name) || review.has(raw.name)) continue;
      const { tool, hidden } = cleanTool(raw);
      let name = agentToolName(config.name, raw.name);
      // Two servers with the same name: keep both by adding the server id's hash.
      if (used.has(name)) name = agentToolName(`${config.name}_${config.id.slice(0, 6)}`, raw.name);
      if (used.has(name)) continue;
      used.add(name);
      const title = tool.title ?? tool.annotations?.title ?? "";
      const description = `[${config.name} connector] ${title}${title ? ": " : ""}${tool.description ?? ""}`.trim().slice(0, 1200);
      info.set(name, { connectorId: config.id, connector: config.name, tool: tool.name, title: title || undefined, description: tool.description ?? "", hidden, connectorHidden });
      const callMs = (config.timeoutSec ?? CALL_TIMEOUT_MS / 1000) * 1000;
      out.push({
        name,
        description,
        parameters: toolParameters(tool.inputSchema) as AgentTool["parameters"],
        group: CONNECTORS_GROUP,
        risk: riskFromAnnotations(raw.annotations, config.readOnlyTools?.includes(raw.name)),
        kind: "mcp",
        controlsComputer: config.controlsComputer === true,
        platforms: config.transport === "stdio" ? ["desktop"] : undefined,
        // A backstop: the server's own time limit applies inside; this also leaves time for the user to answer its questions.
        timeoutMs: callMs + LIST_TIMEOUT_MS * 2 + QUESTION_TIMEOUT_MS,
        available: () => {
          const now = latest(config.id);
          return Boolean(now?.enabled && !now.disabledTools.includes(raw.name) && launchApproved(now) && toolApproved(now, raw));
        },
        async run(args, ctx) {
          const now = latest(config.id) ?? config;
          if (!now.enabled) throw new Error(`The ${now.name} connector is switched off.`);
          if (!toolApproved(now, raw)) throw new Error(`The ${now.name} connector changed the tool ${tool.name}; review it in Settings → Connectors first.`);
          ctx.progress(`Asking ${now.name}…`);
          // The server's questions go to the user, under this tool call. Nobody to ask (voice mode): none are offered.
          const callId = ctx.callId;
          const ask: Asker | undefined =
            callId && !ctx.unattended ? async (request) => askUser(callId, questionFromRequest(request, now.name), ctx.signal) : undefined;
          let result: McpCallResult;
          try {
            result = await manager.callTool(now, raw.name, args, {
              signal: ctx.signal,
              onProgress: (text) => ctx.progress(stripHidden(text).text.slice(0, 300)),
              ask,
              inputSchema: raw.inputSchema,
            });
          } catch (error) {
            if (error instanceof McpError && error.code === MISSING_CLIENT_CAPABILITY) {
              throw new Error(`${now.name} needs to ask you something to run this, which can't be shown here (voice mode or a routine). Try it from a chat.`);
            }
            const e = error as Error;
            if (e?.name === "AbortError") throw error;
            throw new Error(displayError(error));
          }
          const { text, display } = convertResult(result);
          const source = `the "${now.name}" connector (MCP tool ${tool.name})`;
          if (result.isError) return { content: `The tool reported an error:\n${text}`, untrustedSource: source };
          // Screenshots and other images go to the model too, not just to the chat.
          const picture = (Array.isArray(result.content) ? result.content : []).find(
            (p): p is { type: "image"; data: string; mimeType?: string } => (p as { type?: string })?.type === "image" && typeof (p as { data?: unknown }).data === "string",
          );
          const image = picture ? { mediaType: picture.mimeType ?? "image/png", data: picture.data } : undefined;
          return { content: image ? text.replace("— shown to the user", "— attached") : text, display, image, untrustedSource: source };
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
    const signature = JSON.stringify([tool.description, tool.parameters, tool.risk, tool.platforms, tool.timeoutMs, tool.controlsComputer]);
    if (registered.has(tool.name) && signatures.get(tool.name) === signature) continue;
    registerTool(tool);
    registered.add(tool.name);
    signatures.set(tool.name, signature);
  }
  return [...registered];
}
