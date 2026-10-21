import { ArrowUp, AudioLines, FileText, Globe, Lightbulb, Loader2, Mic, Paperclip, Sparkles, Square, Telescope, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendMessage, stopStreaming } from "../lib/chat";
import { ACCEPTED_FILES, fileToAttachment, formatBytes } from "../lib/images";
import { warmSemanticSearch } from "../lib/semantic";
import { updateSettings, useStore } from "../lib/store";
import type { Attachment } from "../lib/types";
import { listen, type ListenSession, resolveEngine, warmVoice } from "../lib/voice";
import { onWhisperProgress } from "../lib/whisper";
import { skillsFor } from "../features/skills/skills";

/** Commands the message box understands (skills add their own /names). */
const COMMANDS = [
  { name: "imagine", description: "Create an image" },
  { name: "search", description: "Answer with live web search" },
  { name: "research", description: "Deep research: many sources, a cited report" },
  { name: "remember", description: "Save a fact about you" },
];

type Voice = "idle" | "dictating" | "recording" | "transcribing";

/** Hovering the voice-mode button gets its screen and speech engine ready before the click. */
function warmVoiceMode() {
  const { settings, providers } = useStore.getState();
  void import("./VoiceMode");
  warmVoice(settings.voice, providers);
  warmSemanticSearch();
}

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
  const [research, setResearch] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [voice, setVoice] = useState<Voice>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const activeBot = useStore((s) => s.bots.find((b) => b.id === s.activeBotId));
  const skills = useStore((s) => s.skills);
  // Typing "/name": commands and this bot's skills that start with what's typed.
  const slash = /^\/([a-z0-9-]*)$/i.exec(text);
  const suggestions = slash
    ? [
        ...COMMANDS.map((c) => ({ ...c, skill: false })),
        ...(activeBot ? skillsFor(activeBot, skills) : []).map((s) => ({ name: s.name, description: s.description, skill: true })),
      ]
        .filter((c) => c.name.startsWith(slash[1].toLowerCase()))
        .slice(0, 8)
    : [];
  const pick = (name: string) => {
    setText(`/${name} `);
    setMenuIndex(0);
    textareaRef.current?.focus();
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** The message in the box was spoken with the mic button (see Settings → Voice → read replies aloud). */
  const dictatedRef = useRef(false);
  const sessionRef = useRef<ListenSession | null>(null);
  // Cleared the box and typed instead: no longer a dictated message.
  useEffect(() => {
    if (!text) dictatedRef.current = false;
  }, [text]);
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
    void sendMessage(text, attachments, { search: modes.search, think: modes.think, imagine, research: research && !imagine, dictated: dictatedRef.current });
    dictatedRef.current = false;
    setText("");
    setAttachments([]);
    setImagine(false);
    setResearch(false);
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
      if (spoken) {
        setText(base + spoken);
        dictatedRef.current = true;
      }
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
    : research
      ? "What should I research? (takes a few minutes)"
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
        {suggestions.length > 0 && (
          <ul className="slash-menu" role="listbox" aria-label="Commands and skills">
            {suggestions.map((c, i) => (
              <li key={`${c.skill}-${c.name}`} role="option" aria-selected={i === Math.min(menuIndex, suggestions.length - 1)}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.name)}>
                  <code>/{c.name}</code>
                  <span className="muted small">{c.skill ? `Skill: ${c.description}` : c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          onFocus={warmSemanticSearch}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (suggestions.length && !e.nativeEvent.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pick(suggestions[Math.min(menuIndex, suggestions.length - 1)].name);
                return;
              }
            }
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
            className={`pill${research && !imagine ? " on" : ""}`}
            aria-pressed={research}
            title="Deep research: searches many sources, reads them and writes a cited report"
            disabled={imagine}
            onClick={() => setResearch((v) => !v)}
          >
            <Telescope size={15} /> <span>Research</span>
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
          <button
            type="button"
            className="icon-btn voice-btn"
            title="Voice mode: talk hands-free"
            onClick={onVoiceMode}
            onPointerEnter={warmVoiceMode}
            onFocus={warmVoiceMode}
          >
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
            : "AI can make mistakes. Type / for commands and skills"}
        </div>
      )}
    </div>
  );
}
