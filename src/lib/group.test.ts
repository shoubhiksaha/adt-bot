// @vitest-environment node
// Group chats: each bot sees the chat from its own seat, takes its turn in order for the set rounds,
// passes when it has nothing to add (a silent round ends it), a panel's first answers are
// independent, a summariser closes, Stop ends the whole group, and bots can start one themselves.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, newGroupConversation, useStore } from "./store";
import type { Bot, Message, ProviderConfig } from "./types";
import { groupPrompt, groupTitle, groupView, isPass, stanceFor, validateGroup } from "./group";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const { sendMessage, stopStreaming } = await import("./chat");
const { getTool } = await import("./agent/tools");
await import("./agent/features");

/** What each request looked like, and a rule for answering it. */
const seen: { system: string; messages: { role: string; content: string }[] }[] = [];
let answer: (system: string, messages: { role: string; content: string }[]) => string = () => "ok";
let delayMs = 0;
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      const system = body.messages.filter((m: { role: string }) => m.role === "system").map((m: { content: string }) => m.content).join("\n");
      const messages = body.messages.filter((m: { role: string }) => m.role !== "system").map((m: { role: string; content: unknown }) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
      seen.push({ system, messages });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const text = answer(system, messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => server.close());

const bot = (id: string, name: string): Bot => ({ id, name, avatar: "", description: `${name} the bot`, systemPrompt: `You are ${name}.`, providerId: "p", model: "m", temperature: null, thinking: "off", memory: [], autoMemory: false, toolGroups: [], createdAt: 0 });
const speaker = (system: string) => /You are (\w+) in a group chat/.exec(system)?.[1] ?? "?";
const replies = (id: string) => (useStore.getState().conversations[id]?.messages ?? []).filter((m) => m.role === "assistant");
const names = (id: string) => replies(id).map((m) => useStore.getState().bots.find((b) => b.id === m.botId)?.name);

beforeEach(() => {
  seen.length = 0;
  delayMs = 0;
  answer = (system) => `${speaker(system)} here.`;
  const provider: ProviderConfig = { id: "p", presetId: "custom", name: "Mock", kind: "openai", baseUrl: base, apiKey: "", models: [] };
  useStore.setState({
    providers: [provider],
    bots: [bot("a", "Ava"), bot("b", "Ben"), bot("c", "Cy")],
    conversations: {},
    skills: [],
    streamingId: null,
    activeConversationId: null,
    settings: { ...defaultSettings, userName: "Shoubhik", smartTitles: false, agent: { ...defaultSettings.agent, enabled: false } },
    hydrated: true,
  });
});

describe("rules", () => {
  it("checks the group, spots passes and alternates debate sides", () => {
    expect(validateGroup(["a"], { mode: "discuss", rounds: 1 })).toMatch(/at least 2/);
    expect(validateGroup(["a", "a"], { mode: "discuss", rounds: 1 })).toMatch(/only join once/);
    expect(validateGroup(["a", "b"], { mode: "discuss", rounds: 9 })).toMatch(/1 to 5/);
    expect(validateGroup(["a", "b"], { mode: "debate", rounds: 3 })).toBeNull();
    expect(["[PASS]", "pass", "Pass.", "(passes)", "[PASS] nothing to add"].every(isPass)).toBe(true);
    expect(isPass("I'd pass on the second option because…")).toBe(false);
    expect([0, 1, 2].map(stanceFor)).toEqual(["for", "against", "for"]);
    expect(groupTitle([{ name: "Ava" }, { name: "Ben" }, { name: "Cy" }, { name: "Dee" }])).toBe("Group: Ava, Ben, Cy +1");
  });

  it("shows each bot the chat from its own seat", () => {
    const msg = (role: "user" | "assistant", content: string, botId?: string, id = crypto.randomUUID()): Message => ({ id, role, content, botId, createdAt: 0 });
    const history = [msg("user", "Tea or coffee?"), msg("assistant", "Tea.", "a"), msg("assistant", "Coffee.", "b", "b1"), msg("assistant", "Water.", "c")];
    const bots = [bot("a", "Ava"), bot("b", "Ben"), bot("c", "Cy")];
    expect(groupView(history, "a", bots, { userName: "Shoubhik" }).map((m) => [m.role, m.content])).toEqual([
      ["user", "Shoubhik (the user): Tea or coffee?"],
      ["assistant", "Tea."],
      ["user", "Ben (another bot): Coffee.\n\nCy (another bot): Water."],
    ]);
    // Its own reply last: told it's its turn again. Hidden replies left out.
    expect(groupView(history, "c", bots, { hide: ["b1"] }).map((m) => m.content)).toEqual(["User (the user): Tea or coffee?\n\nAva (another bot): Tea.", "Water.", "(Your turn again.)"]);
    const prompt = groupPrompt(bots[1], bots, { mode: "debate", rounds: 2 }, { round: 2, rounds: 2, stance: "against" });
    expect(prompt).toMatch(/You are Ben in a group chat with the user and other AI bots: Ava \(Ava the bot\), Cy \(Cy the bot\)/);
    expect(prompt).toMatch(/Your side: AGAINST/);
    expect(prompt).toMatch(/Round 2 of 2[\s\S]*\[PASS\]/);
    expect(groupPrompt(bots[0], bots, { mode: "discuss", rounds: 1 }, { round: 2, rounds: 1, summary: true })).toMatch(/discussion is over. Sum it up/);
  });
});

describe("a group chat", () => {
  it("lets every bot speak in order each round, then the summariser", async () => {
    const c = newGroupConversation(["a", "b", "c"], { mode: "discuss", rounds: 2, summarizer: "a" }, "Group");
    await sendMessage("Tea or coffee?");
    expect(names(c.id)).toEqual(["Ava", "Ben", "Cy", "Ava", "Ben", "Cy", "Ava"]);
    expect(replies(c.id).at(-1)?.summary).toBe(true);
    expect(useStore.getState().streamingId).toBeNull();
    // Ben's second turn saw everyone's first turn, by name, and its own as its own.
    const benRound2 = seen.filter((r) => speaker(r.system) === "Ben")[1];
    expect(benRound2.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(benRound2.messages[2].content).toMatch(/^Cy \(another bot\): Cy here\.\n\nAva \(another bot\): Ava here\.$/);
    expect(seen.at(-1)!.system).toMatch(/Sum it up/);
  });

  it("drops passes and ends early when a whole round passes", async () => {
    const c = newGroupConversation(["a", "b"], { mode: "discuss", rounds: 5 }, "Group");
    answer = (system) => (/Round 1 of/.test(system) ? `${speaker(system)} thinks so.` : "[PASS]");
    await sendMessage("Is the sky blue?");
    expect(names(c.id)).toEqual(["Ava", "Ben"]);
    expect(seen).toHaveLength(4);
  });

  it("debates take sides; a panel's first answers are independent", async () => {
    const d = newGroupConversation(["a", "b"], { mode: "debate", rounds: 1 }, "Debate");
    await sendMessage("Should we move to Lisbon?");
    expect(seen.map((r) => /Your side: (\w+)/.exec(r.system)?.[1])).toEqual(["FOR", "AGAINST"]);
    expect(names(d.id)).toEqual(["Ava", "Ben"]);
    seen.length = 0;
    const p = newGroupConversation(["a", "b", "c"], { mode: "panel", rounds: 2 }, "Panel");
    await sendMessage("Best city for a sabbatical?");
    // Round 1: nobody saw another bot's answer. Round 2: everyone's.
    for (const r of seen.slice(0, 3)) expect(JSON.stringify(r.messages)).not.toMatch(/another bot/);
    expect(JSON.stringify(seen[3].messages)).toMatch(/Ben \(another bot\)[\s\S]*Cy \(another bot\)/);
    expect(names(p.id)).toHaveLength(6);
  });

  it("Stop ends the whole group, not just the bot speaking", async () => {
    const c = newGroupConversation(["a", "b", "c"], { mode: "discuss", rounds: 3 }, "Group");
    delayMs = 150;
    const done = sendMessage("Long debate please");
    await new Promise((r) => setTimeout(r, 60));
    stopStreaming();
    await done;
    expect(seen.length).toBe(1);
    expect(replies(c.id).length).toBeLessThanOrEqual(1);
    expect(useStore.getState().streamingId).toBeNull();
  });

  it("a bot can have others discuss something and gets the transcript", async () => {
    const tool = getTool("discuss_with_bots")!;
    const result = (await tool.run(
      { bots: ["Ben", "Cy"], topic: "Pick a name for the cat", mode: "debate", rounds: 1 },
      { bot: bot("a", "Ava"), conversationId: "parent", settings: useStore.getState().settings, providers: useStore.getState().providers, platform: "web", signal: new AbortController().signal, progress: () => undefined },
    )) as { content: string; untrustedSource?: string; display?: { conversationId: string } };
    expect(result.content).toMatch(/Ben: Ben here\.\n\nCy: Cy here\./);
    expect(result.untrustedSource).toBe("other bots' replies");
    const chat = useStore.getState().conversations[result.display!.conversationId];
    expect(chat).toMatchObject({ members: ["b", "c"], origin: "task", group: { mode: "debate", rounds: 1 } });
    // The discussion's bots can't start another one from there.
    await expect(
      tool.run({ bots: ["Ava", "Cy"], topic: "x" }, { bot: bot("b", "Ben"), conversationId: chat.id, settings: useStore.getState().settings, providers: [], platform: "web", signal: new AbortController().signal, progress: () => undefined }),
    ).rejects.toThrow(/can't start a discussion/);
  });
});
