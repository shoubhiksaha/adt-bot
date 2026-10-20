import { type EarlyReply, sendMessage, setVoiceApprover, setVoiceModeActive, startEarlyReply, stopStreaming, stripMemoryTags } from "./chat";
import { activityFor } from "./agent/asks";
import { splitThink } from "./llm";
import { selectBot, startNewChat, updateSettings, useStore } from "./store";
import { localChoice, localVoiceReady } from "./local-tts";
import { chime, createSpeaker, duckSpeech, type Speaker, takeSentences, warmDeviceVoice } from "./tts";
import { END_SILENCE_MS, type Engine, ENGINE_LABELS, listen, type ListenSession, resolveEngine, stopReadAloud, transcribe } from "./voice";
import {
  echoesLastWords,
  endsWithStop,
  isLikelyHallucination,
  isSubstantial,
  matchWakeWord,
  normalize,
  parseVoiceCommand,
  soundsLikeUser,
  userPart,
  yesOrNo,
} from "./voice-commands";
import { Listener, type ListenerEvent, localSpeechModel, onWhisperProgress, SPEECH_MODELS, toWav } from "./whisper";


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
  /**
   * Where that time went: speech-to-text, waiting for the model's first words, and starting speech.
   * `early`: how much of the model's wait was saved by starting the reply before the turn was over.
   */
  timing: { turn: number; stt: number; model: number; speech: number; early?: number } | null;
  engineLabel: string;
  wakeName: string;
  /** A tool waiting for the user's OK, asked aloud (answer by voice or with the buttons). */
  approval: { question: string; reason: string } | null;
  /** Gemini Live is talking, not the app's own speech pipeline. */
  live?: boolean;
};

const IDLE_TO_STANDBY_MS = 60_000;
/** Sound starting this soon after the bot stopped talking is checked for being its echo. */
const ECHO_TAIL_MS = 450;
/** Sound starting this soon after the bot's voice really ended is checked for being its last words. */
const LATE_ECHO_MS = 2000;
/** While tools work silently, say "Still working on it" after this long without speaking. */
const STILL_WORKING_MS = 8000;

/** The same words, ignoring case and punctuation (an early reply is kept only for what was finally heard). */
const sameWords = (a: string, b: string) => normalize(a) === normalize(b);

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
  /** When the sound being transcribed started (to tell a late echo from a reply). */
  private segmentStartedAt = 0;
  /** What the bot said last, to recognise its echo arriving just after it stops. */
  private lastSpoken = "";
  /** When the bot last stopped speaking: sound right after it may be its echo (room, Bluetooth delay). */
  private speechEndedAt = -Infinity;
  /** The user may be cutting in: the bot's voice is turned down until we know (see "speech"). */
  private ducked = false;
  /** A reply started during a pause that probably ended the turn; kept if the turn ends with the same words. */
  private early: EarlyReply | null = null;
  /** The question a tool is waiting on (see askApproval). */
  private approval: { resolve: (answer: "allow" | "deny") => void; timer: ReturnType<typeof setTimeout> } | null = null;
  /** When the user last answered one (a tool asking isn't silence worth a "Still working on it"). */
  private approvalEndedAt = 0;

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
      // Name the on-device model that actually runs (Whisper or Moonshine).
      engineLabel:
        this.engine === "whisper-local" ? `${SPEECH_MODELS[localSpeechModel(settings.voice.localModel)].label.split(":")[0]} on this device (private, offline)` : ENGINE_LABELS[this.engine],
      wakeName: this.wakeNames()[0] ?? "ADT",
      approval: null,
    };
  }

  private set(patch: Partial<VoiceState>) {
    if (this.closed) return;
    // Live captions only run while someone may be talking to the bot: the user, or the user cutting
    // in while it speaks or thinks (the caption shows it's them, so it stops at once). They cost
    // nothing while the room is quiet: captions only run on sound the detector took for speech.
    if (patch.phase && patch.phase !== this.state.phase) {
      const p = patch.phase;
      this.listener?.setPartials(p === "listening" || p === "hearing" || p === "speaking" || p === "thinking");
    }
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
    if (phase !== "listening" && phase !== "hearing" && phase !== "standby") return 0;
    return this.listener?.level?.() ?? this.micLevel;
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
    setVoiceApprover((request) => this.askApproval(request));
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
          early: voice.earlyReply,
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
    const local = localChoice(voice);
    if (local) localVoiceReady(local);
    else warmDeviceVoice(voice);
    chime("listen");
    if (this.hooks.initialRequest?.trim()) void this.process(this.hooks.initialRequest.trim());
    else this.enterListening();
  }

  /** Ends the session. `notify: false` when the UI is already going away (unmount). */
  close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    this.dropEarly();
    this.clearIdle();
    this.offProgress?.();
    this.listener?.close();
    this.device?.cancel();
    this.speaker?.stop();
    // Speech turned down for a cut-in must not stay quiet for read-aloud or the next session.
    this.ducked = false;
    duckSpeech(false);
    this.answerApproval("deny");
    setVoiceApprover(null);
    setVoiceModeActive(false);
    if (notify) this.hooks.onClose();
  }

  /** What the bot said lately: its own voice may come back through the microphone as any of it. */
  private recentSpeech(): string {
    return `${this.lastSpoken} ${this.speaker?.spoken ?? ""}`.slice(-900);
  }

  /**
   * Live caption heard while the bot talks: is it the user cutting in (a command like "stop", or
   * two or more real words that aren't the bot's own voice coming back)?
   */
  private isCutIn(caption: string): boolean {
    if (this.approval || this.bargeMode() === "off") return false;
    if (parseVoiceCommand(caption, useStore.getState().bots)?.type === "stop" || endsWithStop(caption)) return true;
    return soundsLikeUser(caption, this.recentSpeech());
  }

  /**
   * A tool needs the user's OK in the middle of a reply: ask aloud with the reply's voice, show the
   * question with Allow / Don't allow, and take the next thing they say as the answer. No answer in
   * a minute counts as no.
   */
  private askApproval({ summary, reason, signal }: { summary: string; reason: string; signal: AbortSignal }): Promise<"allow" | "deny"> {
    if (this.closed) return Promise.resolve("deny");
    this.answerApproval("deny");
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answerApproval("deny"), 60_000);
      const pending = { resolve, timer };
      this.approval = pending;
      // Answered from the chat's card instead: drop the question here.
      signal.addEventListener("abort", () => this.approval === pending && this.answerApproval("deny"), { once: true });
      this.clearIdle();
      this.dropEarly();
      this.unduck();
      this.set({ approval: { question: summary, reason }, phase: "speaking", sentence: summary, spokenChars: 0 });
      const speaker = this.speaker ?? createSpeaker(this.context(), { onError: (message) => this.set({ error: message }) });
      this.speaker = speaker;
      speaker.say(summary);
      void speaker.idle().then(() => {
        if (this.approval !== pending) return;
        this.lastSpoken = speaker.spoken;
        this.speechEndedAt = performance.now() + speaker.tailMs;
        this.listener?.setSensitivity("normal");
        this.set({ phase: "listening", partial: "" });
      });
    });
  }

  /** The user's answer to askApproval, spoken or from the buttons. */
  answerApproval(answer: "allow" | "deny") {
    const pending = this.approval;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.approval = null;
    this.approvalEndedAt = performance.now();
    this.listener?.setSensitivity("strict");
    if (!this.closed) this.set({ approval: null, phase: "thinking", partial: "", activity: answer === "allow" ? "" : "Okay, skipping that." });
    pending.resolve(answer);
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
    this.dropEarly();
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
      this.segmentStartedAt = performance.now();
      this.segmentDuringSpeech = phase === "speaking" || phase === "thinking" || performance.now() - this.speechEndedAt < ECHO_TAIL_MS;
      if (phase === "listening") this.set({ phase: "hearing", partial: "" });
      return;
    }
    if (event.type === "speech") {
      // A quarter second of clear speech (not a cough or click): the user may be cutting in.
      if (phase === "speaking" && this.bargeMode() === "instant" && !this.approval) {
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
    if (event.type === "tentative") {
      this.startEarly(event.text);
      return;
    }
    if (event.type === "resume") {
      this.dropEarly();
      return;
    }
    if (event.type === "silent") {
      this.fail(event.message);
      return;
    }
    if (event.type === "partial") {
      const now = this.state.phase;
      if (now === "hearing") this.set({ partial: event.text });
      else if ((now === "speaking" || now === "thinking") && this.isCutIn(event.text)) {
        // Talking over the bot: stop it now, while the user is still mid-sentence.
        this.interrupt();
        this.set({ phase: "hearing", partial: event.text });
      }
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

  /**
   * The user has probably finished: start the answer now, silently, so it's under way by the time
   * the turn is surely over. Kept only if the turn ends with these words (see onUtterance); nothing
   * shows, is saved or runs until then. Only for a plain question to the bot while it's quiet.
   */
  private startEarly(text: string) {
    if (this.approval) return;
    if (this.segmentStartedAt - this.speechEndedAt < LATE_ECHO_MS && echoesLastWords(text, this.lastSpoken)) return;
    if (!this.context().voice.earlyReply || this.phase() !== "hearing" || this.segmentDuringSpeech) return;
    if (this.early && sameWords(this.early.text, text)) return;
    this.dropEarly();
    if (isLikelyHallucination(text) || parseVoiceCommand(text, useStore.getState().bots)) return;
    const modes = useStore.getState().settings.modes;
    this.early = startEarlyReply(text, { search: modes.search, think: modes.think, voice: true });
  }

  private dropEarly() {
    this.early?.discard();
    this.early = null;
  }

  private async onUtterance(text: string) {
    const { phase } = this.state;
    const duringSpeech = this.segmentDuringSpeech;
    this.segmentDuringSpeech = false;
    // The early reply is kept only when the turn ended with the words it answers, as a plain question.
    let early = this.early;
    this.early = null;
    if (early && !(phase === "hearing" && sameWords(early.text, text) && !parseVoiceCommand(text, useStore.getState().bots))) {
      early.discard();
      early = null;
    }
    // A tool is waiting on the user's OK: this is the answer (or our own question coming back).
    if (this.approval && text) {
      early?.discard();
      if (echoesLastWords(text, this.lastSpoken)) return;
      const answer = yesOrNo(text);
      if (answer) this.answerApproval(answer);
      else this.set({ heard: text, partial: "" });
      return;
    }
    if (!text || isLikelyHallucination(text)) {
      early?.discard();
      this.unduck();
      if (phase === "hearing") this.enterListening();
      return;
    }
    // Started while the bot was talking but finished after it stopped: drop it if it's the bot's own voice.
    // "Stop" at the end of a stretch that began with the bot's echo is still the user saying stop.
    if (duringSpeech && endsWithStop(text) && !parseVoiceCommand(text, useStore.getState().bots)) text = "stop";
    const command = parseVoiceCommand(text, useStore.getState().bots);
    if (duringSpeech && !command) {
      // Began while the bot was talking: its own voice, or the user (maybe both, echo first).
      const own = userPart(text, this.recentSpeech());
      if (own === null) {
        early?.discard();
        this.unduck();
        if (phase === "hearing") this.enterListening();
        return;
      }
      if (own !== text) {
        early?.discard();
        early = null;
        text = own;
      }
    }
    // Started just after the bot stopped, and it's the bot's last words: a late echo (speaker delay,
    // Bluetooth, reverb), not the user.
    const sinceVoiceEnded = this.segmentStartedAt - this.speechEndedAt;
    if (!duringSpeech && (phase === "listening" || phase === "hearing") && sinceVoiceEnded < LATE_ECHO_MS && echoesLastWords(text, this.lastSpoken)) {
      early?.discard();
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
      // Heard during our own speech (already checked above for being our voice coming back).
      if (this.bargeMode() === "off") {
        this.unduck();
        return;
      }
      this.interrupt();
    } else if (phase === "thinking") {
      this.interrupt();
    } else if (phase === "muted") {
      return;
    }
    await this.process(text, early);
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

  /** `early`: a reply already started for exactly this question (see startEarly). */
  private async process(text: string, early: EarlyReply | null = null) {
    const { bots } = useStore.getState();
    const command = parseVoiceCommand(text, bots);
    if (command) early?.discard();
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
        await this.ask(text, {}, early);
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
    // A newer turn already took over (and interrupt() recorded this one): don't overwrite its state.
    if (turn !== this.turn || this.closed) return false;
    this.lastSpoken = speaker.spoken;
    // The voice is still coming out of the speakers for a moment after playback ends here.
    this.speechEndedAt = performance.now() + speaker.tailMs;
    return true;
  }

  private async ask(text: string, options: { search?: boolean; imagine?: boolean } = {}, early: EarlyReply | null = null) {
    const turn = ++this.turn;
    this.clearIdle();
    this.unduck();
    this.listener?.setSensitivity("strict");
    this.set({ phase: "thinking", reply: "", sentence: "", spokenChars: 0, activity: "", latencyMs: null, timing: null, error: null });
    // An early reply's message was created when it started.
    const startedAt = early?.createdAt ?? Date.now();
    const askedAt = performance.now();
    let firstTextAt = 0;
    let spokenAny = false;
    /** How much of the model's wait an early reply saved (it had been running this long, up to its first words). */
    let savedMs = 0;
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
              ...(savedMs ? { early: Math.round(savedMs) } : {}),
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
      if (steps && this.state.phase === "thinking" && !speaker.speaking && reminders < 2 && performance.now() - Math.max(lastSoundAt, this.approvalEndedAt) > STILL_WORKING_MS) {
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
    if (turn !== this.turn || this.closed) {
      early?.discard();
      return clearInterval(ticker);
    }
    const unsubscribe = useStore.subscribe(() => feed(false));
    const modes = useStore.getState().settings.modes;
    try {
      if (early?.keep()) {
        const now = performance.now();
        savedMs = Math.max(0, Math.min(now, early.firstWordsAt() ?? now) - early.startedAt);
        // What it has written so far goes straight to the speaker.
        feed(false);
        await early.done;
      } else {
        await sendMessage(text, [], { search: options.search ?? modes.search, think: modes.think, imagine: options.imagine, voice: true });
      }
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
    // An interrupted turn ends here after the next one began: interrupt() already recorded what it
    // said, and overwriting now would hide the new reply from the echo check.
    if (turn !== this.turn || this.closed) return;
    this.lastSpoken = speaker.spoken;
    // The voice is still coming out of the speakers for a moment after playback ends here.
    this.speechEndedAt = performance.now() + speaker.tailMs;
    this.lastReply = this.state.reply;
    this.enterListening();
  }

  private interrupt() {
    this.turn++;
    this.dropEarly();
    if (this.speaker) {
      this.lastSpoken = this.speaker.spoken;
      if (this.speaker.speaking) this.speechEndedAt = performance.now() + this.speaker.tailMs;
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
