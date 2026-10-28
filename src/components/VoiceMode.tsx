import { Camera, MicOff, Mic, MonitorUp, Settings2, SwitchCamera, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { desktopInvoke, isDesktop } from "../lib/desktop";
import { useStore } from "../lib/store";
import { speakable, speechLevel, ttsLabel } from "../lib/tts";
import { VoiceSession, type VoiceState } from "../lib/voice-session";
import { LiveVoiceSession } from "../lib/live-session";
import { isMoonshine } from "../lib/speech-models";
import { localSpeechModel, SPEECH_MODELS, whisperDownloaded } from "../lib/whisper";
import { Avatar } from "./Avatar";
import { setVisualFeed, VisualFeed, type FeedKind } from "../lib/visual-feed";
import { openSettings } from "./MessageItem";

const STATUS: Record<VoiceState["phase"], string> = {
  loading: "Getting ready…",
  listening: "Listening",
  hearing: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking",
  standby: "Standby",
  muted: "Microphone off",
  error: "Something went wrong",
};

/** Full-screen, hands-free voice conversation. */
export function VoiceMode({ initialRequest, onClose }: { initialRequest?: string; onClose: () => void }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === s.activeBotId));
  const voice = useStore((s) => s.settings.voice);
  const [state, setState] = useState<VoiceState | null>(null);
  const session = useRef<VoiceSession | LiveVoiceSession | null>(null);
  // Loading a downloaded model also reports progress; don't call that a download.
  const [cached, setCached] = useState(false);
  useEffect(() => {
    void whisperDownloaded(voice.localModel).then(setCached, () => undefined);
  }, [voice.localModel]);

  useEffect(() => {
    const hooks = { onState: setState, onClose, initialRequest };
    // Read once: a session keeps the engine it started with.
    const live = useStore.getState().settings.voice.conversation === "gemini-live";
    const s = live ? new LiveVoiceSession(hooks) : new VoiceSession(hooks);
    session.current = s;
    setState(s.state);
    void s.start();
    if (isDesktop()) void desktopInvoke("adt:voice:active", { active: true }).catch(() => undefined);
    // Unmounting already removes the UI, so don't call onClose again (StrictMode mounts twice in dev).
    return () => {
      s.close(false);
      if (isDesktop()) void desktopInvoke("adt:voice:active", { active: false }).catch(() => undefined);
    };
    // One session per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The orb follows the actual sound every frame: the microphone while listening, the bot's voice
  // while it speaks. Written straight to a CSS variable, so it doesn't re-render the screen; the
  // glow it drives is animated with transform and opacity only (see .orb::before).
  const orb = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let level = 0;
    let written = "";
    let last = performance.now();
    const tick = (now: number) => {
      const s = session.current;
      const phase = s?.state.phase;
      const quiet = !s || still?.matches || phase === "muted" || phase === "error" || phase === "loading";
      const target = quiet ? 0 : phase === "speaking" ? speechLevel() : s.inputLevel();
      // Rise fast, fall slower, like a VU meter. Timed, not per frame, so it moves the same at 60 Hz
      // and 120 Hz (and catches up smoothly after a slow frame).
      const dt = Math.min(100, Math.max(0, now - last));
      last = now;
      const tau = target > level ? 45 : 170;
      level += (target - level) * (1 - Math.exp(-dt / tau));
      const value = level < 0.004 ? "0" : level.toFixed(3);
      if (value !== written) {
        written = value;
        orb.current?.style.setProperty("--level", value);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Camera or screen sharing: a preview in the corner; Gemini Live gets a frame every second (the app's
  // own pipeline attaches the latest frame to each thing you say, in voice-session.ts).
  const [feed, setFeed] = useState<VisualFeed | null>(null);
  const [feedError, setFeedError] = useState("");
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const preview = useRef<HTMLVideoElement>(null);
  const share = async (kind: FeedKind, face = facing) => {
    setFeedError("");
    if (feed?.kind === kind && face === facing) {
      setVisualFeed(null);
      setFeed(null);
      return;
    }
    try {
      const next = await VisualFeed.open(kind, face);
      setVisualFeed(next);
      setFeed(next);
      next.stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setVisualFeed(null);
        setFeed((f) => (f === next ? null : f));
      });
    } catch (error) {
      setFeedError((error as Error).message);
    }
  };
  useEffect(() => {
    if (preview.current) preview.current.srcObject = feed?.stream ?? null;
    if (!feed) return;
    const live = session.current instanceof LiveVoiceSession ? session.current : null;
    const timer = live
      ? setInterval(() => {
          const frame = feed.frame(768, 0.6);
          if (frame) live.sendFrame(frame.mediaType, frame.data);
        }, 1000)
      : null;
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [feed]);
  // Leaving voice mode turns the camera off.
  useEffect(() => () => setVisualFeed(null), []);
  const canShareScreen = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/.test(navigator.userAgent);

  // A modal screen: the app behind it can't be focused or clicked, and doesn't spend time on
  // layout and paint while replies stream in underneath.
  const root = useRef<HTMLDivElement>(null);
  const shown = state !== null && Boolean(bot);
  useEffect(() => {
    const el = root.current;
    if (!shown || !el?.parentElement) return;
    const behind = [...el.parentElement.children].filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement && !c.inert);
    behind.forEach((c) => {
      c.inert = true;
      c.classList.add("under-voice");
    });
    el.querySelector<HTMLElement>(".voice-primary")?.focus();
    return () =>
      behind.forEach((c) => {
        c.inert = false;
        c.classList.remove("under-voice");
      });
  }, [shown]);

  // Space = talk / interrupt, M = mute, Esc = end.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " ") {
        e.preventDefault();
        session.current?.tap();
      } else if (e.key.toLowerCase() === "m") session.current?.toggleMute();
      else if (e.key === "Escape") session.current?.close();
      else if (e.key === "Tab" && root.current) {
        // Keep keyboard focus inside the voice screen.
        const items = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) return;
        e.preventDefault();
        items[(index + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state || !bot) return null;
  const { phase } = state;
  const callName = bot.nickname?.trim() || bot.name;
  const speechModel = localSpeechModel(voice.localModel);

  const tapLabel =
    phase === "hearing"
      ? "Done talking"
      : phase === "thinking" || phase === "speaking"
        ? "Interrupt"
        : phase === "standby" || phase === "muted"
          ? "Talk"
          : phase === "error"
            ? "Retry"
            : "Listening";

  const status =
    state.download !== null && state.download < 100
      ? cached
        ? "Loading speech model…"
        : `Downloading speech model, one time (${SPEECH_MODELS[speechModel].mb} MB${isMoonshine(speechModel) ? "" : "; about 90 MB more follows in the background for speed"})… ${state.download}%`
      : phase === "standby"
        ? state.live
          ? "Paused while it's quiet. Tap to carry on."
          : `Say “${state.wakePhrase}” to continue`
        : phase === "thinking" && state.activity
          ? state.activity
          : STATUS[phase];

  const reply = speakable(state.reply);

  return (
    <div ref={root} className={`voice-mode phase-${phase}`} role="dialog" aria-modal="true" aria-label="Voice mode">
      <div className="voice-top">
        <span className="voice-bot">
          <Avatar value={bot.avatar} /> {bot.name}
          {bot.nickname?.trim() && <span className="muted small">“{bot.nickname.trim()}”</span>}
        </span>
        <span className="voice-meta small muted">
          {state.live ? state.engineLabel : `${state.engineLabel} · ${ttsLabel(voice)}`}
          {state.latencyMs !== null && (
            <span
              className="latency"
              title={
                state.timing
                  ? `You stopped talking → first word: waiting for you to finish ${(state.timing.turn / 1000).toFixed(1)}s, understanding speech ${(state.timing.stt / 1000).toFixed(1)}s, model ${(state.timing.model / 1000).toFixed(1)}s${state.timing.early ? ` (it started ${(state.timing.early / 1000).toFixed(1)}s early, during your pause)` : ""}, voice ${(state.timing.speech / 1000).toFixed(1)}s`
                  : "From when you stopped talking to the first spoken word"
              }
            >
              <Zap size={12} /> {(state.latencyMs / 1000).toFixed(1)}s
            </span>
          )}
        </span>
        <button type="button" className="icon-btn" title="Voice settings" onClick={() => (session.current?.close(), openSettings("voice"))}>
          <Settings2 size={18} />
        </button>
      </div>

      <div className="voice-center">
        {/* Breathing (thinking, standby) lives on the wrapper, the sound on the orb: both animate
            on the compositor and combine, instead of one replacing the other's transform. */}
        <div className={`orb-breath ${phase}`}>
          <button
            type="button"
            ref={orb}
            className={`orb ${phase} look-${voice.look ?? "orb"}`}
            onClick={() => session.current?.tap()}
            aria-label={tapLabel}
          >
            {(phase === "standby" || phase === "muted") && voice.look === "orb" && (phase === "muted" ? <MicOff size={34} /> : <Mic size={34} />)}
            {voice.look === "face" && <VoiceFace />}
            {voice.look === "picture" && (
              <span className="orb-picture">
                <Avatar value={bot.avatar} size="lg" />
              </span>
            )}
          </button>
        </div>
        <div className="voice-status">{status}</div>
        {state.approval && (
          <div className="voice-approval" role="alertdialog" aria-label="The bot is asking for your OK">
            <p className="voice-approval-q">{state.approval.question.replace(/ Say yes or no\.$/, "").replace(/ The rest is on your screen\.$/, "")}</p>
            {state.approval.detail && state.approval.detail.length > 60 && <pre className="voice-approval-detail">{state.approval.detail}</pre>}
            <p className="small muted">
              {/* Policy names ("ask-first-time") aren't explanations; real reasons are sentences. */}
              {state.approval.reason.includes(" ") ? `Asking because ${state.approval.reason}. ` : ""}Say “yes” or “no”, or:
            </p>
            <div className="btn-row">
              <button type="button" className="btn primary" onClick={() => session.current?.answerApproval("allow")}>
                Allow
              </button>
              <button type="button" className="btn" onClick={() => session.current?.answerApproval("deny")}>
                Don't allow
              </button>
            </div>
          </div>
        )}
        {(state.error || feedError) && (
          <div className="voice-error" role="alert">
            {state.error || feedError}
          </div>
        )}
        {/* Screen readers hear each finished answer once, not every word as it's spoken. */}
        <div className="sr-only" aria-live="polite">
          {phase === "listening" ? reply : ""}
        </div>

        <div className="captions">
          {(state.partial || state.heard) && (
            <div className={`caption-user${state.partial ? " live" : ""}`}>“{state.partial || state.heard}”</div>
          )}
          {reply && phase !== "hearing" && (
            <div className="caption-bot">
              {state.sentence && reply.includes(state.sentence) ? (
                <>
                  <span className="said">{reply.slice(0, reply.indexOf(state.sentence))}</span>
                  <mark>
                    {state.sentence.slice(0, state.spokenChars)}
                    <span className="coming">{state.sentence.slice(state.spokenChars)}</span>
                  </mark>
                  <span className="unsaid">{reply.slice(reply.indexOf(state.sentence) + state.sentence.length)}</span>
                </>
              ) : (
                reply
              )}
            </div>
          )}
        </div>
      </div>

      <div className="voice-hints small muted">
        {state.live
          ? "Talk naturally, and talk over it any time. Say “goodbye” to end."
          : phase === "standby"
            ? `Hands-free: say “Hey ${callName}, …” anytime.`
            : state.otherAudio
              ? `Something else is playing sound, so start with “Hey ${callName}, …”. “Stop” and “goodbye” work as usual.`
              : `Talk naturally and pause when done. Say “stop”, “new chat”, “switch to …”, “search for …”, “slower”, or “goodbye”.`}
        <span className="hide-touch">
          {" "}
          · Space = {tapLabel.toLowerCase()} · M = mute · Esc = end{window.adtbotDesktop?.platform === "darwin" ? " · ⌥⇧Space opens and closes voice mode from any app" : ""}
        </span>
      </div>

      {feed && (
        <div className="voice-feed">
          <video ref={preview} muted playsInline autoPlay className={feed.kind === "camera" && facing === "user" ? "mirror" : ""} />
          <span className="small">{feed.kind === "camera" ? "Camera on: it sees this" : "Sharing your screen"}</span>
        </div>
      )}

      <div className="voice-controls">
        <button
          type="button"
          className={`voice-round${feed?.kind === "camera" ? " active" : ""}`}
          onClick={() => void share("camera")}
          aria-label={feed?.kind === "camera" ? "Turn the camera off" : "Show it your camera"}
          title={feed?.kind === "camera" ? "Camera off" : "Show it your camera"}
        >
          <Camera size={20} />
        </button>
        {feed?.kind === "camera" && (
          <button
            type="button"
            className="voice-round"
            onClick={() => {
              const next = facing === "user" ? "environment" : "user";
              setFacing(next);
              void share("camera", next);
            }}
            aria-label="Switch camera"
            title="Switch camera"
          >
            <SwitchCamera size={20} />
          </button>
        )}
        {canShareScreen && (
          <button
            type="button"
            className={`voice-round${feed?.kind === "screen" ? " active" : ""}`}
            onClick={() => void share("screen")}
            aria-label={feed?.kind === "screen" ? "Stop sharing your screen" : "Share your screen"}
            title={feed?.kind === "screen" ? "Stop sharing" : "Share your screen"}
          >
            <MonitorUp size={20} />
          </button>
        )}
        <button
          type="button"
          className={`voice-round${phase === "muted" ? " active" : ""}`}
          onClick={() => session.current?.toggleMute()}
          aria-label={phase === "muted" ? "Unmute microphone" : "Mute microphone"}
          title={phase === "muted" ? "Unmute (M)" : "Mute (M)"}
        >
          {phase === "muted" ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button type="button" className="voice-primary" onClick={() => session.current?.tap()}>
          {tapLabel}
        </button>
        <button type="button" className="voice-end" onClick={() => session.current?.close()} aria-label="End voice mode" title="End (Esc)">
          <X size={22} />
        </button>
      </div>
    </div>
  );
}

/** The "face" look: eyes that blink and look up while thinking, a mouth that moves with the voice (--level). */
function VoiceFace() {
  return (
    <svg className="voice-face" viewBox="0 0 200 200" aria-hidden="true">
      <g className="face-eyes">
        <ellipse className="face-eye" cx="70" cy="88" rx="12" ry="15" />
        <ellipse className="face-eye" cx="130" cy="88" rx="12" ry="15" />
      </g>
      <rect className="face-mouth" x="74" y="128" width="52" height="18" rx="9" />
    </svg>
  );
}
