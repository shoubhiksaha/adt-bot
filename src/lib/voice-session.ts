import { visualFeed } from "./visual-feed";
import type { Attachment } from "./types";
import { type EarlyReply, sendMessage, setVoiceApprover, setVoiceModeActive, startEarlyReply, stopStreaming, stripMemoryTags } from "./chat";
import { activityFor } from "./agent/asks";
import { splitThink } from "./llm";
import { selectBot, startNewChat, updateConversation, updateSettings, useStore } from "./store";
import { localChoice, localVoiceReady } from "./local-tts";
import { chime, createSpeaker, duckSpeech, outputDb, type Speaker, speechReference, takeSentences, warmDeviceVoice } from "./tts";
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
  approvalAnswer,
  answerAfterEcho,
} from "./voice-commands";
import { setVoiceCloser } from "./voice-hooks";
import { debugVoice, spoken } from "./voice-log";
import { desktopInvoke } from "./desktop";
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
  /** A tool waiting for the user's OK, asked aloud (answer by voice or with the buttons). `detail`: all of what will run. */
  approval: { question: string; reason: string; detail?: string } | null;
  /** Another app is playing sound (a video, music, a call): requests must start with the bot's name. */
  otherAudio?: boolean;
  /** Gemini Live is talking, not the app's own speech pipeline. */
  live?: boolean;
};

const IDLE_TO_STANDBY_MS = 60_000;
/** How long a spoken "Can I …?" waits for an answer, from when it has been said. */
const APPROVAL_WAIT_MS = 60_000;
/**
 * Carrying on this soon after a request, before the reply has said or done anything, makes the two
 * one request (they paused mid-sentence; see noteCutOff).
 */
const CUT_OFF_MS = 15_000;
/** How often voice mode checks whether another app is playing sound (macOS desktop). */
const OTHER_AUDIO_POLL_MS = 1500;
/** Sound starting this soon after the bot stopped talking is checked for being its echo. */
const ECHO_TAIL_MS = 450;
/** Sound starting this soon after the bot's voice really ended is checked for being its last words. */
const LATE_ECHO_MS = 2000;
/** While tools work silently, say "Still working on it" after this long without speaking. */
const STILL_WORKING_MS = 8000;
/** Talking over the bot this long, clearly louder than its own voice coming back, stops it. */
const CUT_IN_MS = 450;
/** How often the microphone and the bot's own output are compared while it talks. */
const ECHO_TICK_MS = 50;
/** After the first CUT_IN_MS, the latest CUT_IN_MS of readings is judged again this often (a short "stop" can straddle two fixed windows). */
const CUT_IN_RECHECK_MS = 100;
/** Readings this long before the sound was detected count too (detection lags the sound's start). */
const CUT_IN_PREROLL_MS = 200;
/**
 * With the echo canceller in use, someone cutting in by words alone (not "stop") must also have been
 * at least this much louder than what's left of the echo, for a moment (dB): the leftover echo can
 * come back as garbled words unlike anything the bot said ("The gender was far").
 */
const WORDS_OVER_ECHO_DB = 3;
/** The echo arrives this much after the sound that made it (speaker, room, output buffers). */
const ECHO_DELAY_MS = 350;
/**
 * Readings kept of how the echo compares with the output (3 s), how many are needed first, and how many
 * make it sure (until then a voice must be further above the echo).
 */
const ECHO_GAPS = 60;
const ECHO_GAPS_NEEDED = 6;
const ECHO_GAPS_SURE = 15;
/**
 * The loudest an echo learned during a stretch of sound can be next to the output (dB). That sound
 * may be the user talking over the bot, not its echo: a voice taken for an echo louder than the bot
 * itself made every later cut-in impossible. (Real echoes measured -48 to -65 dB with echo cancelling.)
 */
const ECHO_GAP_MAX_DB = 0;
/**
 * The system's echo cancelling (built-in speakers and mic, loud) leaves the microphone almost silent
 * while the bot talks, and mutes a voice talking over it too: only its first tenth of a second gets
 * through, too little for the speech detector. A jump this far (dB) above both the echo and the
 * microphone's level just before turns the bot down at once, so the rest of what the user says gets
 * through; the usual checks then decide. Measured on a MacBook Air at full volume: the echo alone
 * jumped this far in 1 of 1,051 moments, a spoken "stop" by 35-45 dB.
 */
const ONSET_OVER_ECHO_DB = 20;
const ONSET_OVER_QUIET_DB = 20;
/** After such a jump, how long the bot stays turned down waiting for speech (none: a knock or a cough). */
const ONSET_WAIT_MS = 700;
/** The echo typically this far (dB) under the output: the system's echo cancelling has taken it out. */
const ECHO_REMOVED_DB = -35;

/** The output reading while the page's voice is between sentences (fetching the next one): silence. */
const SILENT_DB = -100;
/** Output this quiet (dB) leaves no echo worth the name. */
const QUIET_OUT_DB = -60;

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

/**
 * Whether someone is talking over the bot. The bot's echo follows its output, syllable by syllable
 * (and drops when it's turned down for a cut-in), at a level set by the speaker, the room and the
 * echo canceller: `gaps` are how much louder the microphone was than the output (dB) while the bot
 * talked, and `noise` the room's quiet level. In `window` (the moment since the sound began, as
 * microphone and recent-output dB) most readings must be well above the echo that output explains.
 * Until enough of the echo has been heard, only while the bot has been silent (no echo to come
 * back: e.g. its question's voice still being prepared); otherwise the words decide then.
 */
export function heardOverEcho(window: { mic: number; out: number }[], gaps: number[], noise: number, margin = 6): boolean {
  if (window.length < 6) return false;
  const silent = window.every((w) => w.out <= QUIET_OUT_DB);
  if (gaps.length < ECHO_GAPS_NEEDED && !silent) return false;
  const gap = gaps.length >= ECHO_GAPS_NEEDED ? percentile(gaps, 0.9) : 0;
  // Little heard of the echo yet (in the first reply the echo itself often starts a stretch of "speech",
  // which pauses learning): a stricter margin rather than no check at all.
  const need = gaps.length < ECHO_GAPS_SURE ? margin + 3 : margin;
  // Speech comes in syllables: a voice is over the echo for a good part of the moment, not all of it
  // (a third: a short "stop"; the echo alone was never over it at all in testing).
  const over = window.filter((w) => w.mic - Math.max(w.out + gap, noise) >= need).length;
  return over / window.length >= 1 / 3;
}

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
  /**
   * The question a tool is waiting on (see askApproval). `reply`: the reply's voice; the question has
   * its own, so talking over the question stops only the question.
   */
  private approval: { resolve: (answer: "allow" | "deny" | "timeout") => void; timer: ReturnType<typeof setTimeout> | null; reply: Speaker | null } | null = null;
  /** Bumped when a question starts or is talked over: an older one's end doesn't change anything. */
  private questionId = 0;
  /** The question was talked over before it was finished (see stopQuestion). */
  private questionCut = false;
  /** When the user last answered one (a tool asking isn't silence worth a "Still working on it"). */
  private approvalEndedAt = 0;
  /** The bot's output loudness (dB) lately, to match the echo that arrives a moment later. */
  private outHistory: { at: number; db: number }[] = [];
  /** Microphone minus recent output (dB) while the bot talks, and the microphone's quiet levels (see heardOverEcho). */
  private echoGaps: number[] = [];
  private quietLevels: number[] = [];
  /** Microphone and output readings since the current sound began (a possible cut-in). */
  private cutInWindow: { mic: number; out: number }[] = [];
  /** Echo readings waiting CUT_IN_PREROLL_MS before they're learned: sound recognised meanwhile may have been the user. */
  private pendingGaps: { at: number; gap: number }[] = [];
  /** The current stretch of sound: how far above the echo it has been at its loudest (three readings), and its last margins. */
  private segmentPeak = -Infinity;
  private segmentMargins: number[] = [];
  /** How many of cutInWindow's readings have already ended a judged stretch. */
  private cutInJudged = 0;
  /** The last second of readings, so a cut-in is judged from when the sound began, not from when it was recognised as speech. */
  private recentReadings: { at: number; mic: number; out: number }[] = [];
  private echoTimer: ReturnType<typeof setInterval> | null = null;
  /** The detector is in the middle of a stretch of speech. */
  private segmentActive = false;
  /** Listening to someone talking over the bot, to stop it once they're clearly louder than its echo. */
  private cutInTimer: ReturnType<typeof setTimeout> | null = null;
  /** The bot was stopped by the user's voice, before their words were known. */
  private stoppedByVoice = false;
  /** What the user asked for on top of a spoken yes, or while a step was running: done when this reply ends. */
  private followUp: string | null = null;
  /** How often the question was asked again after an answer that wasn't a yes or a no. */
  private reasks = 0;
  /** The bot closed voice mode (end_voice_mode): close once its reply has been spoken. */
  private closeAfterReply = false;
  /** Another app is playing sound, judged from a few checks in a row (a video's pauses don't flip it). */
  private otherAudio = false;
  private otherAudioRun = 0;
  /** A tool step of the current reply is running or about to (a command, a click). */
  private stepRunning = false;
  /** The request being answered, and whether the reply has said or done anything yet (see noteCutOff). */
  private asked: { text: string; turn: number; at: number; createdAt: number; said: boolean; tools: boolean } | null = null;
  /** A request the user carried on from before the reply said or did anything: it goes in front of their next words. */
  private cutOff: { text: string; createdAt: number; at: number } | null = null;
  /** Taken out of the chat before the joined request is sent (see ask). */
  private replacing: { text: string; createdAt: number } | null = null;
  private audioTimer: ReturnType<typeof setInterval> | null = null;
  /** When a sudden sound turned the bot down (see heardOnset), and the timer that turns it back up. */
  private onsetAt = -Infinity;
  private onsetTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (p === "speaking") this.watchEcho();
      else this.stopWatchingEcho();
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
  /**
   * A video, music or a call playing on this Mac reaches the microphone like a voice, and the system's
   * echo cancelling only removes the bot's own sound. While another app plays sound, requests must start
   * with the bot's name ("Hey ADT, …") and only "stop" or the name cuts in. macOS desktop only.
   */
  private watchOtherAudio() {
    if (this.audioTimer || typeof window === "undefined" || window.adtbotDesktop?.platform !== "darwin") return;
    const check = async () => {
      const r = await desktopInvoke<{ supported: boolean; apps: { name: string; bundleId: string }[] }>("adt:mac:audioOutputs").catch(() => null);
      if (this.closed || !r?.supported) return;
      const playing = r.apps.length > 0;
      // Two checks in a row to switch on (a notification sound isn't a video); three to switch off (a video pauses).
      this.otherAudioRun = playing === this.otherAudio ? 0 : this.otherAudioRun + 1;
      if (this.otherAudioRun >= (playing ? 2 : 3)) {
        this.otherAudio = playing;
        this.otherAudioRun = 0;
        debugVoice(playing ? "other audio playing" : "other audio stopped", r.apps.map((a) => a.name || a.bundleId).join(", "));
        this.set({ otherAudio: playing });
      }
    };
    void check();
    this.audioTimer = setInterval(() => void check(), OTHER_AUDIO_POLL_MS);
  }

  /** What was said after the bot's name ("Hey ADT, pause the video" → "pause the video"), or null if it wasn't addressed. */
  private addressedRest(text: string): string | null {
    const wake = matchWakeWord(text, this.wakeNames());
    return wake.woke ? wake.rest : null;
  }

  private wakeNames(): string[] {
    const { bots, activeBotId } = useStore.getState();
    const ordered = [...bots].sort((a, b) => Number(b.id === activeBotId) - Number(a.id === activeBotId));
    return ordered.flatMap((b) => [b.nickname?.trim(), b.name]).filter((n): n is string => Boolean(n));
  }

  async start() {
    setVoiceModeActive(true);
    setVoiceApprover((request) => this.askApproval(request));
    setVoiceCloser(() => (this.closeAfterReply = true));
    this.watchOtherAudio();
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
          echoCancel: true,
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
    this.stopWatchingEcho();
    this.offProgress?.();
    this.listener?.close();
    this.device?.cancel();
    this.approval?.reply?.stop();
    this.speaker?.stop();
    // Speech turned down for a cut-in must not stay quiet for read-aloud or the next session.
    this.ducked = false;
    duckSpeech(false);
    this.answerApproval("deny");
    setVoiceApprover(null);
    setVoiceCloser(null);
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = null;
    this.followUp = null;
    this.cutOff = null;
    setVoiceModeActive(false);
    if (notify) this.hooks.onClose();
  }

  /**
   * While the bot talks: the microphone against what the bot is playing. Outside a possible cut-in
   * this learns how its echo compares with its output; during one, it collects what heardOverEcho
   * judges. Only for voices the page plays (their output can be measured).
   */
  private watchEcho() {
    // What was learned about the echo carries over from reply to reply: the room and speakers stay the same.
    if (this.echoTimer || !this.listener) return;
    this.outHistory = [];
    this.recentReadings = [];
    this.echoTimer = setInterval(() => {
      const listener = this.listener;
      const level = listener?.level?.();
      if (!listener || level === null || level === undefined) return;
      // The bot's voice for the microphone's echo canceller (the page's voice starts with the first sentence).
      listener.setEchoReference?.(speechReference());
      // Between sentences the page's voice is silent (and the user easiest to hear); a device voice can't be measured.
      const out = outputDb() ?? (this.speaker?.inPageAudio ? SILENT_DB : null);
      if (out === null) return;
      const mic = listener.micDb?.() ?? level * 48 - 60;
      const now = performance.now();
      // Slow speakers (Bluetooth, AirPlay) send the echo back later.
      const delay = Math.max(ECHO_DELAY_MS, (this.speaker?.tailMs ?? 0) + 150);
      this.outHistory.push({ at: now, db: out });
      while (this.outHistory.length && now - this.outHistory[0].at > delay) this.outHistory.shift();
      const recentOut = Math.max(...this.outHistory.map((o) => o.db));
      // Echo is learned only once the bot has been audible for the whole delay: before that its echo
      // hasn't arrived yet, and the echo would seem quieter than it is.
      const oldest = this.outHistory[0];
      const steady = now - oldest.at >= delay - ECHO_TICK_MS && oldest.db > -50;
      this.recentReadings.push({ at: now, mic, out: recentOut });
      while (this.recentReadings.length && now - this.recentReadings[0].at > 1000) this.recentReadings.shift();
      if (this.heardOnset(mic, recentOut, now)) return;
      if (this.segmentActive) this.noteMargin(mic, recentOut);
      if (this.cutInTimer) {
        this.cutInWindow.push({ mic, out: recentOut });
        // Without an echo canceller the echo itself can start a stretch of "speech" before anything
        // was learned, and the check could never begin: learn just enough from it, turned down.
        const noise = this.quietLevels.length ? percentile(this.quietLevels, 0.5) : -60;
        if (this.echoGaps.length < ECHO_GAPS_NEEDED && steady && recentOut > -45 && mic > noise + 6) this.echoGaps.push(Math.min(mic - recentOut, ECHO_GAP_MAX_DB));
        return;
      }
      // Only learn while nobody seems to be talking: the start of a cut-in isn't echo.
      if (this.segmentActive || this.ducked) return;
      if (this.echoGaps.length % 20 === 1) debugVoice("echo", JSON.stringify({ mic: Math.round(mic), out: Math.round(out), recentOut: Math.round(recentOut) }));
      // The bot clearly audible: how loud its echo is next to it (in its quiet syllables the
      // microphone only hears the room, which says nothing about the echo). Quiet: the room's level.
      if (recentOut > -30 && steady) {
        this.pendingGaps.push({ at: now, gap: mic - recentOut });
        while (this.pendingGaps.length && now - this.pendingGaps[0].at > CUT_IN_PREROLL_MS) {
          this.echoGaps.push(this.pendingGaps.shift()!.gap);
          if (this.echoGaps.length > ECHO_GAPS) this.echoGaps.shift();
        }
        this.listener?.setEchoRemoved?.(this.echoGaps.length >= ECHO_GAPS_SURE && percentile(this.echoGaps, 0.5) <= ECHO_REMOVED_DB);
      } else if (recentOut < -50) {
        this.quietLevels.push(mic);
        if (this.quietLevels.length > ECHO_GAPS) this.quietLevels.shift();
      }
    }, ECHO_TICK_MS);
  }

  /** How far a reading is above the echo its output explains (see heardOverEcho), for segmentPeak. */
  private noteMargin(mic: number, out: number) {
    if (this.echoGaps.length < ECHO_GAPS_NEEDED) return;
    const noise = this.quietLevels.length ? percentile(this.quietLevels, 0.5) : -60;
    this.segmentMargins.push(mic - Math.max(out + percentile(this.echoGaps, 0.9), noise));
    if (this.segmentMargins.length > 3) this.segmentMargins.shift();
    if (this.segmentMargins.length === 3) this.segmentPeak = Math.max(this.segmentPeak, this.segmentMargins.reduce((a, b) => a + b, 0) / 3);
  }

  /**
   * A sudden sound far above the echo while the bot talks (see ONSET_OVER_ECHO_DB): turn it down now
   * so the rest of the user's words get through, and back up if no speech follows.
   */
  private heardOnset(mic: number, out: number, now: number): boolean {
    if (this.state.phase !== "speaking" || this.ducked || this.segmentActive || this.otherAudio || this.bargeMode() !== "instant" || !this.speaker?.inPageAudio) return false;
    if (this.echoGaps.length < ECHO_GAPS_NEEDED || this.recentReadings.length < 10) return false;
    const echo = out + percentile(this.echoGaps, 0.5);
    const before = percentile(this.recentReadings.map((r) => r.mic), 0.2);
    if (mic - echo < ONSET_OVER_ECHO_DB || mic - before < ONSET_OVER_QUIET_DB) return false;
    debugVoice("sudden sound: turned down", JSON.stringify({ mic: Math.round(mic), echo: Math.round(echo), before: Math.round(before) }));
    // Not echo: don't learn the moments just before it as echo either.
    this.pendingGaps = [];
    this.onsetAt = now;
    this.ducked = true;
    duckSpeech(true);
    this.clearOnset();
    // A short "stop" scores low with the detector, and only part of it got through: take it as speech.
    this.listener?.setEager?.(true);
    this.onsetTimer = setTimeout(() => {
      this.clearOnset();
      if (!this.segmentActive && this.state.phase === "speaking") this.unduck();
    }, ONSET_WAIT_MS);
    return true;
  }

  private clearOnset() {
    if (this.onsetTimer) clearTimeout(this.onsetTimer);
    this.onsetTimer = null;
    this.listener?.setEager?.(false);
  }

  /** The words of the current stretch may be the leftover echo: the canceller is in use, and it was never clearly louder. */
  private quieterThanEcho(): boolean {
    return this.listener?.echoReduction?.() != null && this.segmentPeak > -Infinity && this.segmentPeak < WORDS_OVER_ECHO_DB;
  }

  private stopWatchingEcho() {
    if (this.echoTimer) clearInterval(this.echoTimer);
    this.echoTimer = null;
    this.stopCutInCheck();
    this.clearOnset();
  }

  /**
   * Someone started talking while the bot speaks (its voice is already turned down): if they keep
   * going, clearly louder than its echo, stop it now rather than wait for their words to be
   * transcribed (seconds on a busy computer). Their words then decide what happens next.
   */
  private startCutInCheck() {
    this.stopCutInCheck();
    // Speech is recognised a quarter second in, and a short "stop" is nearly over by then: judge
    // the sound from its start (or from the sudden sound that turned the bot down, if that came first).
    const from = this.cutInFrom();
    this.cutInWindow = this.recentReadings.filter((r) => r.at >= from).map(({ mic, out }) => ({ mic, out }));
    this.cutInJudged = 0;
    this.armCutInCheck(Math.max(CUT_IN_RECHECK_MS, CUT_IN_MS - (performance.now() - this.segmentStartedAt)));
  }

  /** Where a cut-in's sound began: a little before the detector noticed it, or at a sudden sound just before. */
  private cutInFrom(): number {
    const preroll = this.segmentStartedAt - CUT_IN_PREROLL_MS;
    return this.segmentStartedAt - this.onsetAt <= ONSET_WAIT_MS ? Math.min(preroll, this.onsetAt - ECHO_TICK_MS) : preroll;
  }

  private armCutInCheck(ms: number) {
    this.cutInTimer = setTimeout(() => {
      this.cutInTimer = null;
      if (this.state.phase !== "speaking" || !this.ducked || !this.segmentActive) return;
      const noise = this.quietLevels.length ? percentile(this.quietLevels, 0.5) : -60;
      // Every CUT_IN_MS stretch not judged yet, from just before the sound was recognised on (a
      // short "stop" can be over before then); the window rolls on while the sound goes on.
      const size = Math.round(CUT_IN_MS / ECHO_TICK_MS);
      const readings = this.cutInWindow;
      let window = readings.slice(-size);
      let over = false;
      for (let end = Math.min(readings.length, Math.max(size, this.cutInJudged + 1)); end <= readings.length && !over; end++) {
        window = readings.slice(Math.max(0, end - size), end);
        over = heardOverEcho(window, this.echoGaps, noise);
      }
      this.cutInWindow = readings.slice(-(size - 1));
      this.cutInJudged = this.cutInWindow.length;
      debugVoice(
        "cut-in check",
        over ? "STOP" : "keep talking",
        JSON.stringify({
          echoGap: this.echoGaps.length ? Math.round(percentile(this.echoGaps, 0.9)) : null,
          cancelled: Math.round(this.listener?.echoReduction?.() ?? 0),
          gaps: this.echoGaps.length,
          noise: Math.round(noise),
          mic: window.map((w) => Math.round(w.mic)).join(" "),
          out: window.map((w) => Math.round(w.out)).join(" "),
        }),
      );
      if (over && this.approval) {
        // Answering over the question ("yes, go ahead"): stop asking; their words are the answer.
        this.stopQuestion();
      } else if (over && this.stepRunning) {
        // A step is running (a command, a click): stopping now would cut it off half done. Stay
        // turned down and let the words decide: "stop" still stops it, anything else comes next.
        debugVoice("cut-in during a step: turned down until the words are known");
      } else if (over) {
        this.stoppedByVoice = true;
        this.interrupt();
        this.set({ phase: "hearing", partial: "" });
      } else {
        // Still a stretch of sound (a long echo, or someone starting to talk during it): look again.
        this.armCutInCheck(CUT_IN_RECHECK_MS);
      }
    }, ms);
  }

  private stopCutInCheck() {
    if (this.cutInTimer) clearTimeout(this.cutInTimer);
    this.cutInTimer = null;
  }

  /** What the bot said lately: its own voice may come back through the microphone as any of it. */
  private recentSpeech(): string {
    return `${this.lastSpoken} ${this.speaker?.spoken ?? ""}`.slice(-900);
  }

  private isStop(text: string): boolean {
    return parseVoiceCommand(text, useStore.getState().bots)?.type === "stop" || endsWithStop(text);
  }

  /**
   * Live caption heard while the bot talks: is it the user cutting in (a command like "stop", or
   * two or more real words that aren't the bot's own voice coming back)?
   */
  private isCutIn(caption: string): boolean {
    if (this.approval || this.bargeMode() === "off") return false;
    if (this.isStop(caption)) return true;
    // A video or music is playing: its words aren't the user cutting in unless they're addressed to the bot.
    if (this.otherAudio) return this.addressedRest(caption) !== null;
    // "Thank you for watching", "foreign foreign": what speech models make of noise and faint echo.
    if (isLikelyHallucination(caption)) return false;
    return soundsLikeUser(caption, this.recentSpeech()) && !this.quieterThanEcho();
  }

  /**
   * A tool needs the user's OK in the middle of a reply: ask aloud with the reply's voice, show the
   * question with Allow / Don't allow, and take the next thing they say as the answer. No answer in
   * a minute counts as no.
   */
  private askApproval({ summary, reason, signal, detail }: { summary: string; reason: string; signal: AbortSignal; detail?: string }): Promise<"allow" | "deny" | "timeout"> {
    if (this.closed) return Promise.resolve("deny");
    this.answerApproval("deny");
    return new Promise((resolve) => {
      const pending: NonNullable<VoiceSession["approval"]> = { resolve, timer: null, reply: this.speaker };
      this.approval = pending;
      this.reasks = 0;
      // Answered from the chat's card instead: drop the question here.
      signal.addEventListener("abort", () => this.approval === pending && this.answerApproval("deny"), { once: true });
      this.clearIdle();
      this.dropEarly();
      this.unduck();
      this.set({ approval: { question: summary, reason, detail } });
      this.sayQuestion(pending, summary);
    });
  }

  /**
   * Says the question (or a short "Should I go ahead?") once the reply has finished what it was
   * saying, in a voice of its own: talking over it stops just the question (see stopQuestion). The
   * answer is waited for from when it has been said.
   */
  private sayQuestion(pending: NonNullable<VoiceSession["approval"]>, text: string) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    const id = ++this.questionId;
    this.questionCut = false;
    this.set({ phase: "speaking", sentence: text, spokenChars: 0 });
    void (pending.reply?.idle() ?? Promise.resolve()).then(async () => {
      if (this.approval !== pending || id !== this.questionId) return;
      if (this.speaker && this.speaker !== pending.reply) this.speaker.stop();
      const question = createSpeaker(this.context(), { onError: (message) => this.set({ error: message }) });
      this.speaker = question;
      this.unduck();
      question.say(text);
      await question.idle();
      if (this.approval !== pending || id !== this.questionId) return;
      this.lastSpoken = question.spoken;
      this.speechEndedAt = performance.now() + question.tailMs;
      // Its echo may have turned it down without stopping it: back up for what comes next.
      this.unduck();
      this.listener?.setSensitivity("normal");
      this.set({ phase: "listening", partial: "" });
      this.armAnswerTimer(pending, APPROVAL_WAIT_MS);
    });
  }

  /** No answer in what was heard: ask again, briefly (twice at most), or go on listening for it. */
  private awaitAnswer(pending: NonNullable<VoiceSession["approval"]>, askAgain: boolean) {
    this.questionCut = false;
    if (askAgain && this.reasks < 2) {
      this.reasks++;
      this.sayQuestion(pending, "Should I go ahead? Say yes or no.");
    } else if (this.state.phase === "hearing") {
      this.unduck();
      this.listener?.setSensitivity("normal");
      this.set({ phase: "listening", partial: "" });
    }
  }

  /** The user talked over the question (answering it, most likely): stop asking and listen. */
  private stopQuestion() {
    const pending = this.approval;
    if (!pending) return;
    this.questionId++;
    this.questionCut = true;
    debugVoice("talked over the question: stopped asking");
    const question = this.speaker;
    if (question && question !== pending.reply) {
      this.lastSpoken = question.spoken;
      if (question.speaking) this.speechEndedAt = performance.now() + question.tailMs;
      question.stop();
    }
    this.clearOnset();
    this.unduck();
    this.listener?.setSensitivity("normal");
    this.set({ phase: "hearing", partial: "" });
    this.armAnswerTimer(pending, APPROVAL_WAIT_MS);
  }

  private armAnswerTimer(pending: NonNullable<VoiceSession["approval"]>, ms: number) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.approval !== pending) return;
      // Mid-sentence: let them finish.
      if (this.segmentActive) return this.armAnswerTimer(pending, 5000);
      this.answerApproval("timeout");
    }, ms);
  }

  /** The user's answer to askApproval, spoken or from the buttons; "timeout" when none came. */
  answerApproval(answer: "allow" | "deny" | "timeout") {
    const pending = this.approval;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.approval = null;
    this.approvalEndedAt = performance.now();
    // Answered (by voice or a button) while still being asked: stop asking. The reply carries on in its own voice.
    if (this.speaker && this.speaker !== pending.reply) {
      this.speaker.stop();
      this.speaker = pending.reply;
    }
    // Turned down by the answer said over the question: the reply goes on at full volume.
    this.unduck();
    this.listener?.setSensitivity("strict");
    const activity = answer === "allow" ? "" : answer === "timeout" ? "No answer, so I didn't do that." : "Okay, skipping that.";
    if (!this.closed) this.set({ approval: null, phase: "thinking", partial: "", activity });
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
    this.stoppedByVoice = false;
    // What they carried on with came to nothing (a cough, a stray word): no longer joined to anything.
    this.cutOff = null;
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
    if (event.type !== "tentative" && event.type !== "resume") {
      const said = "text" in event && event.text ? ` ${spoken(String(event.text).slice(0, 160))}` : "";
      const repaired = event.type === "utterance" && event.repaired ? { repaired: event.repaired } : {};
      debugVoice(`heard ${event.type}${said}`, JSON.stringify({ phase, mic: Math.round(this.listener?.micDb?.() ?? -100), ducked: this.ducked, step: this.stepRunning, otherAudio: this.otherAudio, ...repaired }));
    }
    if (event.type === "start") {
      this.clearIdle();
      this.segmentActive = true;
      this.segmentStartedAt = performance.now();
      // Speech after a sudden sound: it stays turned down for the checks below.
      this.clearOnset();
      // The detector notices sound a little late: the readings just before may be the user, not echo.
      const from = this.cutInFrom();
      this.pendingGaps = this.pendingGaps.filter((g) => g.at < from);
      this.segmentPeak = -Infinity;
      this.segmentMargins = [];
      for (const r of this.recentReadings) if (r.at >= from) this.noteMargin(r.mic, r.out);
      this.segmentDuringSpeech = phase === "speaking" || phase === "thinking" || performance.now() - this.speechEndedAt < ECHO_TAIL_MS;
      if (phase === "listening") this.set({ phase: "hearing", partial: "" });
      return;
    }
    if (event.type === "speech") {
      // A quarter second of clear speech (not a cough or click): the user may be cutting in.
      // While a tool's question is asked, only a voice clearly louder than its echo stops it (the
      // question ends in "say yes or no": its own words coming back mustn't answer it).
      if (phase === "speaking" && this.bargeMode() === "instant" && !this.otherAudio && (!this.approval || this.speaker?.inPageAudio)) {
        if (this.speaker?.inPageAudio) {
          // Turn the bot right down now; stop it once the user is clearly louder than its echo, or
          // their words show it isn't our own voice coming back, whichever comes first.
          this.ducked = true;
          duckSpeech(true);
          this.startCutInCheck();
        } else {
          // The device voice can't be turned down: stop it (its echo is still checked below).
          this.stoppedByVoice = true;
          this.interrupt();
          this.set({ phase: "hearing", partial: "" });
        }
      }
      return;
    }
    if (event.type === "discard") {
      this.segmentActive = false;
      this.stopCutInCheck();
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
    if (event.type === "short") {
      // Too short to start a turn, said while the bot talks or thinks: only a stop counts (a cough, a
      // stray word or its own echo doesn't).
      const now = this.state.phase;
      const echo = ` ${normalize(this.recentSpeech())} `.includes(` ${normalize(event.text)} `);
      if ((now === "speaking" || now === "thinking") && !this.approval && this.bargeMode() !== "off" && this.isStop(event.text) && !echo) {
        debugVoice("stopped by a short word", spoken(event.text));
        this.interrupt();
        this.enterListening();
      }
      return;
    }
    if (event.type === "partial") {
      const now = this.state.phase;
      if (now === "hearing") this.set({ partial: event.text });
      else if ((now === "speaking" || now === "thinking") && this.isCutIn(event.text)) {
        // A step is running: only "stop" cuts it off; anything else waits for the whole sentence and comes next.
        if (this.stepRunning && !this.isStop(event.text)) return;
        debugVoice("stopped by a live caption", spoken(event.text));
        // Talking over the bot: stop it now, while the user is still mid-sentence.
        this.noteCutOff();
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
      this.segmentActive = false;
      this.stopCutInCheck();
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
    // With the camera or screen shared, the answer needs the frame from when you finished speaking.
    if (!this.context().voice.earlyReply || this.phase() !== "hearing" || this.segmentDuringSpeech || visualFeed()) return;
    if (this.early && sameWords(this.early.text, text)) return;
    this.dropEarly();
    if (isLikelyHallucination(text) || parseVoiceCommand(text, useStore.getState().bots)) return;
    if (this.otherAudio && this.addressedRest(text) === null) return;
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
    const byVoice = this.stoppedByVoice;
    this.stoppedByVoice = false;
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
      const pending = this.approval;
      // The question coming back can run into the answer said over it ("Can I run a command? Yes,
      // go ahead"): the answer is the user's part.
      const said = answerAfterEcho(text, this.lastSpoken) ?? text;
      // Only the question coming back. Cut short by it, the question is asked again.
      if (said === text && echoesLastWords(text, this.lastSpoken)) return this.awaitAnswer(pending, this.questionCut);
      const { answer, rest } = approvalAnswer(said);
      if (answer) {
        // "Yes, and also check the Downloads folder": that part comes once this step is done.
        if (answer === "allow" && rest) this.followUp = rest;
        this.answerApproval(answer);
        return;
      }
      this.set({ heard: said, partial: "" });
      // A question, a pause or someone else talking: ask again, briefly.
      this.awaitAnswer(pending, isSubstantial(said) && !isLikelyHallucination(said));
      return;
    }
    if (!text || isLikelyHallucination(text)) {
      early?.discard();
      this.unduck();
      if (phase === "hearing") this.enterListening();
      return;
    }
    // A video, music or call is playing on this Mac: only what's addressed to the bot (or a command) counts.
    if (this.otherAudio && phase !== "standby" && !parseVoiceCommand(text, useStore.getState().bots)) {
      const rest = this.addressedRest(text);
      if (rest === null) {
        debugVoice("other audio is playing and this wasn't addressed to the bot", spoken(text));
        early?.discard();
        this.unduck();
        if (phase === "hearing") this.enterListening();
        return;
      }
      if (!rest) {
        early?.discard();
        chime("wake");
        if (phase === "hearing") this.enterListening();
        return;
      }
      text = rest;
    }
    // Started while the bot was talking but finished after it stopped: drop it if it's the bot's own voice.
    // "Stop" at the end of a stretch that began with the bot's echo is still the user saying stop.
    if (duringSpeech && endsWithStop(text) && !parseVoiceCommand(text, useStore.getState().bots)) text = "stop";
    const command = parseVoiceCommand(text, useStore.getState().bots);
    if (duringSpeech && !command) {
      // Began while the bot was talking: its own voice, or the user (maybe both, echo first).
      const own = userPart(text, this.recentSpeech());
      if (own === null || (phase === "speaking" && this.quieterThanEcho())) {
        if (own !== null) debugVoice("words, but never louder than the leftover echo", spoken(text), Math.round(this.segmentPeak));
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
    // The bot stopped because someone talked over it: a stray word, or the last question again
    // (speech recognition guessing from muddled audio), isn't a new request. Just listen.
    // A short request ("tell me a joke") is: their voice was already heard over the bot's.
    if (byVoice && !command && (normalize(text).split(" ").length < 2 || sameWords(text, this.state.heard))) {
      early?.discard();
      if (this.phase() === "hearing") this.enterListening();
      return;
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
    // A step is running (a command, a click): don't cut it off half done for anything but a command
    // like "stop". The request comes next, once this reply is done.
    if ((phase === "speaking" || phase === "thinking") && this.stepRunning && !command) {
      debugVoice("a step is running: this comes next", spoken(text));
      early?.discard();
      this.followUp = text;
      this.unduck();
      this.set({ heard: text, partial: "" });
      return;
    }
    if (phase === "speaking") {
      // Heard during our own speech (already checked above for being our voice coming back).
      if (this.bargeMode() === "off") {
        this.unduck();
        return;
      }
      debugVoice("stopped by what was heard", spoken(text));
      this.interrupt();
    } else if (phase === "thinking") {
      this.noteCutOff();
      this.interrupt();
    } else if (phase === "muted") {
      return;
    }
    const cutOff = this.cutOff;
    this.cutOff = null;
    if (cutOff && !command && performance.now() - cutOff.at < CUT_OFF_MS) {
      // They paused, the bot started on the first half, and they carried on: one request, as meant
      // ("Tell me if I…" + "…give you links to jobs, can you apply?").
      debugVoice("joined to the request it carried on from", spoken(cutOff.text));
      early?.discard();
      early = null;
      this.replacing = cutOff;
      // "Tell me if I..." trails off: no full stop or dots in the middle of the joined sentence.
      text = `${cutOff.text.trim().replace(/(?:\.|…)+$/, "")} ${text}`;
    }
    await this.process(text, early);
  }

  /**
   * The user's words are cutting in on the reply: if it hasn't said or done anything yet, what they
   * asked was probably only the first half (they paused mid-sentence); keep it for their next words.
   */
  private noteCutOff() {
    const asked = this.asked;
    const fresh = asked && asked.turn === this.turn && !asked.said && !asked.tools && performance.now() - asked.at < CUT_OFF_MS;
    this.cutOff = fresh ? { text: asked.text, createdAt: asked.createdAt, at: performance.now() } : null;
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
    const asked = options.search || options.imagine ? null : { text, turn, at: performance.now(), createdAt: startedAt, said: false, tools: false };
    this.asked = asked;
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
        if (asked) asked.said = true;
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
      if (calls.length && asked) asked.tools = true;
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
      this.stepRunning = Boolean(running && running.status !== "awaiting");
      const activity = running ? activityFor(running.name) : "";
      if (activity !== this.state.activity) this.set({ activity });
      // (A tool's question is spoken in a voice of its own: the phase is the question's then.)
      if (steps && this.state.phase === "speaking" && !speaker.speaking && !this.approval) this.set({ phase: "thinking" });
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
      if (steps && this.state.phase === "speaking" && !speaker.speaking && !this.approval) this.set({ phase: "thinking" });
      if (steps && this.state.phase === "thinking" && !speaker.speaking && !this.approval && reminders < 2 && performance.now() - Math.max(lastSoundAt, this.approvalEndedAt) > STILL_WORKING_MS) {
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
    // The first half of this request, stopped before it said anything: out of the chat, since it's asked again as part of this.
    const replacing = this.replacing;
    this.replacing = null;
    if (replacing) dropUnanswered(replacing);
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
        // Camera or screen shared: what you said goes with what it shows right now.
        const feed = visualFeed();
        const frame = feed?.frame();
        const seen: Attachment[] = feed && frame ? [{ kind: "image", dataUrl: frame.dataUrl, name: feed.kind === "camera" ? "camera.jpg" : "screen.jpg" }] : [];
        await sendMessage(text, seen, { search: options.search ?? modes.search, think: modes.think, imagine: options.imagine, voice: true });
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
    this.stepRunning = false;
    if (this.closeAfterReply) {
      this.close();
      return;
    }
    this.enterListening();
    const followUp = this.followUp;
    this.followUp = null;
    if (followUp) void this.process(followUp);
  }

  private interrupt() {
    this.turn++;
    this.dropEarly();
    this.followUp = null;
    this.stepRunning = false;
    // A question is being asked: the reply's own voice (waiting behind it) stops too.
    const reply = this.approval?.reply;
    if (reply && reply !== this.speaker) reply.stop();
    if (this.speaker) {
      this.lastSpoken = this.speaker.spoken;
      if (this.speaker.speaking) this.speechEndedAt = performance.now() + this.speaker.tailMs;
    }
    this.speaker?.stop();
    this.speaker = null;
    this.clearOnset();
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
 * Takes the first half of a request out of the chat (see noteCutOff): the user's message and the
 * reply that was stopped before it had said or done anything. Left alone if the reply has anything in it.
 */
export function dropUnanswered(request: { text: string; createdAt: number }) {
  const id = useStore.getState().activeConversationId;
  if (!id) return;
  updateConversation(id, (c) => {
    const at = c.messages.findLastIndex((m) => m.role === "user" && m.createdAt >= request.createdAt && m.content.trim() === request.text.trim());
    if (at < 0 || !c.messages.slice(at + 1).every((m) => m.role === "assistant" && !m.content.trim() && !m.toolCalls?.length && !m.attachments?.length)) return c;
    return { ...c, messages: c.messages.slice(0, at), updatedAt: Date.now() };
  });
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
