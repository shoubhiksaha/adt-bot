import { Mic, MicOff, Settings2, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { speakable, ttsLabel } from "../lib/tts";
import { VoiceSession, type VoiceState } from "../lib/voice-session";
import { WHISPER_SIZES } from "../lib/whisper";
import { Avatar } from "./Avatar";
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
  const session = useRef<VoiceSession | null>(null);

  useEffect(() => {
    const s = new VoiceSession({ onState: setState, onClose, initialRequest });
    session.current = s;
    setState(s.state);
    void s.start();
    return () => s.close();
    // One session per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Space = talk / interrupt, M = mute, Esc = end.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " ") {
        e.preventDefault();
        session.current?.tap();
      } else if (e.key.toLowerCase() === "m") session.current?.toggleMute();
      else if (e.key === "Escape") session.current?.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state || !bot) return null;
  const { phase } = state;
  const listening = phase === "listening" || phase === "hearing";
  const scale = listening || phase === "standby" ? 1 + state.level * 0.45 : 1;
  const callName = bot.nickname?.trim() || bot.name;

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
      ? `Downloading speech model (${WHISPER_SIZES[voice.localModel].mb} MB, one time)… ${state.download}%`
      : phase === "standby"
        ? `Say “Hey ${state.wakeName}” to continue`
        : STATUS[phase];

  const reply = speakable(state.reply);

  return (
    <div className={`voice-mode phase-${phase}`} role="dialog" aria-label="Voice mode">
      <div className="voice-top">
        <span className="voice-bot">
          <Avatar value={bot.avatar} /> {bot.name}
          {bot.nickname?.trim() && <span className="muted small">“{bot.nickname.trim()}”</span>}
        </span>
        <span className="voice-meta small muted">
          {state.engineLabel} · {ttsLabel(voice)}
          {state.latencyMs !== null && (
            <span
              className="latency"
              title={
                state.timing
                  ? `You stopped talking → first word: understanding speech ${(state.timing.stt / 1000).toFixed(1)}s, model ${(state.timing.model / 1000).toFixed(1)}s, voice ${(state.timing.speech / 1000).toFixed(1)}s`
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
        <button
          type="button"
          className={`orb ${phase}`}
          style={{ transform: `scale(${scale})` }}
          onClick={() => session.current?.tap()}
          aria-label={tapLabel}
        >
          {(phase === "standby" || phase === "muted") && (phase === "muted" ? <MicOff size={34} /> : <Mic size={34} />)}
        </button>
        <div className="voice-status" aria-live="polite">
          {status}
        </div>
        {state.error && <div className="voice-error">{state.error}</div>}

        <div className="captions">
          {(state.partial || state.heard) && (
            <div className={`caption-user${state.partial ? " live" : ""}`}>“{state.partial || state.heard}”</div>
          )}
          {reply && phase !== "hearing" && (
            <div className="caption-bot">
              {state.sentence && reply.includes(state.sentence) ? (
                <>
                  <span className="said">{reply.slice(0, reply.indexOf(state.sentence))}</span>
                  <mark>{state.sentence}</mark>
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
        {phase === "standby"
          ? `Hands-free: say “Hey ${callName}, …” anytime.`
          : `Talk naturally and pause when done. Say “stop”, “new chat”, “switch to …”, “search for …”, “slower”, or “goodbye”.`}
        <span className="hide-touch"> · Space = {tapLabel.toLowerCase()} · M = mute · Esc = end</span>
      </div>

      <div className="voice-controls">
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
