// @vitest-environment node
// Routines on the always-on server, from the app's side: what's sent (the bot's whole setup, with the
// key only to the server), run now, webhook addresses, and results coming back into the routine's
// chat and history.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const { createAgentHost } = await import("../../../server/agent.mjs");
const { startServer } = await import("../../../server/index.mjs");
const { defaultSettings, useStore } = await import("../../lib/store");
const { createRoutine, emptySchedule, getRoutine, useRoutines } = await import("./routines-store");
const { collectServerResults, pushServerRoutine, runOnServerNow, serverHookUrl, serverJob, testServer } = await import("./server-routines");
const { addSkill } = await import("../skills/skills");

const TOKEN = "s".repeat(30);
let fake: Server;
let host: ReturnType<typeof createAgentHost>;
let server: Server;
let base = "";
const prompts: string[] = [];

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      prompts.push(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Here is today's summary." } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const llm = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
  host = createAgentHost({ dir: mkdtempSync(join(tmpdir(), "adt-srv-")), token: TOKEN, headless: () => import("../../headless/agent"), allowPrivate: true });
  ({ server, url: base } = await startServer({ port: 0, distDir: "/nonexistent", agent: host }));
  useStore.setState({
    providers: [{ id: "p", presetId: "custom", name: "Mock", kind: "openai", baseUrl: llm, apiKey: "sk-app-key", models: [] }],
    bots: [{ id: "b", name: "ADT", avatar: "", description: "", systemPrompt: "You are ADT.", providerId: "p", model: "mock", temperature: null, thinking: "off", memory: ["Likes short answers."], autoMemory: true, createdAt: 0 }],
    conversations: {},
    skills: [],
    settings: { ...defaultSettings, userName: "Shoubhik", sharedMemory: ["Lives in Kolkata."], useProxy: false, server: { url: base, token: TOKEN } },
    hydrated: true,
  });
  useRoutines.setState({ routines: [], loaded: true, running: [] });
});
afterAll(() => {
  host.stop();
  server.close();
  fake.close();
});

describe("routines on the server", () => {
  it("connects with the token", async () => {
    expect(await testServer()).toBe(0);
    useStore.setState((s) => ({ settings: { ...s.settings, server: { url: base, token: "x".repeat(30) } } }));
    await expect(testServer()).rejects.toThrow(/refused the token/);
    useStore.setState((s) => ({ settings: { ...s.settings, server: { url: base, token: TOKEN } } }));
  });

  it("sends the bot's whole setup, runs it, and brings the result back", async () => {
    addSkill({ name: "daily-digest", description: "The daily digest", instructions: "1. Search. 2. Summarise." });
    const routine = await createRoutine({ botId: "b", name: "Digest", instruction: "/daily-digest", schedule: { type: "daily", time: "08:00", timezone: "UTC" }, where: "server" });
    // The list shows when it runs next; this app never runs it itself (planDue skips server routines).
    expect(routine.nextRun).toBeGreaterThan(0);
    const job = serverJob(routine);
    expect(job.system).toMatch(/You are ADT\.[\s\S]*Shoubhik[\s\S]*Lives in Kolkata\.[\s\S]*Likes short answers\.[\s\S]*- daily-digest: The daily digest/);
    expect(job.provider).toMatchObject({ kind: "openai", apiKey: "sk-app-key", model: "mock" });
    expect(job.skills).toEqual([{ name: "daily-digest", description: "The daily digest", instructions: "1. Search. 2. Summarise." }]);
    await pushServerRoutine(routine);
    expect(host.jobs()).toMatchObject([{ id: routine.id, name: "Digest", nextRun: expect.any(Number) }]);
    await runOnServerNow(routine.id);
    let count = 0;
    for (let i = 0; i < 100 && !count; i++) {
      await new Promise((r) => setTimeout(r, 50));
      count = await collectServerResults();
    }
    expect(count).toBe(1);
    const updated = getRoutine(routine.id)!;
    expect(updated.history[0]).toMatchObject({ status: "ok", trigger: "manual", summary: "Here is today's summary." });
    const chat = useStore.getState().conversations[updated.conversationId!];
    expect(chat.messages.at(-1)).toMatchObject({ role: "assistant", content: "Here is today's summary.", status: expect.stringMatching(/^Ran on your server/) });
    expect(prompts.at(-1)).toMatch(/always-on server/);
    // Already collected: nothing twice.
    expect(await collectServerResults()).toBe(0);
  });

  it("gives webhook routines the server's own address", async () => {
    const routine = await createRoutine({ botId: "b", name: "Orders", instruction: "Log it.", schedule: emptySchedule(), trigger: { type: "webhook", token: "local-token-local-token-xx" }, where: "server" });
    await pushServerRoutine(routine);
    const url = serverHookUrl(getRoutine(routine.id)!);
    expect(url).toMatch(new RegExp(`^${base}/api/agent/hook/[\\w-]{32,}$`));
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(202);
  });

  it("refuses triggers the server can't watch", () => {
    expect(() => serverJob({ ...getRoutine(useRoutines.getState().routines[0].id)!, trigger: { type: "email", account: "x" } })).toThrow(/schedule, a feed, a page change or a webhook/);
  });
});
