import { FolderOpen, Loader2, Send } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { desktopInvoke } from "../../lib/desktop";
import { usingServerVoice } from "../../lib/server-voice";
import { useStore } from "../../lib/store";
import { KEEP_SECONDS, lastBotVoice, wavFile } from "../../lib/voice-recording";
import { buildReport, type ReportApp, reportLog, reportSettings, scrub, zipFiles } from "../../lib/voice-report";

const SHOW_IN = /Mac/.test(navigator.platform) ? "Show in Finder" : /Win/.test(navigator.platform) ? "Show in File Explorer" : "Show in folder";

/**
 * Settings → Voice → Save a voice report: the diagnostics log (and, if they want, the last seconds of
 * the bot's voice) as a file in Downloads for the person to send, or sent to the developer's report
 * inbox when this build has one (server/reports.mjs). They see everything in it first.
 */
export function VoiceReport({ onClose }: { onClose: () => void }) {
  const voice = useStore((s) => s.settings.voice);
  const [data, setData] = useState<{ log: string; app: ReportApp } | null>(null);
  const [note, setNote] = useState("");
  const [leaveOut, setLeaveOut] = useState(false);
  // As it was when the report was opened: the voice may carry on playing meanwhile.
  const [recording] = useState(lastBotVoice);
  const [withVoice, setWithVoice] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [saved, setSaved] = useState<{ path: string; name: string } | null>(null);
  const [inbox, setInbox] = useState<{ host: string } | null>(null);
  const [sent, setSent] = useState<{ code: string; keepDays: number } | null>(null);
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    desktopInvoke<{ log: string; app: ReportApp }>("adt:voice:report-data").then(setData, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    desktopInvoke<{ host: string } | null>("adt:voice:report-inbox").then(setInbox, () => setInbox(null));
  }, []);

  const wav = useMemo(() => (recording ? wavFile(recording.samples, recording.rate) : null), [recording]);
  useEffect(() => {
    if (!wav || !withVoice) return;
    const url = URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }));
    setAudioUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setAudioUrl("");
    };
  }, [wav, withVoice]);

  const log = useMemo(() => (data ? reportLog(data.log, leaveOut) : ""), [data, leaveOut]);
  const settings = useMemo(() => reportSettings(voice, usingServerVoice()), [voice]);
  const audio = withVoice && recording ? { seconds: recording.samples.length / recording.rate, rate: recording.rate } : null;
  const report = (text: string) => (data ? buildReport({ log, app: data.app, settings, note: text, leaveOutWords: leaveOut, audio }) : "");
  const preview = report(useDeferredValue(note));

  /** The file exactly as previewed: the text, or a .zip with the bot's voice too. */
  const file = () => {
    const text = new TextEncoder().encode(report(note));
    const zip = Boolean(audio && wav);
    return { bytes: zip ? zipFiles([{ name: "report.txt", data: text }, { name: "bot-voice.wav", data: wav! }]) : text, zip };
  };
  const run = async (what: "save" | "send") => {
    setBusy(what);
    setError("");
    try {
      if (what === "save") setSaved(await desktopInvoke<{ path: string; name: string }>("adt:voice:report-save", file()));
      else setSent(await desktopInvoke<{ code: string; keepDays: number }>("adt:voice:report-send", { ...file(), note: scrub(note.trim()) }));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (sent) {
    return (
      <Dialog title="Report sent" onClose={onClose}>
        <p style={{ marginTop: 0 }}>
          The developer has it. If you write to them about this problem, mention the code <strong style={{ fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)" }}>{sent.code}</strong>.
        </p>
        <p className="small muted">It's deleted from their inbox after {sent.keepDays} days.</p>
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  if (saved) {
    return (
      <Dialog title="Report saved" onClose={onClose}>
        <p style={{ marginTop: 0 }}>
          It's in your Downloads folder as <strong>{saved.name}</strong>. Send it to whoever is helping you, by email or WhatsApp for example.
        </p>
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => void desktopInvoke("adt:voice:report-show", { path: saved.path }).catch(() => undefined)}>
            <FolderOpen size={14} /> {SHOW_IN}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Voice report" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        {inbox
          ? `Everything in the report is shown below. Send it to the developer (to ${inbox.host}), or save it in your Downloads folder to send it yourself. Nothing goes until you click.`
          : "A file to send to whoever is helping you with a voice problem. Everything in it is shown below. It's saved in your Downloads folder: the app doesn't send it anywhere."}
      </p>
      <div className="field">
        <label htmlFor="report-note">What went wrong? (optional)</label>
        <textarea
          id="report-note"
          className="textarea"
          style={{ minHeight: 60 }}
          placeholder="e.g. A siren-like noise after I asked about the weather, around 3:15 pm."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <label className="toggle">
        <input type="checkbox" checked={leaveOut} onChange={(e) => setLeaveOut(e.target.checked)} />
        <span>
          <strong>Leave out what was said</strong>
          <br />
          <span className="small muted">Your words and the bot's become a word count, like [12 words]. Keys, email addresses and phone numbers are always taken out.</span>
        </span>
      </label>
      <label className="toggle" style={recording ? undefined : { cursor: "default", opacity: 0.6 }}>
        <input type="checkbox" checked={withVoice} disabled={!recording} onChange={(e) => setWithVoice(e.target.checked)} />
        <span>
          <strong>Add the last {KEEP_SECONDS} seconds of the bot's voice</strong>
          <br />
          <span className="small muted">
            {recording
              ? "For sound problems like noise, crackling or a siren. Listen to it first; the report becomes a .zip with the sound in it."
              : "Nothing recorded. While Voice diagnostics is on, the app keeps the last seconds of the bot's voice in memory (not the computer's own voices)."}
          </span>
        </span>
      </label>
      {audioUrl && <audio controls src={audioUrl} style={{ width: "100%", marginBottom: 12 }} aria-label="The bot's voice in the report" />}
      <div className="field">
        <label htmlFor="report-preview">What's in the report</label>
        <textarea id="report-preview" className="textarea mono" style={{ minHeight: 220 }} readOnly spellCheck={false} value={data ? preview : error ? "" : "Loading…"} />
      </div>
      {error && <p className="error-text small">{error}</p>}
      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={inbox ? "btn" : "btn primary"} disabled={!data || busy !== null} onClick={() => void run("save")}>
          {busy === "save" && <Loader2 size={14} className="spin" />} Save report
        </button>
        {inbox && (
          <button type="button" className="btn primary" disabled={!data || busy !== null} onClick={() => void run("send")}>
            {busy === "send" ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send to the developer
          </button>
        )}
      </div>
    </Dialog>
  );
}
