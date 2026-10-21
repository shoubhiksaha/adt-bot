// @vitest-environment node
// Always-on routines on the server: the app's token guards everything but webhooks, provider keys
// are stored encrypted, scheduled runs use tools (search; reading pages stays off the server's own
// network), webhooks and feeds set runs off with what arrived as outside content, and results wait
// for the app.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentHost, fetchPublic } from "./agent.mjs";
import { startServer } from "./index.mjs";

const TOKEN = "t".repeat(32);
const requests = [];
let feedItems = [{ id: "a", title: "Old post" }];

/** One local server: a fake OpenAI-compatible model, a fake SearXNG and a feed. */
const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url.startsWith("/search")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: [{ title: "News", url: "https://news.example/1", content: "Something happened" }] }));
    if (req.url === "/feed.xml") {
      return res.writeHead(200, { "content-type": "application/xml" }).end(`<rss><channel>${feedItems.map((i) => `<item><guid>${i.id}</guid><title>${i.title}</title><link>https://blog.example/${i.id}</link></item>`).join("")}</channel></rss>`);
    }
    const body = JSON.parse(raw || "{}");
    requests.push({ auth: req.headers.authorization, body });
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    let delta;
    if (last?.role === "tool") delta = { content: `Done after ${last.name ?? "a tool"}: ${String(last.content).includes("Something happened") ? "found news" : String(last.content).slice(0, 80)}` };
    else if (/Summarise the news/.test(user)) delta = { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"AI news"}' } }] };
    else if (/Read the router/.test(user)) delta = { tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "read_url", arguments: '{"url":"http://127.0.0.1:1/admin"}' } }] };
    else delta = { content: `Handled: ${/started by something that happened/.test(user) ? "event" : "plain"}` };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

let fakeBase;
let host;
let server;
let base;
let clock = Date.UTC(2026, 9, 21, 7, 59);
const dir = mkdtempSync(join(tmpdir(), "adt-agent-"));
const notified = [];

beforeAll(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  host = createAgentHost({ dir, token: TOKEN, headless: () => import("../src/headless/agent.ts"), now: () => clock, allowPrivate: true, notify: (r) => notified.push(r) });
  ({ server, url: base } = await startServer({ port: 0, distDir: "/nonexistent", agent: host }));
});
afterAll(() => {
  host.stop();
  server.close();
  fake.close();
});

const api = (path, { method = "GET", body, auth = TOKEN } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const job = (extra) => ({
  name: "Morning news",
  instruction: "Summarise the news.",
  system: "You are ADT.",
  provider: { kind: "openai", presetId: "custom", name: "Mock", baseUrl: `${fakeBase}/v1`, apiKey: "sk-secret-key", model: "mock" },
  search: { engine: "searxng", url: fakeBase },
  ...extra,
});
const waitFor = async (check, ms = 5000) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

describe("always-on routines", () => {
  it("needs the token, and keeps provider keys encrypted", async () => {
    expect((await api("/api/agent", { auth: "" })).status).toBe(401);
    expect((await api("/api/agent", { auth: "wrong-token-wrong-token-wrong" })).status).toBe(401);
    const saved = await api("/api/agent/jobs/news", { method: "PUT", body: job({ schedule: { type: "daily", time: "08:00", timezone: "UTC" } }) });
    expect(saved.status).toBe(200);
    const { job: pub } = await saved.json();
    expect(pub).toMatchObject({ id: "news", name: "Morning news", nextRun: Date.UTC(2026, 9, 21, 8, 0) });
    expect(JSON.stringify(pub)).not.toMatch(/sk-secret-key/);
    expect(readFileSync(join(dir, "jobs.json"), "utf8")).not.toMatch(/sk-secret-key/);
    expect((await api("/api/agent/jobs/bad", { method: "PUT", body: job({}) })).status).toBe(400);
  });

  it("runs on schedule with tools, and keeps the result for the app", async () => {
    clock = Date.UTC(2026, 9, 21, 8, 0, 30);
    await host.tick();
    const result = await waitFor(async () => (await (await api("/api/agent/results?since=0")).json()).results.find((r) => r.jobId === "news"));
    expect(result).toMatchObject({ status: "ok", trigger: "schedule", text: "Done after a tool: found news", tools: [{ name: "web_search", ok: true }] });
    // The key went to the model, decrypted, and only there.
    expect(requests[0].auth).toBe("Bearer sk-secret-key");
    expect(requests[0].body.messages[0].content).toMatch(/You are ADT\.[\s\S]*always-on server/);
    expect(JSON.stringify(requests[1].body.messages)).toMatch(/untrusted_data source=\\"web search results\\"/);
    expect(host.jobs()[0].nextRun).toBe(Date.UTC(2026, 9, 22, 8, 0));
    expect(notified.at(-1)).toMatchObject({ name: "Morning news" });
  });

  it("never reads the server's own network for a run", async () => {
    await api("/api/agent/jobs/router", { method: "PUT", body: job({ name: "Router", instruction: "Read the router admin page.", schedule: { type: "daily", time: "09:00", timezone: "UTC" } }) });
    await api("/api/agent/jobs/router/run", { method: "POST" });
    const result = await waitFor(async () => (await (await api("/api/agent/results?since=0")).json()).results.find((r) => r.jobId === "router"));
    expect(result.tools).toEqual([{ name: "read_url", ok: false, ms: expect.any(Number) }]);
    await expect(fetchPublic("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private network/);
    await expect(fetchPublic("http://localhost:8080/")).rejects.toThrow(/private network/);
  });

  it("webhooks run the routine with what was sent, as outside content", async () => {
    const saved = await (await api("/api/agent/jobs/hook", { method: "PUT", body: job({ name: "Orders", instruction: "Log the order.", trigger: { type: "webhook" } }) })).json();
    const hookToken = saved.job.hookToken;
    expect(hookToken).toMatch(/^[\w-]{32,}$/);
    expect((await fetch(`${base}/api/agent/hook/${"x".repeat(40)}`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/api/agent/hook/${hookToken}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"order":42}' })).status).toBe(202);
    const result = await waitFor(async () => (await (await api("/api/agent/results?since=0")).json()).results.find((r) => r.jobId === "hook"));
    expect(result).toMatchObject({ trigger: "event", text: "Handled: event", events: 1 });
    expect(JSON.stringify(requests.at(-1).body.messages)).toMatch(/untrusted_data source=\\"a webhook call\\"[\s\S]*order[\s\S]*42/);
  });

  it("feeds: the first check notes what's there; new items run the routine", async () => {
    await api("/api/agent/jobs/feed", { method: "PUT", body: job({ name: "Blog", instruction: "Summarise new posts.", trigger: { type: "feed", url: `${fakeBase}/feed.xml` } }) });
    await host.tick();
    expect((await (await api("/api/agent/results?since=0")).json()).results.some((r) => r.jobId === "feed")).toBe(false);
    feedItems = [{ id: "b", title: "New post" }, ...feedItems];
    clock += 16 * 60_000;
    await host.tick();
    const result = await waitFor(async () => (await (await api("/api/agent/results?since=0")).json()).results.find((r) => r.jobId === "feed"));
    expect(result).toMatchObject({ trigger: "event", events: 1 });
    expect(JSON.stringify(requests.at(-1).body.messages)).toMatch(/New post/);
  });

  it("deletes routines", async () => {
    expect((await api("/api/agent/jobs/feed", { method: "DELETE" })).status).toBe(204);
    expect(host.jobs().map((j) => j.id)).not.toContain("feed");
  });
});
