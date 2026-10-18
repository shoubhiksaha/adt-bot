import { sendMessage, setVoiceModeActive, stopStreaming, stripMemoryTags } from "./chat";
import { splitThink } from "./llm";
import { selectBot, startNewChat, updateSettings, useStore } from "./store";
import { chime, createSpeaker, type Speaker, takeSentences } from "./tts";
import { END_SILENCE_MS, type Engine, ENGINE_LABELS, listen, type ListenSession, resolveEngine, transcribe } from "./voice";
import { isEcho, matchWakeWord, parseVoiceCommand } from "./voice-commands";
import { Listener, type ListenerEvent, onWhisperProgress, toWav } from "./whisper";

export type VoicePhase = "loading" | "listening" | "hearing" | "thinking" | "speaking" | "standby" | "muted" | "error";

export type VoiceState = {
  phase: VoicePhase;
  /** Live caption of what the user is saying. */
  partial: string;
  /** The last thing the user said. */
  heard: string;
  /** The reply so far, and the sentence being spoken. */
  reply: string;
  sentence: string;
  level: number;
  error: string | null;
  download: number | null;
  /** Time from the end of the user's turn to the first spoken word. */
  latencyMs: number | null;
  /** Where that time went: speech-to-text, waiting for the model's first words, and starting speech. */
  timing: { stt: number; model: number; speech: number } | null;
  engineLabel: string;
  wakeName: string;
};

const IDLE_TO_STANDBY_MS = 25_000;

/**
 * A hands-free voice conversation: listens continuously, detects turns, handles spoken commands
 * and the wake word, streams answers sentence by sentence into speech, and lets the user cut in.
 */
export class VoiceSession {
  state: VoiceState;
  private engine: Engine;
  private listener: Listener | null = null;
  private device: ListenSession | null = null;
  private speaker: Speaker | null = null;
  private closed = false;
  private turn = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReply = "";
  private endOfSpeechAt = 0;
  private sttMs = 0;
  private offProgress: (() => void) | null = null;

  constructor(private hooks: { onState: (state: VoiceState) => void; onClose: () => void; initialRequest?: string }) {
    const { settings, providers } = useStore.getState();
    this.engine = resolveEngine(settings.voice, providers);
    this.state = {
      phase: "loading",
      partial: "",
      heard: "",
      reply: "",
      sentence: "",
      level: 0,
      error: null,
      download: null,
      latencyMs: null,
      timing: null,
      engineLabel: ENGINE_LABELS[this.engine],
      wakeName: this.wakeNames()[0] ?? "ADT",
    };
  }

  private set(patch: Partial<VoiceState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.hooks.onState(this.state);
  }

  /** Current phase (a method, so checks after an await aren't narrowed away by TypeScript). */
  private phase(): VoicePhase {
    return this.state.phase;
  }

  private get usesVad() {
    return this.engine === "whisper-local" || this.engine === "whisper-cloud";
  }

  private context() {
    const { settings, providers } = useStore.getState();
    return { voice: settings.voice, providers, useProxy: settings.useProxy };
  }

  /** Names that wake the session: every bot's nickname and name, the active bot first. */
  private wakeNames(): string[] {
    const { bots, activeBotId } = useStore.getState();
    const ordered = [...bots].sort((a, b) => Number(b.id === activeBotId) - Number(a.id === activeBotId));
    return ordered.flatMap((b) => [b.nickname?.trim(), b.name]).filter((n): n is string => Boolean(n));
  }

  async start() {
    setVoiceModeActive(true);
    this.offProgress = onWhisperProgress((p) => this.set({ download: p ? Math.round(p.progress) : null }));
    try {
      if (this.usesVad) {
        const { voice } = this.context();
        this.listener = await Listener.open({
          mode: this.engine === "whisper-cloud" ? "cloud" : "local",
          size: voice.localModel,
          endSilenceMs: END_SILENCE_MS[voice.endSilence],
          partials: true,
          onEvent: (event) => void this.onListenerEvent(event),
        });
      }
    } catch (error) {
      this.fail((error as Error).message);
      return;
    }
    if (this.closed) return;
    chime("listen");
    if (this.hooks.initialRequest?.trim()) void this.process(this.hooks.initialRequest.trim());
    else this.enterListening();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.offProgress?.();
    this.listener?.close();
    this.device?.cancel();
    this.speaker?.stop();
    setVoiceModeActive(false);
    this.hooks.onClose();
  }

  /** The big button: finish talking, interrupt, or wake up, depending on the moment. */
  tap() {
    const { phase } = this.state;
    if (phase === "listening" || phase === "hearing") {
      if (this.usesVad) this.listener?.flush();
      else this.device?.stop();
    } else if (phase === "thinking" || phase === "speaking") {
      this.interrupt();
      this.enterListening();
    } else if (phase === "standby" || phase === "muted") {
      this.listener?.setMuted(false);
      chime("listen");
      this.enterListening();
    } else if (phase === "error") {
      this.set({ error: null });
      void this.start();
    }
  }

  toggleMute() {
    if (this.state.phase === "muted") {
      this.listener?.setMuted(false);
      this.enterListening();
    } else {
      this.interrupt();
      this.clearIdle();
      this.device?.cancel();
      this.listener?.setMuted(true);
      this.set({ phase: "muted", partial: "", level: 0 });
    }
  }

  // Listening -----------------------------------------------------------------

  private enterListening() {
    if (this.closed) return;
    this.listener?.setSensitivity("normal");
    this.set({ phase: "listening", partial: "", sentence: "" });
    this.armIdle();
    if (!this.usesVad) void this.deviceLoop();
  }

  private enterStandby() {
    if (this.closed) return;
    this.clearIdle();
    this.set({ phase: "standby", partial: "", sentence: "", wakeName: this.wakeNames()[0] ?? "ADT" });
    if (!this.usesVad) void this.deviceLoop();
  }

  private armIdle() {
    this.clearIdle();
    const { voice } = this.context();
    if (!voice.wakeWord) return;
    this.idleTimer = setTimeout(() => {
      if (this.state.phase === "listening") this.enterStandby();
    }, IDLE_TO_STANDBY_MS);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async onListenerEvent(event: ListenerEvent) {
    if (this.closed) return;
    const { phase } = this.state;
    if (event.type === "level") {
      if (phase === "listening" || phase === "hearing" || phase === "standby") this.set({ level: event.level });
      return;
    }
    if (event.type === "start") {
      this.clearIdle();
      if (phase === "speaking" && this.bargeMode() === "instant") {
        this.interrupt();
        this.set({ phase: "hearing", partial: "" });
      } else if (phase === "listening") {
        this.set({ phase: "hearing", partial: "" });
      }
      return;
    }
    if (event.type === "partial") {
      if (this.state.phase === "hearing") this.set({ partial: event.text });
      return;
    }
    if (event.type === "error") {
      this.fail(event.message);
      return;
    }
    if (event.type === "utterance") {
      this.endOfSpeechAt = performance.now() - (event.ms ?? 0);
      this.sttMs = event.ms ?? 0;
      let text = event.text ?? "";
      if (event.audio) {
        const { voice, providers, useProxy } = this.context();
        const provider = providers.find((p) => p.id === voice.providerId);
        if (!provider) return;
        try {
          text = await transcribe(toWav(event.audio), provider, voice.model, useProxy);
        } catch (error) {
          this.fail((error as Error).message);
          return;
        }
      }
      await this.onUtterance(text.trim());
    }
  }

  /** Device recognizers (browser, Android) listen one turn at a time. */
  private deviceLooping = false;
  private async deviceLoop() {
    if (this.deviceLooping) return;
    this.deviceLooping = true;
    let empty = 0;
    try {
      while (!this.closed && (this.state.phase === "listening" || this.state.phase === "standby")) {
        let text = "";
        try {
          this.device = await listen(
            this.engine,
            {
              autoStop: true,
              onPartial: (partial) => {
                this.clearIdle();
                if (this.state.phase === "listening") this.set({ phase: "hearing" });
                if (this.state.phase === "hearing") this.set({ partial });
              },
            },
            this.context(),
          );
          text = (await this.device.result).trim();
        } catch (error) {
          this.fail((error as Error).message);
          return;
        } finally {
          this.device = null;
        }
        if (this.closed || this.phase() === "muted") return;
        if (!text) {
          if (this.phase() === "hearing") this.set({ phase: "listening" });
          if (++empty >= 3 && this.context().voice.wakeWord && this.state.phase === "listening") this.enterStandby();
          continue;
        }
        empty = 0;
        this.endOfSpeechAt = performance.now();
        // Runs the whole turn, including speaking; the loop then keeps listening.
        await this.onUtterance(text);
      }
    } finally {
      this.deviceLooping = false;
    }
  }

  private async onUtterance(text: string) {
    const { phase } = this.state;
    if (!text) {
      if (phase === "hearing") this.enterListening();
      return;
    }
    if (phase === "standby") {
      const wake = this.matchWake(text);
      if (!wake) return;
      chime("wake");
      if (wake.rest) await this.process(wake.rest);
      else this.enterListening();
      return;
    }
    if (phase === "speaking") {
      // Heard during our own speech: ignore it if it's just our voice coming back.
      if (this.bargeMode() === "off" || isEcho(text, this.speaker?.spoken ?? "")) return;
      this.interrupt();
    } else if (phase === "thinking") {
      this.interrupt();
    } else if (phase === "muted") {
      return;
    }
    await this.process(text);
  }

  private matchWake(text: string): { rest: string } | null {
    const { bots, activeBotId } = useStore.getState();
    for (const bot of [...bots].sort((a, b) => Number(b.id === activeBotId) - Number(a.id === activeBotId))) {
      const names = [bot.nickname?.trim(), bot.name].filter((n): n is string => Boolean(n));
      const wake = matchWakeWord(text, names);
      if (wake.woke) {
        if (bot.id !== activeBotId) selectBot(bot.id);
        return { rest: wake.rest };
      }
    }
    return null;
  }

  /** "instant": cut in as soon as speech starts (natural voices, echo-cancelled). "checked": after hearing it isn't our echo. */
  private bargeMode(): "instant" | "checked" | "off" {
    const { voice } = this.context();
    if (voice.bargeIn === "off") return "off";
    if (voice.bargeIn === "on") return "instant";
    return this.speaker?.inPageAudio ? "instant" : "checked";
  }

  // Answering ---------------------------------------------------------------------

  private async process(text: string) {
    const { bots } = useStore.getState();
    const command = parseVoiceCommand(text, bots);
    this.set({ heard: text, partial: "" });
    switch (command?.type) {
      case "stop":
        this.interrupt();
        this.enterListening();
        return;
      case "end":
        await this.say("Bye for now.");
        this.close();
        return;
      case "standby":
        await this.say(`Okay. Say "hey ${this.wakeNames()[0] ?? "ADT"}" when you need me.`);
        this.enterStandby();
        return;
      case "newChat": {
        const id = useStore.getState().activeBotId;
        if (id) startNewChat(id);
        await this.say("Okay, new chat.");
        this.enterListening();
        return;
      }
      case "switchBot": {
        selectBot(command.botId);
        const bot = useStore.getState().bots.find((b) => b.id === command.botId);
        await this.say(`Switched to ${bot?.nickname || bot?.name}.`);
        this.enterListening();
        return;
      }
      case "repeat":
        await this.say(this.lastReply || "I haven't said anything yet.");
        this.enterListening();
        return;
      case "slower":
      case "faster": {
        const { voice } = this.context();
        const rate = Math.min(1.8, Math.max(0.6, voice.rate + (command.type === "faster" ? 0.15 : -0.15)));
        updateSettings({ voice: { ...voice, rate: Math.round(rate * 100) / 100 } });
        await this.say(command.type === "faster" ? "Okay, faster." : "Okay, slower.");
        this.enterListening();
        return;
      }
      case "search":
        await this.ask(command.query, { search: true });
        return;
      case "imagine":
        await this.ask(command.prompt, { imagine: true });
        return;
      default:
        await this.ask(text);
    }
  }

  /** Speaks a short line (acknowledgements, commands). */
  private async say(text: string) {
    this.clearIdle();
    const speaker = createSpeaker(this.context());
    this.speaker = speaker;
    this.set({ phase: "speaking", sentence: text });
    speaker.say(text);
    await speaker.idle();
  }

  private async ask(text: string, options: { search?: boolean; imagine?: boolean } = {}) {
    const turn = ++this.turn;
    this.clearIdle();
    this.listener?.setSensitivity("strict");
    this.set({ phase: "thinking", reply: "", sentence: "", latencyMs: null, timing: null });
    const startedAt = Date.now();
    const askedAt = performance.now();
    let firstTextAt = 0;
    let spokenAny = false;
    const speaker = createSpeaker(this.context(), {
      onSentence: (sentence) => {
        if (turn !== this.turn) return;
        if (!spokenAny) {
          spokenAny = true;
          const now = performance.now();
          this.set({
            latencyMs: Math.round(now - this.endOfSpeechAt),
            timing: {
              stt: Math.round(this.sttMs + (askedAt - this.endOfSpeechAt - this.sttMs)),
              model: Math.round((firstTextAt || now) - askedAt),
              speech: Math.round(now - (firstTextAt || now)),
            },
          });
        }
        this.set({ phase: "speaking", sentence });
      },
      onError: (message) => this.set({ error: message }),
    });
    this.speaker = speaker;

    let consumed = 0;
    let buffer = "";
    let first = true;
    const latest = () => {
      const s = useStore.getState();
      const last = s.activeConversationId ? s.conversations[s.activeConversationId]?.messages.at(-1) : undefined;
      return last?.role === "assistant" && last.createdAt >= startedAt ? last : undefined;
    };
    const feed = (final: boolean) => {
      if (turn !== this.turn) return;
      const message = latest();
      if (!message) return;
      const visible = stripMemoryTags(splitThink(message.content).text);
      if (visible && !firstTextAt) firstTextAt = performance.now();
      if (visible !== this.state.reply) this.set({ reply: visible });
      if (visible.length > consumed) {
        buffer += visible.slice(consumed);
        consumed = visible.length;
      }
      const { sentences, rest } = takeSentences(buffer, final, first);
      buffer = rest;
      for (const sentence of sentences) {
        first = false;
        speaker.say(sentence);
      }
    };

    const unsubscribe = useStore.subscribe(() => feed(false));
    const modes = useStore.getState().settings.modes;
    try {
      await sendMessage(text, [], { search: options.search ?? modes.search, think: modes.think, imagine: options.imagine, voice: true });
    } finally {
      unsubscribe();
    }
    if (turn !== this.turn) return;
    feed(true);
    const message = latest();
    if (message?.attachments?.some((a) => a.kind === "image")) speaker.say("Here's your image. It's in the chat.");
    if (message?.error) {
      speaker.say(`Sorry, that didn't work. ${message.error.split(/[.:]/)[0]}.`);
      chime("error");
    }
    await speaker.idle();
    if (turn !== this.turn || this.closed) return;
    this.lastReply = this.state.reply;
    this.enterListening();
  }

  private interrupt() {
    this.turn++;
    this.speaker?.stop();
    this.speaker = null;
    if (useStore.getState().streamingId) stopStreaming();
  }

  private fail(message: string) {
    chime("error");
    this.set({ phase: "error", error: message });
  }
}

/**
 * Hands-free: while the app is open (and voice mode isn't), listen for "Hey <nickname>" and open
 * voice mode with whatever followed. Only runs when the user has turned it on.
 */
export class WakeWatcher {
  private listener: Listener | null = null;
  private device: ListenSession | null = null;
  private stopped = false;

  constructor(private onWake: (request: string) => void) {}

  async start() {
    const { settings, providers } = useStore.getState();
    const engine = resolveEngine(settings.voice, providers);
    if (engine === "whisper-local" || engine === "whisper-cloud") {
      this.listener = await Listener.open({
        mode: "local",
        size: settings.voice.localModel,
        endSilenceMs: 600,
        partials: false,
        onEvent: (event) => {
          if (event.type === "utterance" && event.text) this.check(event.text);
        },
      });
      return;
    }
    while (!this.stopped) {
      try {
        this.device = await listen(engine, { autoStop: true }, { voice: settings.voice, providers, useProxy: settings.useProxy });
        const text = await this.device.result;
        if (text) this.check(text);
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private check(text: string) {
    const { bots, activeBotId } = useStore.getState();
    for (const bot of [...bots].sort((a, b) => Number(b.id === activeBotId) - Number(a.id === activeBotId))) {
      const wake = matchWakeWord(text, [bot.nickname?.trim(), bot.name].filter((n): n is string => Boolean(n)));
      if (wake.woke) {
        if (bot.id !== activeBotId) selectBot(bot.id);
        chime("wake");
        this.onWake(wake.rest);
        return;
      }
    }
  }

  stop() {
    this.stopped = true;
    this.listener?.close();
    this.device?.cancel();
  }
}
