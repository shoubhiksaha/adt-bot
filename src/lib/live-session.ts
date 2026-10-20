// Voice mode with Gemini Live: one model hears the microphone and answers in its own voice, so
// there's no speech recognition, turn detection or reply voice of our own. The app keeps what makes
// it ADT Bot: the bot's instructions and memory, its tools (with the same approvals, asked aloud),
// and the conversation saved in the chat as text.
import { accessGuidance, isComputerTool } from "./agent/access";
import { activityFor } from "./agent/asks";
import { COMPUTER_GUIDANCE, createToolRunner, TOOL_GUIDANCE, type ToolRunner } from "./agent/loop";
import { type AgentTool, type ToolContext, toolsFor, type TurnTaint } from "./agent/tools";
import { buildSystemPrompt, setVoiceApprover, setVoiceModeActive, stripMemoryTags, titleFrom } from "./chat";
import { closeReason, LIVE_MODELS, LiveConnection, type LiveCall, type LiveEvent, type LiveSetup, pcm16Base64, pcm16Samples } from "./gemini-live";
import workletUrl from "./pcm-worklet.js?url";
import { newConversation, uid, updateConversation, useStore } from "./store";
import { detectEnv } from "./transport";
import { chime, createPcmPlayer, type PcmPlayer } from "./tts";
import type { Message, ToolCallRecord } from "./types";
import { stopReadAloud } from "./voice";
import { parseVoiceCommand, yesOrNo } from "./voice-commands";
import type { VoiceState } from "./voice-session";

/** Quiet this long (nobody talking): stop sending the microphone, which Gemini bills by the minute. */
const IDLE_MS = 3 * 60_000;
/** A pause this long after "yes" or "no" ends the answer to a question a tool asked. */
const ANSWER_PAUSE_MS = 700;
/** Earlier messages sent along when a session starts, so the conversation carries on. */
const HISTORY_MESSAGES = 20;
/** Tool results are cut to this length (the session's context is smaller than a chat model's). */
const RESULT_LIMIT = 12_000;

const LIVE_RULES = [
  "Tools run in the background while you keep talking: say one short sentence first (like \"On it.\"), then give the result when it arrives.",
  "Never make more than two tool calls in a row without saying something to the user.",
  "Some actions need the user's OK. When the app tells you to ask, ask in one short sentence and wait: the app hears their answer and sends you the tool's result. Don't call the tool again yourself.",
  "For current information (news, weather, prices, scores), use Google Search.",
].join(" ");

type Mic = { level(): number; close(): void };

/** Opens the microphone (echo-cancelled) and hands over ~0.1 s pieces of 16 kHz audio. */
async function openMic(onAudio: (samples: Float32Array) => void): Promise<Mic> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch {
    throw new Error("Microphone access was blocked. Allow it in your system or browser settings.");
  }
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-frames");
  // Keeps the node pulled by the audio graph without making a sound.
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(node).connect(silent).connect(context.destination);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  if (context.state === "suspended") await context.resume();
  const channel = new MessageChannel();
  node.port.postMessage({ port: channel.port1 }, [channel.port1]);
  // The worklet sends 32 ms frames; three make a piece.
  let frames: Float32Array[] = [];
  channel.port2.onmessage = (event: MessageEvent<Float32Array>) => {
    frames.push(event.data);
    if (frames.length < 3) return;
    const piece = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      piece.set(f, at);
      at += f.length;
    }
    frames = [];
    onAudio(piece);
  };
  return {
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
      return Math.max(0, Math.min(1, (db + 60) / 48));
    },
    close() {
      channel.port2.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      void context.close().catch(() => undefined);
    },
  };
}

export type LiveDeps = {
  connect?: (options: ConstructorParameters<typeof LiveConnection>[0]) => Pick<LiveConnection, "open" | "sendAudio" | "audioEnded" | "sendImage" | "sendText" | "sendToolResponses" | "close">;
  openMic?: typeof openMic;
  player?: PcmPlayer;
};

type Turn = { id: string; text: string };
type Reply = Turn & { runner: ToolRunner; startedAt: number; withUser: boolean };
type Approval = {
  summary: string;
  resolve: (answer: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
  heard: string;
  pause: ReturnType<typeof setTimeout> | null;
};

export class LiveVoiceSession {
  state: VoiceState;
  private closed = false;
  private connection: ReturnType<NonNullable<LiveDeps["connect"]>> | null = null;
  private setup: LiveSetup | null = null;
  private key = "";
  private resumeHandle = "";
  private reconnecting = false;
  private mic: Mic | null = null;
  private player: PcmPlayer;
  /** Microphone audio isn't sent (muted, or paused while quiet). */
  private paused = false;
  private conversationId: string | null = null;
  /**
   * This exchange: what the user said and the reply (both saved in the chat as they come). Open
   * until the reply's turn is complete: the transcript of the user's last words can arrive after
   * the reply has started.
   */
  private user: Turn | null = null;
  private reply: Reply | null = null;
  /** The user tapped to interrupt: the rest of this reply isn't played. */
  private skipping = false;
  private lastInputAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = new Map<string, AbortController>();
  private approval: Approval | null = null;
  /** Questions from tools are asked one at a time. */
  private approvals: Promise<unknown> = Promise.resolve();
  /** The user said "goodbye": end once the reply is over. */
  private ending = false;
  private stopAll = new AbortController();
  private taint: TurnTaint = { sources: new Set() };
  private tools: AgentTool[] = [];
  private toolContext: Omit<ToolContext, "turnId" | "conversationId"> | null = null;

  constructor(
    private hooks: { onState: (state: VoiceState) => void; onClose: () => void; initialRequest?: string },
    private deps: LiveDeps = {},
  ) {
    const { voice } = useStore.getState().settings;
    this.player = deps.player ?? createPcmPlayer();
    const model = LIVE_MODELS.find((m) => m.id === voice.liveModel)?.label.split(" (")[0] ?? voice.liveModel;
    this.state = {
      phase: "loading",
      partial: "",
      heard: "",
      reply: "",
      sentence: "",
      spokenChars: 0,
      activity: "",
      error: null,
      download: null,
      latencyMs: null,
      timing: null,
      engineLabel: `${model} · ${voice.liveVoice || "Kore"}`,
      wakeName: "",
      approval: null,
      live: true,
    };
  }

  private set(patch: Partial<VoiceState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.hooks.onState(this.state);
  }

  inputLevel(): number {
    const phase = this.state.phase;
    if (phase !== "listening" && phase !== "hearing") return 0;
    return this.mic?.level() ?? 0;
  }

  async start() {
    setVoiceModeActive(true);
    setVoiceApprover((request) => this.askApproval(request));
    stopReadAloud();
    const { settings, providers, bots, activeBotId, activeConversationId } = useStore.getState();
    const bot = bots.find((b) => b.id === activeBotId);
    const provider =
      providers.find((p) => p.id === settings.voice.liveProviderId && p.kind === "gemini" && p.apiKey) ?? providers.find((p) => p.kind === "gemini" && p.apiKey);
    if (!bot) return this.fail("Pick a bot first.");
    if (!provider) return this.fail("Gemini Live needs a Google Gemini API key. Add Google Gemini under Settings → Providers (a free key from aistudio.google.com), or switch Settings → Voice → Conversation back to ADT Bot.");
    this.key = provider.apiKey;
    this.conversationId = activeConversationId;
    const platform = (await detectEnv()).platform;
    // Gemini searches Google itself; the app's own web search isn't needed.
    this.tools = toolsFor({ settings, providers, platform, bot }).filter((t) => t.name !== "web_search");
    this.toolContext = {
      bot,
      settings,
      providers,
      platform,
      signal: this.stopAll.signal,
      progress: () => undefined,
      unattended: true,
      askAloud: (request) => this.askApproval(request),
      taint: this.taint,
    };
    this.setup = {
      model: settings.voice.liveModel || LIVE_MODELS[0].id,
      voice: settings.voice.liveVoice,
      system: this.systemPrompt(),
      tools: this.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      history: this.history(),
      googleSearch: true,
    };
    try {
      await this.connect();
      if (this.closed) return;
      this.mic = await (this.deps.openMic ?? openMic)((samples) => {
        if (!this.paused) this.connection?.sendAudio(pcm16Base64(samples));
      });
    } catch (error) {
      this.fail((error as Error).message);
      return;
    }
    if (this.closed) return this.mic?.close();
    chime("listen");
    this.set({ phase: "listening", error: null });
    this.armIdle();
    const request = this.hooks.initialRequest?.trim();
    if (request) {
      this.userSaid(request);
      this.connection?.sendText(request);
    }
  }

  /** The bot's instructions for a spoken conversation, with its tools' guidance. */
  private systemPrompt(): string {
    const { settings, bots, activeBotId } = useStore.getState();
    const bot = bots.find((b) => b.id === activeBotId)!;
    // Memories are saved with the remember tool: a <remember> tag would be read out.
    const base = buildSystemPrompt(
      { ...bot, autoMemory: false },
      {
        userName: settings.userName,
        about: settings.about,
        customInstructions: settings.customInstructions,
        voice: settings.voice.concise ? true : "full",
        richBlocks: false,
      },
    );
    const computer = this.tools.some(isComputerTool) ? accessGuidance(settings.agent) : "";
    const screen = this.tools.some((t) => t.group === "mac" || t.controlsComputer);
    return [base, this.tools.length ? TOOL_GUIDANCE : "", computer, screen ? COMPUTER_GUIDANCE : "", LIVE_RULES].filter(Boolean).join("\n\n");
  }

  /** The end of the chat so far, as text turns (ending on a finished reply). */
  private history(): LiveSetup["history"] {
    const id = this.conversationId;
    const messages = id ? (useStore.getState().conversations[id]?.messages ?? []) : [];
    const turns = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("model" as const), text: stripMemoryTags(m.content).slice(0, 4000) }));
    while (turns.length && turns[0].role !== "user") turns.shift();
    while (turns.length && turns[turns.length - 1].role !== "model") turns.pop();
    return turns;
  }

  private makeConnection(setup: LiveSetup) {
    const options = {
      key: this.key,
      setup,
      onEvent: (event: LiveEvent) => this.onEvent(event),
      onClose: (info: { code: number; reason: string }) => {
        if (this.closed || this.connection !== connection) return;
        // Dropped mid-session: carry on where it was if the server gave us a way back.
        if (this.resumeHandle) void this.reconnect();
        else this.fail(closeReason(info.code, info.reason));
      },
    };
    const connection = this.deps.connect ? this.deps.connect(options) : new LiveConnection(options);
    return connection;
  }

  private async connect() {
    const connection = this.makeConnection(this.setup!);
    this.connection = connection;
    await connection.open();
  }

  /** The server is about to close (sessions are recycled every few minutes): reconnect where we were. */
  private async reconnect(attempt = 1) {
    if (this.closed || this.reconnecting || !this.setup) return;
    this.reconnecting = true;
    const old = this.connection;
    try {
      const next = this.makeConnection({ ...this.setup, resumeHandle: this.resumeHandle || undefined, history: this.resumeHandle ? undefined : this.history() });
      this.connection = next;
      await next.open();
      old?.close();
    } catch (error) {
      this.reconnecting = false;
      if (attempt >= 3) return this.fail((error as Error).message);
      setTimeout(() => void this.reconnect(attempt + 1), 1000 * attempt);
      return;
    }
    this.reconnecting = false;
  }

  private onEvent(event: LiveEvent) {
    if (this.closed) return;
    switch (event.type) {
      case "input":
        return this.onInput(event.text);
      case "output":
        return this.onOutput(event.text);
      case "audio":
        return this.onAudio(event.data, event.rate);
      case "interrupted":
        return this.onInterrupted();
      case "turnComplete":
        return this.onTurnComplete();
      case "toolCall":
        event.calls.forEach((call) => void this.runTool(call));
        return;
      case "toolCancel":
        event.ids.forEach((id) => this.running.get(id)?.abort());
        return;
      case "goAway":
        void this.reconnect();
        return;
      case "resume":
        this.resumeHandle = event.handle;
        return;
      case "error":
        this.set({ error: event.message });
        return;
    }
  }

  // The chat ---------------------------------------------------------------------------------

  private conversation(): string {
    const { activeConversationId } = useStore.getState();
    this.conversationId = activeConversationId ?? this.conversationId ?? newConversation(this.toolContext!.bot.id).id;
    return this.conversationId;
  }

  /** Adds a message at the end, or just before `before` (a reply already showing). */
  private addMessage(message: Message, before?: string) {
    const id = this.conversation();
    updateConversation(id, (c) => {
      const at = before ? c.messages.findIndex((m) => m.id === before) : -1;
      const messages = at >= 0 ? [...c.messages.slice(0, at), message, ...c.messages.slice(at)] : [...c.messages, message];
      return { ...c, messages, updatedAt: Date.now() };
    });
  }

  private patchMessage(messageId: string, patch: Partial<Message>) {
    if (!this.conversationId) return;
    updateConversation(this.conversationId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }));
  }

  /** The user's words so far this turn (Gemini transcribes them as they talk). */
  private userSaid(text: string) {
    if (!this.user) {
      this.user = { id: uid(), text: "" };
      // The reply started before the first of these words came through: they still go above it.
      const before = this.reply && !this.reply.withUser ? this.reply.id : undefined;
      if (this.reply) this.reply.withUser = true;
      this.addMessage({ id: this.user.id, role: "user", content: "", createdAt: Date.now() }, before);
      const conversation = useStore.getState().conversations[this.conversation()];
      if (conversation && conversation.messages.filter((m) => m.role === "user").length === 1) {
        this.titleWith = this.user.id;
      }
    }
    this.user.text = `${this.user.text}${text}`.replace(/\s+/g, " ").trimStart();
    const content = this.user.text.trim();
    this.patchMessage(this.user.id, { content });
    if (this.titleWith === this.user.id && this.conversationId) {
      updateConversation(this.conversationId, (c) => ({ ...c, title: titleFrom(content || "Voice chat") }));
    }
  }

  /** A new chat is named after the first thing said in it. */
  private titleWith = "";

  /** The reply being given now, started on its first words, sound or tool call. */
  private startReply(): Reply {
    if (this.reply) return this.reply;
    const conversationId = this.conversation();
    const id = uid();
    const runner = createToolRunner({
      tools: this.tools,
      context: { ...this.toolContext!, conversationId, turnId: id },
      onCalls: (toolCalls: ToolCallRecord[]) => this.patchMessage(id, { toolCalls }),
    });
    this.reply = { id, text: "", runner, startedAt: performance.now(), withUser: Boolean(this.user) };
    this.addMessage({ id, role: "assistant", content: "", model: this.setup?.model, createdAt: Date.now() });
    this.set({ reply: "", sentence: "", spokenChars: 0, latencyMs: null });
    return this.reply;
  }

  /** The exchange is over: a "goodbye" in it ends the session once the reply has been heard. */
  private endExchange() {
    const said = this.user?.text.trim();
    if (said && parseVoiceCommand(said, useStore.getState().bots)?.type === "end") this.ending = true;
    this.user = null;
    this.reply = null;
  }

  // Events -----------------------------------------------------------------------------------

  private onInput(text: string) {
    this.clearIdle();
    this.lastInputAt = performance.now();
    this.userSaid(text);
    if (this.approval) this.listenForAnswer(text);
    this.set({ phase: this.state.phase === "speaking" ? "speaking" : "hearing", partial: this.user?.text ?? "", heard: this.user?.text ?? "" });
  }

  private onOutput(text: string) {
    if (this.skipping) return;
    const reply = this.startReply();
    reply.text += text;
    const clean = reply.text.replace(/\s+/g, " ").trim();
    this.patchMessage(reply.id, { content: clean });
    this.set({ reply: clean, partial: "" });
  }

  private onAudio(data: string, rate: number) {
    if (this.skipping) return;
    const reply = this.startReply();
    if (this.state.phase !== "speaking") {
      // From the user's last words to the first sound of the answer.
      const latency = this.lastInputAt > reply.startedAt - 30_000 ? Math.round(performance.now() - this.lastInputAt) : null;
      this.set({ phase: "speaking", partial: "", ...(this.state.latencyMs === null && latency !== null ? { latencyMs: latency } : {}) });
    }
    this.player.push(pcm16Samples(data), rate);
  }

  private onInterrupted() {
    // The user talked over it: Gemini dropped the rest of the reply; so do we.
    this.player.flush();
    this.skipping = false;
    this.endExchange();
    this.set({ phase: "hearing" });
  }

  private onTurnComplete() {
    this.skipping = false;
    this.endExchange();
    void this.player.idle().then(() => {
      if (this.closed || this.reply || this.player.playing) return;
      if (this.ending) return this.close();
      if (this.state.phase !== "hearing" && this.state.phase !== "muted" && this.state.phase !== "standby" && !this.approval) {
        this.set({ phase: this.running.size ? "thinking" : "listening" });
      }
      this.armIdle();
    });
  }

  // Tools ------------------------------------------------------------------------------------

  private async runTool(call: LiveCall) {
    const reply = this.startReply();
    const own = new AbortController();
    this.running.set(call.id, own);
    this.clearIdle();
    this.set({ activity: activityFor(call.name), ...(this.state.phase === "listening" ? { phase: "thinking" as const } : {}) });
    const result = await reply.runner.run({ id: call.id, name: call.name, args: call.args }, own.signal);
    this.running.delete(call.id);
    if (!this.running.size) this.set({ activity: "", ...(this.state.phase === "thinking" ? { phase: "listening" as const } : {}) });
    if (this.closed || own.signal.aborted) return;
    if (result.image) this.connection?.sendImage(result.image.mediaType, result.image.data);
    const declined = Boolean(result.isError) && /^(The user declined|Refused)/.test(result.content);
    const content = result.content.length > RESULT_LIMIT ? `${result.content.slice(0, RESULT_LIMIT)}\n[…cut]` : result.content;
    this.connection?.sendToolResponses([
      {
        id: call.id,
        name: call.name,
        response: result.isError ? { status: declined ? "declined" : "error", retryable: !declined, message: content } : { status: "ok", output: content },
        // Said when the user isn't talking (Gemini 3.8 waits for them to finish).
        scheduling: "INTERRUPT",
      },
    ]);
    this.armIdle();
  }

  /**
   * A tool needs the user's OK: show it with Allow / Don't allow, have Gemini ask in its own voice,
   * and take the user's next "yes" or "no" (judged here, not by the model). No answer in a minute is no.
   */
  private askApproval(request: { summary: string; reason: string; signal: AbortSignal }): Promise<"allow" | "deny"> {
    if (this.closed) return Promise.resolve("deny");
    // Gemini called the same thing again while it waits (it heard the user's "yes" too): the
    // first call is the one that runs; this one is turned down.
    if (this.approval?.summary === request.summary) return Promise.resolve("deny");
    const asked = this.approvals.then(() => this.ask(request));
    this.approvals = asked.catch(() => undefined);
    return asked;
  }

  private ask({ summary, reason, signal }: { summary: string; reason: string; signal: AbortSignal }): Promise<"allow" | "deny"> {
    if (this.closed || signal.aborted) return Promise.resolve("deny");
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answerApproval("deny"), 60_000);
      const pending: Approval = { summary, resolve, timer, heard: "", pause: null };
      this.approval = pending;
      signal.addEventListener("abort", () => this.approval === pending && this.answerApproval("deny"), { once: true });
      this.clearIdle();
      this.set({ approval: { question: summary, reason } });
      const question = summary.replace(/ Say yes or no\.$/, "");
      this.connection?.sendText(
        `[ADT Bot, not the user] A tool you called needs the user's OK first. Ask them now in one short sentence: "${question}" Then wait: the app hears their yes or no and sends you the tool's result.`,
      );
    });
  }

  /** While a tool waits: the user's words, until a pause, as their answer. */
  private listenForAnswer(text: string) {
    const pending = this.approval;
    if (!pending) return;
    pending.heard += text;
    if (pending.pause) clearTimeout(pending.pause);
    pending.pause = setTimeout(() => {
      if (this.approval !== pending) return;
      const answer = yesOrNo(pending.heard);
      if (answer) this.answerApproval(answer);
      // Something else ("what will it send?"): Gemini answers it; keep waiting for yes or no.
      pending.heard = "";
    }, ANSWER_PAUSE_MS);
  }

  answerApproval(answer: "allow" | "deny") {
    const pending = this.approval;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.pause) clearTimeout(pending.pause);
    this.approval = null;
    if (!this.closed) this.set({ approval: null, activity: answer === "allow" ? this.state.activity : "Okay, skipping that." });
    pending.resolve(answer);
  }

  // Controls ---------------------------------------------------------------------------------

  /** The big button: interrupt, carry on after a pause, or retry. */
  tap() {
    const { phase } = this.state;
    if (phase === "speaking" || phase === "thinking") {
      this.player.flush();
      this.skipping = true;
      this.set({ phase: "listening" });
    } else if (phase === "standby" || phase === "muted") {
      this.resume();
    } else if (phase === "hearing") {
      // "Done talking": end the user's turn now instead of waiting for the pause.
      this.connection?.audioEnded();
    } else if (phase === "error") {
      this.retry();
    }
  }

  toggleMute() {
    if (this.state.phase === "muted") return this.resume();
    this.player.flush();
    this.skipping = true;
    this.pause("muted");
  }

  private pause(phase: "muted" | "standby") {
    this.clearIdle();
    this.paused = true;
    this.connection?.audioEnded();
    this.set({ phase, partial: "" });
  }

  private resume() {
    this.paused = false;
    chime("listen");
    this.set({ phase: "listening" });
    this.armIdle();
  }

  private armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.state.phase === "listening" && !this.running.size && !this.approval) this.pause("standby");
    }, IDLE_MS);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private retry() {
    this.release();
    this.closed = false;
    this.stopAll = new AbortController();
    this.resumeHandle = "";
    this.set({ error: null, phase: "loading" });
    void this.start();
  }

  /** Lets go of the microphone, the connection, sound and running tools. */
  private release() {
    this.clearIdle();
    this.answerApproval("deny");
    this.stopAll.abort();
    this.running.forEach((c) => c.abort());
    this.running.clear();
    this.player.flush();
    this.mic?.close();
    this.mic = null;
    this.connection?.close();
    this.connection = null;
    this.user = null;
    this.reply = null;
    this.approvals = Promise.resolve();
  }

  close(notify = true) {
    if (this.closed) return;
    this.release();
    this.closed = true;
    setVoiceApprover(null);
    setVoiceModeActive(false);
    if (notify) this.hooks.onClose();
  }

  private fail(message: string) {
    if (this.closed) return;
    chime("error");
    this.release();
    this.set({ phase: "error", error: message });
  }
}
