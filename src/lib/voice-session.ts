import { sendMessage, setVoiceModeActive, stopStreaming, stripMemoryTags } from "./chat";
import { splitThink } from "./llm";
import { selectBot, startNewChat, updateSettings, useStore } from "./store";
import { localVoiceReady } from "./local-tts";
import { chime, createSpeaker, duckSpeech, type Speaker, takeSentences } from "./tts";
import { END_SILENCE_MS, type Engine, ENGINE_LABELS, listen, type ListenSession, resolveEngine, stopReadAloud, transcribe } from "./voice";
import { isEcho, isLikelyHallucination, isSubstantial, matchWakeWord, parseVoiceCommand } from "./voice-commands";
import { Listener, type ListenerEvent, onWhisperProgress, toWav } from "./whisper";

/** What the bot is doing during a tool step, for the voice screen. */
function activityFor(tool: string): string {
  const known: Record<string, string> = {
    mac_screenshot: "Looking at the screen",
    mac_click: "Clicking",
    mac_type: "Typing",
    mac_key: "Pressing keys",
    mac_scroll: "Scrolling",
    mac_drag: "Dragging",
    mac_open_app: "Opening an app",
    mac_list_apps: "Checking open apps",
    mac_applescript: "Running a script",
    run_command: "Running a command",
    read_file: "Reading a file",
    write_file: "Saving a file",
    list_files: "Looking at files",
    open_on_computer: "Opening it",
    web_search: "Searching the web",
    read_url: "Reading a page",
    ask_bot: "Asking another bot",
  };
  return `${known[tool] ?? "Working"}…`;
}

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
  /** How much of `sentence` has been spoken, in characters (word-by-word captions). */
  spokenChars: number;
  /** What the bot is doing between tool steps ("Clicking…"), while it works silently. */
  activity: string;
  error: string | null;
  download: number | null;
  /** Time from the end of the user's turn to the first spoken word. */
  latencyMs: number | null;
  /** Where that time went: speech-to-text, waiting for the model's first words, and starting speech. */
  timing: { turn: number; stt: number; model: number; speech: number } | null;
  engineLabel: string;
  wakeName: string;
};

const IDLE_TO_STANDBY_MS = 60_000;
/** Sound starting this soon after the bot stopped talking is checked for being its echo. */
const ECHO_TAIL_MS = 450;
/** While tools work silently, say "Still working on it" after this long without speaking. */
const STILL_WORKING_MS = 8000;

/** Resolves once no reply is streaming (sendMessage ignores new messages until then). */
function streamStopped(timeoutMs = 5000): Promise<void> {
  if (!useStore.getState().streamingId) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = useStore.subscribe((s) => !s.streamingId && done());
  });
}

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
  /** Silence waited before the turn was judged over (Smart Turn / the end-of-turn setting). */
  private turnMs = 0;
  private offProgress: (() => void) | null = null;
  /** The current speech segment began while the bot was talking, so it may be the bot's own voice. */
  private segmentDuringSpeech = false;
  /** What the bot said last, to recognise its echo arriving just after it stops. */
  private lastSpoken = "";
  /** When the bot last stopped speaking: sound right after it may be its echo (room, Bluetooth delay). */
  private speechEndedAt = 0;
  /** The user may be cutting in: the bot's voice is turned down until we know (see "speech"). */
  private ducked = false;

  constructor(private hooks: { onState: (state: VoiceState) => void; onClose: () => void; initialRequest?: string }) {
    const { settings, providers } = useStore.getState();
    this.engine = resolveEngine(settings.voice, providers);
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
      engineLabel: ENGINE_LABELS[this.engine],
      wakeName: this.wakeNames()[0] ?? "ADT",
    };
  }

  private set(patch: Partial<VoiceState>) {
    if (this.closed) return;
    // Live captions cost a Whisper run each, so they only run while the user is the one talking.
    if (patch.phase && patch.phase !== this.state.phase) this.listener?.setPartials(patch.phase === "listening" || patch.phase === "hearing");
    this.state = { ...this.state, ...patch };
    this.hooks.onState(this.state);
  }

  /**
   * Microphone loudness, 0–1. Read every animation frame by the orb rather than kept in the state,
   * which would re-render the whole screen ~16 times a second.
   */
  private micLevel = 0;
  inputLevel(): number {
    const phase = this.state.phase;
    return phase === "listening" || phase === "hearing" || phase === "standby" ? this.micLevel : 0;
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
    stopReadAloud();
    // Retrying after an error: release the previous microphone first.
    this.listener?.close();
    this.listener = null;
    this.offProgress?.();
    this.offProgress = onWhisperProgress((p) => this.set({ download: p ? Math.round(p.progress) : null }));
    try {
      if (this.usesVad) {
        const { voice } = this.context();
        const listener = await Listener.open({
          mode: this.engine === "whisper-cloud" ? "cloud" : "local",
          size: voice.localModel,
          endSilenceMs: END_SILENCE_MS[voice.endSilence],
          partials: true,
          onEvent: (event) => void this.onListenerEvent(event),
        });
        // Closed while getting ready: don't leave the microphone on.
        if (this.closed) {
          listener.close();
          return;
        }
        this.listener = listener;
      }
    } catch (error) {
      this.fail((error as Error).message);
      return;
    }
    if (this.closed) return;
    // Then the on-device voice (after the speech model, so the two don't load at once on a small
    // Mac); until it's ready, replies use the device voice.
    const { voice } = this.context();
    if (voice.tts === "local") localVoiceReady(voice.localVoice);
    chime("listen");
    if (this.hooks.initialRequest?.trim()) void this.process(this.hooks.initialRequest.trim());
    else this.enterListening();
  }

  /** Ends the session. `notify: false` when the UI is already going away (unmount). */
  close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.offProgress?.();
    this.listener?.close();
    this.device?.cancel();
    this.speaker?.stop();
    // Speech turned down for a cut-in must not stay quiet for read-aloud or the next session.
    this.ducked = false;
    duckSpeech(false);
    setVoiceModeActive(false);
    if (notify) this.hooks.onClose();
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
      this.micLevel = 0;
      this.set({ phase: "muted", partial: "" });
    }
  }

  // Listening -----------------------------------------------------------------

  private enterListening() {
    if (this.closed) return;
    this.unduck();
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
      this.micLevel = event.level;
      return;
    }
    if (event.type === "start") {
      this.clearIdle();
      this.segmentDuringSpeech = phase === "speaking" || phase === "thinking" || performance.now() - this.speechEndedAt < ECHO_TAIL_MS;
      if (phase === "listening") this.set({ phase: "hearing", partial: "" });
      return;
    }
    if (event.type === "speech") {
      // A quarter second of clear speech (not a cough or click): the user may be cutting in.
      if (phase === "speaking" && this.bargeMode() === "instant") {
        if (this.speaker?.inPageAudio) {
          // Turn the bot right down now; stop it once the words show it isn't our own echo.
          this.ducked = true;
          duckSpeech(true);
        } else {
          // The device voice can't be turned down: stop it (its echo is still checked below).
          this.interrupt();
          this.set({ phase: "hearing", partial: "" });
        }
      }
      return;
    }
    if (event.type === "discard") {
      this.unduck();
      // Too short to be speech: back to listening rather than showing "Listening…" forever.
      if (phase === "hearing") this.enterListening();
      return;
    }
    if (event.type === "silent") {
      this.fail(event.message);
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
      this.turnMs = event.waitMs ?? 0;
      this.endOfSpeechAt = performance.now() - (event.ms ?? 0) - this.turnMs;
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
        this.turnMs = 0;
        this.endOfSpeechAt = performance.now();
        // Runs the whole turn, including speaking; the loop then keeps listening.
        await this.onUtterance(text);
      }
    } finally {
      this.deviceLooping = false;
    }
  }

  private unduck() {
    if (!this.ducked) return;
    this.ducked = false;
    duckSpeech(false);
  }

  private async onUtterance(text: string) {
    const { phase } = this.state;
    const duringSpeech = this.segmentDuringSpeech;
    this.segmentDuringSpeech = false;
    if (!text || isLikelyHallucination(text)) {
      this.unduck();
      if (phase === "hearing") this.enterListening();
      return;
    }
    // Started while the bot was talking but finished after it stopped: drop it if it's the bot's own voice.
    if (duringSpeech && (phase === "listening" || phase === "hearing") && isEcho(text, this.lastSpoken)) {
      if (phase === "hearing") this.enterListening();
      return;
    }
    // While the bot thinks or talks, only a command ("stop") or a real sentence cuts in;
    // a stray word is usually noise, echo or Whisper guessing.
    if ((phase === "speaking" || phase === "thinking") && !isSubstantial(text) && !parseVoiceCommand(text, useStore.getState().bots)) {
      this.unduck();
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
      if (this.bargeMode() === "off" || isEcho(text, this.speaker?.spoken ?? "")) {
        this.unduck();
        return;
      }
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
        if (await this.say(`Okay. Say "hey ${this.wakeNames()[0] ?? "ADT"}" when you need me.`)) this.enterStandby();
        return;
      case "newChat": {
        const id = useStore.getState().activeBotId;
        if (id) startNewChat(id);
        if (await this.say("Okay, new chat.")) this.enterListening();
        return;
      }
      case "switchBot": {
        selectBot(command.botId);
        const bot = useStore.getState().bots.find((b) => b.id === command.botId);
        if (await this.say(`Switched to ${bot?.nickname || bot?.name}.`)) this.enterListening();
        return;
      }
      case "repeat":
        if (await this.say(this.lastReply || "I haven't said anything yet.")) this.enterListening();
        return;
      case "slower":
      case "faster": {
        const { voice } = this.context();
        const rate = Math.min(1.8, Math.max(0.6, voice.rate + (command.type === "faster" ? 0.15 : -0.15)));
        updateSettings({ voice: { ...voice, rate: Math.round(rate * 100) / 100 } });
        if (await this.say(command.type === "faster" ? "Okay, faster." : "Okay, slower.")) this.enterListening();
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

  /** Speaks a short line (acknowledgements, commands). False when the user cut in meanwhile. */
  private async say(text: string): Promise<boolean> {
    const turn = ++this.turn;
    this.clearIdle();
    this.unduck();
    const speaker = createSpeaker(this.context(), { onError: (message) => this.set({ error: message }) });
    this.speaker = speaker;
    this.set({ phase: "speaking", sentence: text, spokenChars: 0, error: null });
    speaker.say(text);
    await speaker.idle();
    this.lastSpoken = speaker.spoken;
    this.speechEndedAt = performance.now();
    return turn === this.turn && !this.closed;
  }

  private async ask(text: string, options: { search?: boolean; imagine?: boolean } = {}) {
    const turn = ++this.turn;
    this.clearIdle();
    this.unduck();
    this.listener?.setSensitivity("strict");
    this.set({ phase: "thinking", reply: "", sentence: "", spokenChars: 0, activity: "", latencyMs: null, timing: null, error: null });
    const startedAt = Date.now();
    const askedAt = performance.now();
    let firstTextAt = 0;
    let spokenAny = false;
    /** Last time the bot made a sound in this turn (for "Still working on it"). */
    let lastSoundAt = performance.now();
    const speaker = createSpeaker(this.context(), {
      onSentence: (sentence) => {
        if (turn !== this.turn) return;
        lastSoundAt = performance.now();
        if (!spokenAny) {
          spokenAny = true;
          const now = performance.now();
          this.set({
            latencyMs: Math.round(now - this.endOfSpeechAt),
            timing: {
              turn: Math.round(this.turnMs),
              stt: Math.round(askedAt - this.endOfSpeechAt - this.turnMs),
              model: Math.round((firstTextAt || now) - askedAt),
              speech: Math.round(now - (firstTextAt || now)),
            },
          });
        }
        this.set({ phase: "speaking", sentence, spokenChars: 0 });
      },
      onProgress: (chars) => {
        lastSoundAt = performance.now();
        if (turn === this.turn && chars !== this.state.spokenChars) this.set({ spokenChars: chars });
      },
      onError: (message) => this.set({ error: message }),
    });
    this.speaker = speaker;

    const latest = () => {
      const s = useStore.getState();
      const last = s.activeConversationId ? s.conversations[s.activeConversationId]?.messages.at(-1) : undefined;
      return last?.role === "assistant" && last.createdAt >= startedAt ? last : undefined;
    };

    // The reply is spoken step by step. Text written before a tool call is narration ("First I'll
    // open WhatsApp…"): only the opening line of the first step is spoken. Later sentences are held
    // back until it's clear they're the answer (more than a short preamble, or the reply ended),
    // and dropped if a tool call follows them.
    const HOLD = 2;
    let steps = 0;
    let regionStart = 0;
    let consumed = 0;
    let buffer = "";
    let held: string[] = [];
    let released = false;
    let opened = false;
    const speak = (sentence: string) => {
      lastSoundAt = performance.now();
      speaker.say(sentence);
    };
    const release = () => {
      released = true;
      held.forEach(speak);
      held = [];
    };
    const feed = (final: boolean) => {
      if (turn !== this.turn) return;
      const message = latest();
      if (!message) return;
      const calls = message.toolCalls ?? [];
      if (calls.length !== steps) {
        // A tool step: what was written before it was narration. The answer comes after the last step.
        steps = calls.length;
        held = [];
        buffer = "";
        consumed = 0;
        released = false;
        regionStart = message.narrationEnd ?? message.content.length;
      }
      const running = calls.find((c) => c.status === "running" || c.status === "pending" || c.status === "awaiting");
      const activity = running ? activityFor(running.name) : "";
      if (activity !== this.state.activity) this.set({ activity });
      if (steps && this.state.phase === "speaking" && !speaker.speaking) this.set({ phase: "thinking" });
      const visible = stripMemoryTags(splitThink(message.content.slice(regionStart)).text);
      if (visible && !firstTextAt) firstTextAt = performance.now();
      if (visible !== this.state.reply) this.set({ reply: visible });
      if (visible.length > consumed) buffer += visible.slice(consumed);
      consumed = visible.length;
      const opening = !steps && !opened;
      const { sentences, rest } = takeSentences(buffer, final, opening);
      buffer = rest;
      for (const sentence of sentences) {
        if (!steps && !opened) {
          opened = true;
          speak(sentence);
        } else if (released) {
          speak(sentence);
        } else {
          held.push(sentence);
          if (held.length > HOLD) release();
        }
      }
      if (final) release();
    };

    // While tools work silently, let the user know the bot is still on it (at most twice).
    let reminders = 0;
    const ticker = setInterval(() => {
      if (turn !== this.turn || this.closed) return;
      if (steps && this.state.phase === "speaking" && !speaker.speaking) this.set({ phase: "thinking" });
      if (steps && this.state.phase === "thinking" && !speaker.speaking && reminders < 2 && performance.now() - lastSoundAt > STILL_WORKING_MS) {
        reminders++;
        speak(reminders === 1 ? "Still working on it." : "Almost there.");
      }
    }, 1000);

    // After a barge-in the previous reply may still be winding down; wait so this question isn't dropped.
    await streamStopped();
    if (useStore.getState().streamingId) {
      stopStreaming();
      await streamStopped(10_000);
    }
    if (turn !== this.turn || this.closed) return clearInterval(ticker);
    const unsubscribe = useStore.subscribe(() => feed(false));
    const modes = useStore.getState().settings.modes;
    try {
      await sendMessage(text, [], { search: options.search ?? modes.search, think: modes.think, imagine: options.imagine, voice: true });
    } finally {
      unsubscribe();
      clearInterval(ticker);
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
    this.lastSpoken = speaker.spoken;
    this.speechEndedAt = performance.now();
    if (turn !== this.turn || this.closed) return;
    this.lastReply = this.state.reply;
    this.enterListening();
  }

  private interrupt() {
    this.turn++;
    if (this.speaker) {
      this.lastSpoken = this.speaker.spoken;
      if (this.speaker.speaking) this.speechEndedAt = performance.now();
    }
    this.speaker?.stop();
    this.speaker = null;
    this.unduck();
    if (useStore.getState().streamingId) stopStreaming();
  }

  private fail(message: string) {
    if (this.closed) return;
    chime("error");
    // Stop listening while the error shows; tapping starts again.
    this.interrupt();
    this.clearIdle();
    this.listener?.close();
    this.listener = null;
    this.device?.cancel();
    this.micLevel = 0;
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
      const listener = await Listener.open({
        mode: "local",
        size: settings.voice.localModel,
        endSilenceMs: 600,
        partials: false,
        onEvent: (event) => {
          if (event.type === "utterance" && event.text) this.check(event.text);
        },
      });
      // Stopped while the microphone was opening.
      if (this.stopped) listener.close();
      else this.listener = listener;
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
