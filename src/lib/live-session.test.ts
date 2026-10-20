// Voice mode on Gemini Live: the conversation is saved in the chat in order, tools run with the same
// approvals (asked aloud, answered by the user's own "yes" or "no"), and the session survives the
// server recycling its connection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, useStore } from "./store";
import type { Bot, ProviderConfig } from "./types";
import { type AgentTool, registerTool } from "./agent/tools";
import type { LiveConnectionOptions, LiveEvent } from "./gemini-live";
import { LiveVoiceSession } from "./live-session";

vi.mock("./transport", () => ({ providerFetch: vi.fn(), detectEnv: async () => ({ platform: "web", proxy: false }) }));
vi.mock("./voice", () => ({ stopReadAloud: () => undefined }));
vi.mock("./tts", () => ({ chime: () => undefined, createPcmPlayer: vi.fn() }));
vi.mock("./pcm-worklet.js?url", () => ({ default: "" }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

/** The server side of each connection the session opens. */
type Fake = { options: LiveConnectionOptions; sent: { kind: string; value: any }[]; closed: boolean; emit: (...events: LiveEvent[]) => void };
let connections: Fake[] = [];
const connect = (options: LiveConnectionOptions) => {
  const fake: Fake = { options, sent: [], closed: false, emit: (...events) => events.forEach((e) => options.onEvent(e)) };
  connections.push(fake);
  return {
    open: async () => undefined,
    sendAudio: (data: string) => fake.sent.push({ kind: "audio", value: data }),
    audioEnded: () => fake.sent.push({ kind: "audioEnd", value: null }),
    sendImage: (mediaType: string, data: string) => fake.sent.push({ kind: "image", value: { mediaType, data } }),
    sendText: (text: string) => fake.sent.push({ kind: "text", value: text }),
    sendToolResponses: (responses: unknown[]) => fake.sent.push({ kind: "tool", value: responses }),
    close: () => void (fake.closed = true),
  };
};
const last = () => connections[connections.length - 1];
const sent = (kind: string) => last().sent.filter((s) => s.kind === kind).map((s) => s.value);

/** The speakers: records what's queued; "plays" until the test lets it finish. */
let playing = 0;
let flushes = 0;
let waiters: (() => void)[] = [];
const player = {
  push: () => void playing++,
  flush: () => {
    flushes++;
    playing = 0;
    waiters.forEach((w) => w());
    waiters = [];
  },
  get playing() {
    return playing > 0;
  },
  idle: () => (playing ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
};
const finishPlaying = () => player.flush();

let micSend: (samples: Float32Array) => void = () => undefined;
const openMic = async (onAudio: (samples: Float32Array) => void) => {
  micSend = onAudio;
  return { level: () => 0.3, close: () => undefined };
};

let runs: string[] = [];
const tool = (name: string, risk: AgentTool["risk"]): AgentTool => ({
  name,
  group: "live-test",
  risk,
  description: name,
  parameters: { type: "object", properties: { text: { type: "string" } } },
  async run(args) {
    runs.push(`${name}:${args.text}`);
    return `${name} did ${args.text}`;
  },
});
for (const t of [tool("look_up", "read"), tool("send_note", "write"), tool("web_search", "read")]) registerTool(t);

const bot: Bot = {
  id: "b1", name: "ADT", avatar: "⚡", description: "", systemPrompt: "You are ADT, a helpful assistant.", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: ["Lives in Kolkata"], autoMemory: true, createdAt: 0, toolGroups: ["live-test"],
};
const gemini: ProviderConfig = { id: "g", presetId: "google", name: "Google Gemini", kind: "gemini", baseUrl: "https://x", apiKey: "AIza-test", models: [] };

let session: LiveVoiceSession | null = null;
let closedByUser = 0;
beforeEach(() => {
  session?.close(false);
  connections = [];
  runs = [];
  playing = 0;
  flushes = 0;
  waiters = [];
  closedByUser = 0;
  useStore.setState({
    hydrated: true,
    bots: [bot],
    providers: [gemini],
    activeBotId: "b1",
    activeConversationId: null,
    conversations: {},
    streamingId: null,
    settings: { ...defaultSettings, smartTitles: false, voice: { ...defaultSettings.voice, conversation: "gemini-live", liveVoice: "Puck" } },
  });
});

async function open(initialRequest?: string) {
  session = new LiveVoiceSession({ onState: () => undefined, onClose: () => closedByUser++, initialRequest }, { connect, openMic, player });
  await session.start();
  return session;
}
const chat = () => Object.values(useStore.getState().conversations)[0]?.messages ?? [];
const lines = () => chat().map((m) => `${m.role}: ${m.content}`);

describe("talking with Gemini Live", () => {
  it("sets up the bot's instructions, memories, voice and tools (Google Search instead of the app's web search)", async () => {
    const s = await open();
    expect(s.state.phase).toBe("listening");
    const setup = last().options.setup;
    expect(setup.model).toBe("gemini-3.8-live");
    expect(setup.voice).toBe("Puck");
    expect(setup.system).toMatch(/You are ADT/);
    expect(setup.system).toMatch(/Lives in Kolkata/);
    // A <remember> tag would be read out loud: memories go through the remember tool instead.
    expect(setup.system).not.toMatch(/<remember>/);
    expect(setup.system).toMatch(/live voice conversation/);
    expect(setup.system).toMatch(/two tool calls in a row/);
    expect(setup.tools.map((t) => t.name).sort()).toEqual(["look_up", "send_note"]);
    expect(setup.googleSearch).toBe(true);
    expect(last().options.key).toBe("AIza-test");
  });

  it("sends the microphone, plays the answer, and saves both sides in the chat in order", async () => {
    const s = await open();
    micSend(new Float32Array(1536));
    expect(sent("audio")).toHaveLength(1);
    last().emit({ type: "input", text: "What's the" }, { type: "input", text: " weather?" });
    expect(s.state.phase).toBe("hearing");
    expect(s.state.partial).toBe("What's the weather?");
    last().emit({ type: "audio", data: "AAAA", rate: 24000 }, { type: "output", text: "It's sunny" }, { type: "output", text: " in Kolkata." });
    expect(s.state.phase).toBe("speaking");
    expect(s.state.reply).toBe("It's sunny in Kolkata.");
    expect(s.state.latencyMs).not.toBeNull();
    last().emit({ type: "turnComplete" });
    expect(s.state.phase).toBe("speaking");
    finishPlaying();
    await until(() => s.state.phase === "listening");
    expect(lines()).toEqual(["user: What's the weather?", "assistant: It's sunny in Kolkata."]);
    expect(chat()[1].model).toBe("gemini-3.8-live");
    expect(Object.values(useStore.getState().conversations)[0].title).toBe("What's the weather?");
  });

  it("keeps the user's words above the reply when their transcript comes in late", async () => {
    await open();
    last().emit({ type: "audio", data: "AAAA", rate: 24000 }, { type: "output", text: "Sure." }, { type: "input", text: "Can you help?" });
    expect(lines()).toEqual(["user: Can you help?", "assistant: Sure."]);
  });

  it("stops talking when the user talks over it, and answers what they said instead", async () => {
    const s = await open();
    last().emit({ type: "input", text: "Tell me about Rome." }, { type: "audio", data: "AAAA", rate: 24000 }, { type: "output", text: "Rome was founded" });
    last().emit({ type: "interrupted" });
    expect(flushes).toBe(1);
    expect(s.state.phase).toBe("hearing");
    last().emit({ type: "input", text: "Paris instead." }, { type: "audio", data: "AAAA", rate: 24000 }, { type: "output", text: "Paris began as" }, { type: "turnComplete" });
    expect(lines()).toEqual(["user: Tell me about Rome.", "assistant: Rome was founded", "user: Paris instead.", "assistant: Paris began as"]);
  });

  it("a tap stops the voice at once and skips the rest of that answer", async () => {
    const s = await open();
    last().emit({ type: "input", text: "Long story please" }, { type: "audio", data: "AAAA", rate: 24000 });
    s.tap();
    expect(flushes).toBe(1);
    expect(s.state.phase).toBe("listening");
    last().emit({ type: "audio", data: "AAAA", rate: 24000 }, { type: "output", text: "and then" });
    expect(playing).toBe(0);
    expect(s.state.phase).toBe("listening");
    last().emit({ type: "turnComplete" });
    // The next answer plays again.
    last().emit({ type: "input", text: "Thanks" }, { type: "audio", data: "AAAA", rate: 24000 });
    expect(playing).toBe(1);
  });

  it("starts with the chat so far, ending on a finished reply", async () => {
    useStore.setState({
      activeConversationId: "c1",
      conversations: {
        c1: {
          id: "c1", botId: "b1", title: "Earlier", createdAt: 0, updatedAt: 0,
          messages: [
            { id: "1", role: "assistant", content: "Welcome!", createdAt: 0 },
            { id: "2", role: "user", content: "Plan a trip to Goa", createdAt: 0 },
            { id: "3", role: "assistant", content: "Sure: three days. <remember>Likes beaches</remember>", createdAt: 0 },
            { id: "4", role: "user", content: "Unanswered", createdAt: 0 },
          ],
        },
      },
    });
    await open();
    expect(last().options.setup.history).toEqual([
      { role: "user", text: "Plan a trip to Goa" },
      { role: "model", text: "Sure: three days." },
    ]);
  });

  it("says a request it was opened with", async () => {
    await open("What's on my calendar?");
    expect(sent("text")).toEqual(["What's on my calendar?"]);
    expect(lines()).toEqual(["user: What's on my calendar?"]);
  });

  it("explains what's missing without a Google key", async () => {
    useStore.setState({ providers: [] });
    const s = await open();
    expect(s.state.phase).toBe("error");
    expect(s.state.error).toMatch(/Google Gemini API key/);
    expect(connections).toHaveLength(0);
  });

  it("pauses the microphone when muted, and carries on when unmuted", async () => {
    const s = await open();
    s.toggleMute();
    expect(s.state.phase).toBe("muted");
    expect(sent("audioEnd")).toHaveLength(1);
    micSend(new Float32Array(1536));
    expect(sent("audio")).toHaveLength(0);
    s.toggleMute();
    micSend(new Float32Array(1536));
    expect(sent("audio")).toHaveLength(1);
  });

  it("ends after saying goodbye", async () => {
    await open();
    last().emit({ type: "input", text: "Goodbye" }, { type: "audio", data: "AAAA", rate: 24000 }, { type: "output", text: "Bye!" }, { type: "turnComplete" });
    expect(closedByUser).toBe(0);
    finishPlaying();
    await until(() => closedByUser === 1);
  });

  it("reconnects where it was when the server recycles the connection", async () => {
    const s = await open();
    last().emit({ type: "resume", handle: "h-42" }, { type: "goAway", timeLeftMs: 5000 });
    await until(() => connections.length === 2);
    expect(connections[1].options.setup.resumeHandle).toBe("h-42");
    await until(() => connections[0].closed);
    micSend(new Float32Array(1536));
    expect(connections[1].sent.filter((x) => x.kind === "audio")).toHaveLength(1);
    // A drop without warning: back the same way.
    connections[1].options.onClose({ code: 1006, reason: "" });
    await until(() => connections.length === 3);
    expect(connections[2].options.setup.resumeHandle).toBe("h-42");
    expect(s.state.phase).toBe("listening");
  });

  it("closing while it connects leaves nothing open", async () => {
    let finish: () => void = () => undefined;
    const slow = (options: LiveConnectionOptions) => {
      const c = connect(options);
      return { ...c, open: () => new Promise<void>((r) => (finish = r)) };
    };
    const s = new LiveVoiceSession({ onState: () => undefined, onClose: () => undefined }, { connect: slow, openMic, player });
    const started = s.start();
    await until(() => connections.length === 1);
    s.close(false);
    finish();
    await started;
    expect(connections[0].closed).toBe(true);
  });

  it("holds a tool result made during a reconnect and sends it on the new connection", async () => {
    let finish: () => void = () => undefined;
    let opened = 0;
    const second = (options: LiveConnectionOptions) => {
      const c = connect(options);
      return { ...c, open: () => (++opened === 1 ? Promise.resolve() : new Promise<void>((r) => (finish = r))) };
    };
    session = new LiveVoiceSession({ onState: () => undefined, onClose: () => undefined }, { connect: second, openMic, player });
    await session.start();
    connections[0].emit({ type: "resume", handle: "h1" }, { type: "goAway", timeLeftMs: 1000 }, { type: "toolCall", calls: [{ id: "c9", name: "look_up", args: { text: "x" } }] });
    await until(() => runs.length === 1);
    await sleep(20);
    expect(connections[0].sent.filter((x) => x.kind === "tool")).toHaveLength(0);
    finish();
    await until(() => connections[1].sent.some((x) => x.kind === "tool"));
    expect(connections[1].sent.find((x) => x.kind === "tool")!.value[0]).toMatchObject({ id: "c9", response: { status: "ok" } });
  });

  it("fails clearly when the connection drops and can't be resumed", async () => {
    const s = await open();
    last().options.onClose({ code: 1008, reason: "API key expired" });
    expect(s.state.phase).toBe("error");
    expect(s.state.error).toMatch(/refused the API key/);
  });
});

describe("tools in Gemini Live", () => {
  it("runs a lookup and sends the result back, recorded under the reply", async () => {
    await open();
    last().emit({ type: "input", text: "Look up milk" }, { type: "output", text: "On it." }, { type: "toolCall", calls: [{ id: "c1", name: "look_up", args: { text: "milk" } }] });
    await until(() => sent("tool").length === 1);
    expect(runs).toEqual(["look_up:milk"]);
    expect(sent("tool")[0]).toEqual([{ id: "c1", name: "look_up", response: { status: "ok", output: "look_up did milk" }, scheduling: "INTERRUPT" }]);
    await until(() => chat()[1]?.toolCalls?.[0]?.status === "done");
    expect(chat()[1].content).toBe("On it.");
  });

  it("asks aloud before an action and runs it when the user says yes", async () => {
    const s = await open();
    last().emit({ type: "input", text: "Send a note saying hi" }, { type: "toolCall", calls: [{ id: "c2", name: "send_note", args: { text: "hi" } }] });
    await until(() => s.state.approval !== null);
    expect(sent("text")[0]).toMatch(/needs the user's OK first\. Ask them now/);
    expect(runs).toEqual([]);
    last().emit({ type: "turnComplete" }, { type: "input", text: "Yes," }, { type: "input", text: " go ahead." });
    await until(() => sent("tool").length === 1);
    expect(runs).toEqual(["send_note:hi"]);
    expect(sent("tool")[0][0].response.status).toBe("ok");
    expect(s.state.approval).toBeNull();
  });

  it("doesn't run it when the user says no, and tells Gemini it was declined", async () => {
    const s = await open();
    last().emit({ type: "toolCall", calls: [{ id: "c3", name: "send_note", args: { text: "x" } }] });
    await until(() => s.state.approval !== null);
    last().emit({ type: "input", text: "No, don't." });
    await until(() => sent("tool").length === 1);
    expect(runs).toEqual([]);
    expect(sent("tool")[0][0].response).toMatchObject({ status: "declined", retryable: false });
  });

  it("doesn't take a question about the action as the answer", async () => {
    const s = await open();
    last().emit({ type: "toolCall", calls: [{ id: "c4", name: "send_note", args: { text: "x" } }] });
    await until(() => s.state.approval !== null);
    last().emit({ type: "input", text: "What will it say?" });
    await sleep(800);
    expect(s.state.approval).not.toBeNull();
    s.answerApproval("allow");
    await until(() => runs.length === 1);
  });

  it("runs an action once when Gemini calls it again while the user is still being asked", async () => {
    const s = await open();
    last().emit({ type: "toolCall", calls: [{ id: "c5", name: "send_note", args: { text: "once" } }] });
    await until(() => s.state.approval !== null);
    last().emit({ type: "toolCall", calls: [{ id: "c6", name: "send_note", args: { text: "once" } }] });
    await until(() => sent("tool").length === 1);
    expect(sent("tool")[0][0]).toMatchObject({ id: "c6", response: { status: "declined" } });
    expect(s.state.approval).not.toBeNull();
    s.answerApproval("allow");
    await until(() => sent("tool").length === 2);
    expect(runs).toEqual(["send_note:once"]);
  });

  it("stops a tool Gemini cancels", async () => {
    let aborted = false;
    registerTool({
      name: "slow_job",
      group: "live-test",
      risk: "read",
      description: "slow",
      parameters: { type: "object", properties: {} },
      run: (_args, ctx) =>
        new Promise((_resolve, reject) =>
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        ),
    });
    await open();
    last().emit({ type: "toolCall", calls: [{ id: "c7", name: "slow_job", args: {} }] });
    await sleep(20);
    last().emit({ type: "toolCancel", ids: ["c7"] });
    await until(() => aborted);
    await sleep(20);
    expect(sent("tool")).toHaveLength(0);
  });
});
