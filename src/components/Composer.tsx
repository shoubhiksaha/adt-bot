import { ArrowUp, AudioLines, FileText, Globe, Lightbulb, Loader2, Mic, Paperclip, Sparkles, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendMessage, stopStreaming } from "../lib/chat";
import { ACCEPTED_FILES, fileToAttachment, formatBytes } from "../lib/images";
import { updateSettings, useStore } from "../lib/store";
import type { Attachment } from "../lib/types";
import { listen, type ListenSession, resolveEngine } from "../lib/voice";
import { onWhisperProgress } from "../lib/whisper";

type Voice = "idle" | "dictating" | "recording" | "transcribing";

export function Composer({
  botName,
  prefill,
  onVoiceMode,
}: {
  botName: string;
  prefill?: { text: string; n: number };
  onVoiceMode: () => void;
}) {
  const streaming = useStore((s) => s.streamingId !== null);
  const sendOnEnter = useStore((s) => s.settings.sendOnEnter);
  const modes = useStore((s) => s.settings.modes);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imagine, setImagine] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [voice, setVoice] = useState<Voice>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<ListenSession | null>(null);
  const [download, setDownload] = useState<number | null>(null);

  useEffect(() => onWhisperProgress((p) => setDownload(p ? Math.round(p.progress) : null)), []);

  useEffect(() => {
    if (prefill) {
      setText(prefill.text);
      textareaRef.current?.focus();
    }
  }, [prefill]);

  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener("adt:focus-composer", focus);
    return () => window.removeEventListener("adt:focus-composer", focus);
  }, []);

  // Grow with the content up to the CSS max-height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files];
    if (!list.length) return;
    setNotice(null);
    setReading((n) => n + list.length);
    const results = await Promise.allSettled(list.map(fileToAttachment));
    setReading((n) => n - list.length);
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
    if (failed.length) setNotice(failed.join(" "));
    setAttachments((current) => [...current, ...added].slice(0, 10));
  };

  const setMode = (key: "search" | "think", value: boolean) => updateSettings({ modes: { ...modes, [key]: value } });

  const submit = () => {
    if (streaming || reading || (!text.trim() && !attachments.length)) return;
    sessionRef.current?.stop();
    void sendMessage(text, attachments, { search: modes.search, think: modes.think, imagine });
    setText("");
    setAttachments([]);
    setImagine(false);
    setNotice(null);
  };

  /** Dictation: tap to start, tap again to stop and insert the text. */
  const toggleVoice = async () => {
    setNotice(null);
    if (voice === "dictating" || voice === "recording") {
      sessionRef.current?.stop();
      return;
    }
    const { providers, settings } = useStore.getState();
    const engine = resolveEngine(settings.voice, providers);
    const base = text ? `${text.trimEnd()} ` : "";
    try {
      const session = await listen(
        engine,
        {
          autoStop: false,
          onPartial: (spoken) => setText(base + spoken),
          onPhase: (phase) => setVoice(phase === "transcribing" ? "transcribing" : engine.startsWith("whisper") ? "recording" : "dictating"),
        },
        { voice: settings.voice, providers, useProxy: settings.useProxy },
      );
      sessionRef.current = session;
      const spoken = await session.result;
      if (spoken) setText(base + spoken);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      sessionRef.current = null;
      setVoice("idle");
      textareaRef.current?.focus();
    }
  };

  const placeholder = imagine
    ? "Describe an image to create…"
    : modes.search
      ? `Ask ${botName} with live web search…`
      : `Ask ${botName} anything`;

  return (
    <div className="composer-wrap">
      <div
        className={`composer${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        {(attachments.length > 0 || reading > 0) && (
          <div className="attachments">
            {attachments.map((a, i) => (
              <div className={`attachment ${a.kind}`} key={`${i}-${a.name}`}>
                {a.kind === "image" ? (
                  <img src={a.dataUrl} alt={a.name} />
                ) : (
                  <div className="attachment-file" title={a.name}>
                    <FileText size={18} />
                    <span className="file-name">{a.name}</span>
                    <span className="muted">{formatBytes(a.size)}</span>
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((current) => current.filter((_, j) => j !== i))}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {reading > 0 && (
              <div className="attachment-file">
                <Loader2 size={16} className="spin" /> Reading…
              </div>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && streaming) {
              e.preventDefault();
              stopStreaming();
              return;
            }
            const isTouch = matchMedia("(hover: none)").matches;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && sendOnEnter && !isTouch) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-row">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_FILES}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" className="icon-btn" title="Attach images, PDFs or files" onClick={() => fileRef.current?.click()}>
            <Paperclip size={18} />
          </button>
          <button
            type="button"
            className={`pill${modes.search && !imagine ? " on" : ""}`}
            aria-pressed={modes.search}
            title="Search the web for fresh information"
            disabled={imagine}
            onClick={() => setMode("search", !modes.search)}
          >
            <Globe size={15} /> <span>Search</span>
          </button>
          <button
            type="button"
            className={`pill${modes.think && !imagine ? " on" : ""}`}
            aria-pressed={modes.think}
            title="Think harder before answering (reasoning models)"
            disabled={imagine}
            onClick={() => setMode("think", !modes.think)}
          >
            <Lightbulb size={15} /> <span>Think</span>
          </button>
          <button
            type="button"
            className={`pill${imagine ? " on" : ""}`}
            aria-pressed={imagine}
            title="Create an image"
            onClick={() => setImagine((v) => !v)}
          >
            <Sparkles size={15} /> <span>Imagine</span>
          </button>
          <div className="spacer" />
          <button
            type="button"
            className={`icon-btn${voice === "dictating" || voice === "recording" ? " on" : ""}`}
            title={
              voice === "recording" || voice === "dictating"
                ? "Stop and insert text"
                : voice === "transcribing"
                  ? "Transcribing…"
                  : "Voice input"
            }
            disabled={voice === "transcribing"}
            onClick={() => void toggleVoice()}
          >
            {voice === "transcribing" ? <Loader2 size={18} className="spin" /> : <Mic size={18} />}
          </button>
          <button type="button" className="icon-btn voice-btn" title="Voice mode: talk hands-free" onClick={onVoiceMode}>
            <AudioLines size={18} />
          </button>
          {streaming ? (
            <button type="button" className="send-btn" title="Stop (Esc)" onClick={stopStreaming}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              title="Send"
              disabled={(!text.trim() && !attachments.length) || reading > 0}
              onClick={submit}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      {notice ? (
        <div className="composer-hint error-text">{notice}</div>
      ) : (
        <div className="composer-hint">
          {voice === "transcribing" && download !== null
            ? `Downloading the speech model (one time)… ${download}%`
            : voice === "recording" || voice === "dictating"
            ? "Listening… tap the mic again to stop."
            : "AI can make mistakes. Commands: /imagine, /search, /remember"}
        </div>
      )}
    </div>
  );
}
