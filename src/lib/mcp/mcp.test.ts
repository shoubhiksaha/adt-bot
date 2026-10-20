// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configFromDraft, emptyDraft, splitArgs } from "../../features/connectors/form";
import { getTool, type ToolContext } from "../agent/tools";
import { McpClient } from "./client";
import { buildAgentTools, type ConnectorConfig, ConnectorManager, type ConnectorStatus, syncAgentTools } from "./connectors";
import { connectHttp, type FetchFn, StreamableHttpTransport } from "./http";
import {
  agentToolName,
  convertResult,
  createSseParser,
  MAX_RESULT_CHARS,
  McpClosedError,
  McpError,
  McpTimeoutError,
  type McpTool,
  riskFromAnnotations,
  type SseEvent,
  serverSlug,
  toolParameters,
} from "./protocol";
import type { StdioBridge } from "./stdio";

const PNG = Buffer.from("png-bytes").toString("base64");

// A tiny in-process MCP server ----------------------------------------------------------------

const PAGE1: McpTool[] = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "delete_everything", description: "Deletes", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
];
const PAGE2: McpTool[] = [
  { name: "fail", description: "Always fails", inputSchema: { type: "object" } },
  { name: "slow", description: "Never answers", inputSchema: { type: "object" } },
  { name: "picture", description: "Returns an image", inputSchema: { type: "object" } },
  { name: "weird.tool name!", description: "Odd name", inputSchema: { type: "object" } },
];

type Log = { method?: string; path: string; headers: IncomingMessage["headers"]; body?: any };

let server: Server;
let base = "";
const log: Log[] = [];
const sessions = new Set<string>();
const held: ServerResponse[] = [];
let sessionCount = 0;
let pingReplies = 0;
// Legacy SSE: open streams by session id.
const legacyStreams = new Map<string, ServerResponse>();

function toolResult(name: string, args: any): any {
  if (name === "echo") return { content: [{ type: "text", text: `echo: ${args?.text ?? ""}` }] };
  if (name === "fail") return { content: [{ type: "text", text: "the tool broke" }], isError: true };
  if (name === "picture") return { content: [{ type: "text", text: "a picture" }, { type: "image", data: PNG, mimeType: "image/png" }] };
  if (name === "weird.tool name!") return { content: [{ type: "text", text: "weird ok" }] };
  return null;
}

/** Answers one JSON-RPC message; null = no reply (notification / never). */
function answer(msg: any, version = "echo"): any {
  if (!("id" in msg)) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: version === "echo" ? msg.params.protocolVersion : version,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "test-server", version: "9.9" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return msg.params?.cursor === "p2" ? ok({ tools: PAGE2 }) : ok({ tools: PAGE1, nextCursor: "p2" });
    case "tools/call": {
      if (msg.params.name === "slow") return "hold";
      const result = toolResult(msg.params.name, msg.params.arguments);
      return result ? ok(result) : { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params.name}` } };
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
  }
}

async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

async function streamable(req: IncomingMessage, res: ServerResponse, mode: "json" | "sse", version = "echo") {
  if (req.method === "DELETE") {
    sessions.delete(String(req.headers["mcp-session-id"]));
    return res.writeHead(200).end();
  }
  if (req.method !== "POST") return res.writeHead(405).end();
  const msg = await readBody(req);
  log.push({ method: msg?.method, path: req.url ?? "", headers: req.headers, body: msg });
  if (msg?.method === "initialize") {
    const sid = `s-${++sessionCount}`;
    sessions.add(sid);
    res.setHeader("mcp-session-id", sid);
  } else {
    const sid = req.headers["mcp-session-id"];
    if (!sid) return res.writeHead(400).end("missing session");
    if (!sessions.has(String(sid))) return res.writeHead(404).end("unknown session");
  }
  if ("result" in (msg ?? {})) {
    if (msg.id === "srv-ping") pingReplies++;
    return res.writeHead(202).end();
  }
  const reply = answer(msg, version);
  if (reply === null) return res.writeHead(202).end();
  if (reply === "hold") {
    if (mode === "sse") res.writeHead(200, { "content-type": "text/event-stream" });
    held.push(res);
    return;
  }
  if (mode === "json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(reply));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (msg.method === "tools/call") {
    // A server-to-client ping and a progress notification before the answer.
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-ping", method: "ping" })}\n\n`);
    const token = msg.params?._meta?.progressToken;
    if (token !== undefined) {
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2, message: "Halfway" } })}\n\n`);
    }
  }
  // Split one event across two writes to exercise the incremental parser.
  const text = `event: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`;
  res.write(text.slice(0, 20));
  setTimeout(() => res.end(text.slice(20)), 5);
}

async function legacy(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", base);
  if (url.pathname === "/legacy" && req.method === "GET") {
    const sid = `L${++sessionCount}`;
    legacyStreams.set(sid, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`: hello\n\nevent: endpoint\ndata: /legacy/messages?sid=${sid}\n\n`);
    req.on("close", () => legacyStreams.delete(sid));
    return;
  }
  if (url.pathname === "/legacy" && req.method === "POST") {
    await readBody(req);
    return res.writeHead(405).end("Method Not Allowed");
  }
  if (url.pathname === "/legacy/messages" && req.method === "POST") {
    const stream = legacyStreams.get(url.searchParams.get("sid") ?? "");
    if (!stream) return res.writeHead(404).end();
    const msg = await readBody(req);
    log.push({ method: msg?.method, path: req.url ?? "", headers: req.headers, body: msg });
    res.writeHead(202).end("Accepted");
    const reply = answer(msg);
    if (reply && reply !== "hold") stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    return;
  }
  res.writeHead(404).end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/mcp-json") return void streamable(req, res, "json");
    if (path === "/mcp-sse") return void streamable(req, res, "sse");
    if (path === "/mcp-old") return void streamable(req, res, "json", "2024-11-05");
    if (path === "/mcp-bad") return void streamable(req, res, "json", "1999-01-01");
    if (path === "/mcp-auth") {
      if (req.headers.authorization !== "Bearer sekret") return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token" }));
      return void streamable(req, res, "json");
    }
    if (path.startsWith("/legacy")) return void legacy(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  for (const res of held) res.destroy();
  for (const res of legacyStreams.values()) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  log.length = 0;
});

const plainFetch: FetchFn = (url, init) => fetch(url, init);

// Pure helpers --------------------------------------------------------------------------------

describe("names, risk and results", () => {
  it("sanitises tool names to mcp_<server>_<tool>, ≤ 64 chars, unique", () => {
    expect(agentToolName("GitHub", "create_issue")).toBe("mcp_github_create_issue");
    expect(serverSlug("My Server!!")).toBe("my_server");
    const weird = agentToolName("Test", "weird.tool name!");
    expect(weird).toMatch(/^mcp_test_weird_tool_name_[a-z0-9]+$/);
    expect(agentToolName("Test", "weird tool name")).not.toBe(agentToolName("Test", "weird.tool.name"));
    const long = agentToolName("A very long server name indeed", "x".repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
    expect(agentToolName("S", "y".repeat(100))).not.toBe(agentToolName("S", `${"y".repeat(99)}z`));
    expect(agentToolName("😀", "🙂")).toMatch(/^mcp_server_tool_[a-z0-9]+$/);
  });

  it("maps annotations to risk", () => {
    // The server's read-only claim isn't trusted on its own; the user marking it read-only is.
    expect(riskFromAnnotations({ readOnlyHint: true })).toBe("external");
    expect(riskFromAnnotations({ readOnlyHint: true }, true)).toBe("read");
    expect(riskFromAnnotations({ destructiveHint: true }, true)).toBe("destructive");
    expect(riskFromAnnotations({ destructiveHint: true })).toBe("destructive");
    expect(riskFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe("destructive");
    expect(riskFromAnnotations({ readOnlyHint: false })).toBe("external");
    expect(riskFromAnnotations(undefined)).toBe("external");
  });

  it("normalises input schemas", () => {
    expect(toolParameters(undefined)).toEqual({ type: "object", properties: {} });
    expect(toolParameters({ $schema: "x", type: "object", required: ["a"] })).toEqual({ type: "object", properties: {}, required: ["a"] });
  });

  it("converts text, image, resource and link content", () => {
    const r = convertResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "file body" } },
        { type: "resource", resource: { uri: "file:///b.bin", mimeType: "application/zip", blob: "AAAA" } },
        { type: "resource_link", uri: "https://x.test/doc", name: "doc", description: "A doc" },
      ],
    });
    expect(r.text).toContain("hello");
    expect(r.text).toContain("[image (image/png)");
    expect(r.text).toContain("file body");
    expect(r.text).toContain("[binary resource file:///b.bin (application/zip)]");
    expect(r.text).toContain("uri: https://x.test/doc");
    expect(r.display).toEqual({ kind: "image", src: `data:image/png;base64,${PNG}` });
    expect(convertResult({ content: [], structuredContent: { a: 1 } }).text).toBe('{"a":1}');
    expect(convertResult({ content: [] }).text).toMatch(/no content/);
    const big = convertResult({ content: [{ type: "text", text: "z".repeat(MAX_RESULT_CHARS + 10) }] });
    expect(big.truncated).toBe(true);
    expect(big.text).toMatch(/\[truncated: the tool returned 20010 characters\]$/);
  });

  it("parses SSE incrementally (CRLF, multi-line data, comments)", () => {
    const events: SseEvent[] = [];
    const p = createSseParser((e) => events.push(e));
    p.push(": comment\r\nevent: endpoint\r");
    p.push("\ndata: /a\r\n\r\ndata: line1\ndata: line2\n");
    p.push("\n");
    p.end();
    expect(events).toEqual([
      { event: "endpoint", data: "/a", id: undefined },
      { event: "message", data: "line1\nline2", id: undefined },
    ]);
  });

  it("parses the add-connector form", () => {
    expect(splitArgs(`-y "@scope/pkg" 'a b' c\\ d`)).toEqual(["-y", "@scope/pkg", "a b", "c d"]);
    const parsed = configFromDraft({ ...emptyDraft("stdio"), name: "X", command: "npx -y server-x --flag" });
    expect(parsed).toEqual({ config: expect.objectContaining({ command: "npx", args: ["-y", "server-x", "--flag"] }) });
    expect(configFromDraft({ ...emptyDraft(), name: "Y", url: "ftp://nope" })).toHaveProperty("error");
    const http = configFromDraft({ ...emptyDraft(), name: "Y", url: "https://x.test/mcp", headers: "X-Key: 1\nbad line" });
    expect(http).toEqual({ config: expect.objectContaining({ headers: { "X-Key": "1" } }) });
  });
});

// HTTP transports -------------------------------------------------------------------------------

describe("Streamable HTTP", () => {
  for (const mode of ["json", "sse"] as const) {
    it(`handshake, session, pagination and calls (${mode} responses)`, async () => {
      const client = await connectHttp({ url: `${base}/mcp-${mode}` }, plainFetch);
      expect(client.transport.kind).toBe("streamable-http");
      expect(client.serverInfo.name).toBe("test-server");
      expect(client.protocolVersion).toBe("2025-06-18");
      const initialized = log.find((l) => l.method === "notifications/initialized");
      expect(initialized?.headers["mcp-session-id"]).toMatch(/^s-\d+$/);
      expect(initialized?.headers["mcp-protocol-version"]).toBe("2025-06-18");

      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...PAGE1, ...PAGE2].map((t) => t.name));
      expect(log.filter((l) => l.method === "tools/list").map((l) => l.body.params.cursor)).toEqual([undefined, "p2"]);

      const progress: string[] = [];
      const result = await client.callTool("echo", { text: "hi" }, { onProgress: (t) => progress.push(t) });
      expect(result.content?.[0]).toEqual({ type: "text", text: "echo: hi" });
      if (mode === "sse") {
        expect(progress).toEqual(["Halfway (50%)"]);
        await new Promise((r) => setTimeout(r, 30));
        expect(pingReplies).toBeGreaterThan(0);
      }

      const failed = await client.callTool("fail", {});
      expect(failed.isError).toBe(true);
      await expect(client.callTool("nope", {})).rejects.toBeInstanceOf(McpError);
      await client.close();
    });
  }

  it("times out and cancels a call that never answers", async () => {
    const client = await connectHttp({ url: `${base}/mcp-json` }, plainFetch);
    const started = Date.now();
    await expect(client.callTool("slow", {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(McpTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 30));
    expect(log.some((l) => l.method === "notifications/cancelled")).toBe(true);
    await client.close();
  });

  it("negotiates an older protocol version and rejects unknown ones", async () => {
    const old = await connectHttp({ url: `${base}/mcp-old` }, plainFetch);
    expect(old.protocolVersion).toBe("2024-11-05");
    await old.close();
    await expect(connectHttp({ url: `${base}/mcp-bad` }, plainFetch)).rejects.toThrow(/1999-01-01/);
  });

  it("sends the bearer token and explains 401s", async () => {
    await expect(connectHttp({ url: `${base}/mcp-auth` }, plainFetch)).rejects.toThrow(/401.*invalid_token.*bearer token/s);
    const client = await connectHttp({ url: `${base}/mcp-auth`, token: "sekret" }, plainFetch);
    expect(client.serverInfo.name).toBe("test-server");
    await client.close();
  });

  it("deletes the session on close", async () => {
    const transport = new StreamableHttpTransport(`${base}/mcp-json`, {}, plainFetch);
    const client = new McpClient(transport);
    await client.connect();
    const sid = transport.sessionId!;
    expect(sessions.has(sid)).toBe(true);
    await client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions.has(sid)).toBe(false);
  });
});

describe("legacy HTTP+SSE fallback", () => {
  it("falls back when POST is not allowed, then lists and calls over the stream", async () => {
    const client = await connectHttp({ url: `${base}/legacy` }, plainFetch);
    expect(client.transport.kind).toBe("sse");
    const tools = await client.listTools();
    expect(tools).toHaveLength(PAGE1.length + PAGE2.length);
    const result = await client.callTool("echo", { text: "old" });
    expect(result.content?.[0]).toEqual({ type: "text", text: "echo: old" });
    await client.close();
  });
});

// Manager + agent tools ----------------------------------------------------------------------

const ctx = (signal = new AbortController().signal) => ({ signal, progress: () => undefined }) as unknown as ToolContext;

describe("connector manager and agent tools", () => {
  it("registers tools with risk, reconnects after the session expires, unregisters on disable", async () => {
    const statuses: ConnectorStatus[] = [];
    let config: ConnectorConfig = { id: "srv1", name: "Test Server", enabled: true, transport: "http", url: `${base}/mcp-sse`, disabledTools: ["slow"] };
    const manager = new ConnectorManager({
      fetchFor: () => plainFetch,
      onStatus: (_id, s) => statuses.push(s),
      onTools: (_id, tools) => (config = { ...config, tools }),
    });
    await manager.listTools(config);
    expect(statuses.at(-1)).toMatchObject({ state: "connected", transport: "streamable-http", server: { name: "test-server" } });

    const names = syncAgentTools(buildAgentTools([config], manager, () => config));
    expect(names).toContain("mcp_test_server_echo");
    expect(names).not.toContain("mcp_test_server_slow");
    expect(names.some((n) => n.startsWith("mcp_test_server_weird_tool_name_"))).toBe(true);
    const echo = getTool("mcp_test_server_echo")!;
    expect(echo).toMatchObject({ group: "connectors", kind: "mcp", risk: "external" }); // the server says read-only; not trusted until the user marks it
    expect(getTool("mcp_test_server_delete_everything")?.risk).toBe("destructive");
    expect(getTool("mcp_test_server_fail")?.risk).toBe("external");

    const out = await echo.run({ text: "agent" }, ctx());
    expect(out).toMatchObject({ content: "echo: agent", untrustedSource: expect.stringContaining("Test Server") });
    const pic = await getTool("mcp_test_server_picture")!.run({}, ctx());
    expect(pic).toMatchObject({ display: { kind: "image", src: `data:image/png;base64,${PNG}` } });
    const failed = await getTool("mcp_test_server_fail")!.run({}, ctx());
    expect(failed).toMatchObject({ content: expect.stringContaining("the tool broke") });

    // The server forgets every session: the next call re-initialises transparently.
    const before = sessionCount;
    sessions.clear();
    expect(await echo.run({ text: "again" }, ctx())).toMatchObject({ content: "echo: again" });
    expect(sessionCount).toBe(before + 1);

    // Abort from the chat's stop button.
    const stop = new AbortController();
    const pending = manager.callTool(config, "slow", {}, { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    await expect(pending).rejects.toThrow(/Stopped/);

    config = { ...config, enabled: false };
    expect(syncAgentTools(buildAgentTools([config], manager, () => config))).toEqual([]);
    expect(getTool("mcp_test_server_echo")).toBeUndefined();
    await manager.disconnectAll();
  });

  it("shares one connection between concurrent first calls", async () => {
    const manager = new ConnectorManager({ fetchFor: () => plainFetch });
    const config: ConnectorConfig = { id: "c1", name: "C", enabled: true, transport: "http", url: `${base}/mcp-json`, disabledTools: [] };
    const before = sessionCount;
    const results = await Promise.all([manager.callTool(config, "echo", { text: "1" }), manager.callTool(config, "echo", { text: "2" }), manager.listTools(config)]);
    expect(results[0].content?.[0]).toEqual({ type: "text", text: "echo: 1" });
    expect(sessionCount).toBe(before + 1);
    await manager.disconnectAll();
  });

  it("reports connection errors in the status", async () => {
    const statuses: ConnectorStatus[] = [];
    const manager = new ConnectorManager({ fetchFor: () => plainFetch, onStatus: (_id, s) => statuses.push(s) });
    const config: ConnectorConfig = { id: "bad", name: "Bad", enabled: true, transport: "http", url: `${base}/mcp-auth`, disabledTools: [] };
    await expect(manager.listTools(config)).rejects.toThrow(/401/);
    expect(statuses.at(-1)).toMatchObject({ state: "error", error: expect.stringContaining("401") });
  });
});

// stdio (desktop) --------------------------------------------------------------------------------

const ECHO_SERVER = `
const readline = require("node:readline");
process.stdout.write("this banner is not JSON\\n");
console.error("echo server starting");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo-stdio", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "crash", inputSchema: { type: "object" } },
  ] } });
  if (m.method === "tools/call" && m.params.name === "echo") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "stdio: " + m.params.arguments.text + " " + (process.env.GREETING || "") }] } });
  if (m.method === "tools/call" && m.params.name === "crash") { console.error("boom"); process.exit(3); }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
});
`;

describe("stdio servers through the Electron feature", () => {
  const require = createRequire(import.meta.url);
  const { createManager } = require("../../../electron/features/40-mcp.cjs");
  const events = new EventEmitter();
  const processes = createManager({ send: (channel: string, payload: unknown) => events.emit(channel, payload) });
  const bridge: StdioBridge = {
    start: async (p) => processes.start(p),
    send: async (p) => processes.write(p),
    stop: async (id) => processes.stop(id),
    onMessage: (l) => {
      events.on("adt:mcp:message", l);
      return () => events.off("adt:mcp:message", l);
    },
    onExit: (l) => {
      events.on("adt:mcp:exit", l);
      return () => events.off("adt:mcp:exit", l);
    },
  };
  let dir = "";
  let script = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "adt-mcp-test-"));
    script = join(dir, "echo server.cjs");
    writeFileSync(script, ECHO_SERVER);
  });
  afterAll(() => {
    processes.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts the process, lists, calls, survives a crash and reconnects", async () => {
    const statuses: ConnectorStatus[] = [];
    const manager = new ConnectorManager({ fetchFor: () => plainFetch, stdioBridge: bridge, onStatus: (_id, s) => statuses.push(s) });
    const config: ConnectorConfig = {
      id: "local1",
      name: "Echo",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [script],
      env: { GREETING: "hello" },
      disabledTools: [],
    };
    const tools = await manager.listTools(config);
    expect(tools.map((t) => t.name)).toEqual(["echo", "crash"]);
    expect(statuses.at(-1)).toMatchObject({ state: "connected", transport: "stdio", server: { name: "echo-stdio" } });

    const result = await manager.callTool(config, "echo", { text: "hi" });
    expect(result.content?.[0]).toEqual({ type: "text", text: "stdio: hi hello" });

    const crash = manager.callTool(config, "crash", {});
    await expect(crash).rejects.toBeInstanceOf(McpClosedError);
    await expect(crash).rejects.toThrow(/exited with code 3[\s\S]*boom/);
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses.at(-1)).toMatchObject({ state: "error" });
    expect(manager.isLive("local1")).toBe(false);

    // Next use starts a fresh process.
    expect((await manager.callTool(config, "echo", { text: "back" })).content?.[0]).toEqual({ type: "text", text: "stdio: back hello" });

    const tool = buildAgentTools([{ ...config, tools }], manager, () => config).find((t) => t.name === "mcp_echo_echo");
    expect(tool).toMatchObject({ platforms: ["desktop"], risk: "external" });
    await manager.disconnectAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(processes.running()).toEqual([]);
  }, 30_000);

  it("reports a command that doesn't exist", async () => {
    const manager = new ConnectorManager({ fetchFor: () => plainFetch, stdioBridge: bridge });
    const config: ConnectorConfig = { id: "missing", name: "Missing", enabled: true, transport: "stdio", command: "/definitely/not/a/command-xyz", disabledTools: [] };
    await expect(manager.listTools(config)).rejects.toThrow(/process (exited|couldn't start)/);
  }, 30_000);
});
