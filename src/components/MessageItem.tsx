import { BookOpen, Brain, ChevronRight, Download, FileText, Loader2, Pencil, RotateCcw, Settings2, Volume2 } from "lucide-react";
import { lazy, memo, Suspense, useState } from "react";
import { resendFrom, stripMemoryTags } from "../lib/chat";
import { formatBytes } from "../lib/images";
import { splitThink } from "../lib/llm";
import type { Message, Source } from "../lib/types";
import { useStore } from "../lib/store";
import { canSpeak, speak } from "../lib/voice";
import { Avatar } from "./Avatar";
import { CopyButton } from "./CopyButton";

const Markdown = lazy(() => import("./Markdown"));

export function openSettings(tab?: string) {
  window.dispatchEvent(new CustomEvent("adt:open-settings", { detail: tab }));
}

async function saveImage(dataUrl: string, name: string) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], name, { type: blob.type || "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch {
    // Fall back to a plain download.
  }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  a.click();
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="sources">
      {sources.map((s, i) => (
        <a key={s.url} className="source" href={s.url} target="_blank" rel="noreferrer noopener" title={s.snippet}>
          <span className="source-n">{i + 1}</span>
          <span className="source-text">
            <span className="source-title">{s.title || host(s.url)}</span>
            <span className="source-host">{host(s.url)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

function Stats({ message }: { message: Message }) {
  if (!message.stats) return message.model ? <span className="msg-meta">{message.model}</span> : null;
  const { ms, firstMs } = message.stats;
  const genMs = ms - (firstMs ?? 0);
  const tokens = message.content.length / 4;
  const speed = genMs > 300 && tokens > 20 ? ` · ${Math.round(tokens / (genMs / 1000))} tok/s` : "";
  return (
    <span className="msg-meta" title={firstMs ? `First token after ${(firstMs / 1000).toFixed(1)}s` : undefined}>
      {message.model} · {(ms / 1000).toFixed(1)}s{speed}
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  avatar,
  conversationId,
  busy,
  live,
}: {
  message: Message;
  avatar: string;
  conversationId: string;
  /** A reply is streaming somewhere in this chat. */
  busy: boolean;
  /** This message is the one streaming. */
  live: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const images = (message.attachments ?? []).flatMap((a) => (a.kind === "image" ? [a] : []));
  const files = (message.attachments ?? []).flatMap((a) => (a.kind === "file" ? [a] : []));

  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="body">
          {images.length > 0 && (
            <div className="msg-images">
              {images.map((a, i) => (
                <img key={`${i}-${a.name}`} src={a.dataUrl} alt={a.name} loading="lazy" />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="file-chips">
              {files.map((f, i) => (
                <span className="file-chip" key={`${i}-${f.name}`} title={f.truncated ? "Long file: trimmed to fit" : undefined}>
                  <FileText size={14} /> <span className="file-name">{f.name}</span>
                  <span className="muted">{formatBytes(f.size)}</span>
                </span>
              ))}
            </div>
          )}
          {editing ? (
            <div className="edit-box">
              <textarea
                className="textarea"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    setEditing(false);
                    void resendFrom(conversationId, message.id, draft);
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
                <button type="button" className="btn" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setEditing(false);
                    void resendFrom(conversationId, message.id, draft);
                  }}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            message.content && <div className="bubble">{message.content}</div>
          )}
          {!editing && (
            <div className="msg-actions">
              <CopyButton text={message.content} className="icon-btn" />
              {!busy && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Edit and resend"
                  onClick={() => {
                    setDraft(message.content);
                    setEditing(true);
                  }}
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const inline = splitThink(stripMemoryTags(message.content));
  const reasoning = [message.reasoning, inline.reasoning].filter(Boolean).join("\n\n");
  const text = inline.text;
  const thinkingNow = live && (!text || inline.thinking);

  return (
    <div className="msg assistant">
      <Avatar value={avatar} />
      <div className="body">
        {message.status && (
          <div className={`msg-status${live ? " live" : ""}`}>
            {live && <Loader2 size={14} className="spin" />} {message.status}
          </div>
        )}
        {message.sources && message.sources.length > 0 && <Sources sources={message.sources} />}
        {message.knowledge && message.knowledge.length > 0 && (
          <div className="knowledge-used" title="Knowledge files used for this answer">
            <BookOpen size={13} /> {message.knowledge.join(", ")}
          </div>
        )}
        {reasoning && (
          <details className="reasoning" open={thinkingNow}>
            <summary>
              <Brain size={14} /> {thinkingNow ? "Thinking…" : "Thought process"} <ChevronRight size={14} className="chev" />
            </summary>
            <div className="reasoning-text">{reasoning}</div>
          </details>
        )}
        {text ? (
          <Suspense fallback={<div className="md plain">{text}</div>}>
            <Markdown text={text} sources={message.sources} live={live} />
          </Suspense>
        ) : (
          live &&
          !reasoning &&
          !message.status && (
            <div className="typing" aria-label="Waiting for reply">
              <i />
              <i />
              <i />
            </div>
          )
        )}
        {images.length > 0 && (
          <div className="generated">
            {images.map((a, i) => (
              <figure key={`${i}-${a.name}`}>
                <img src={a.dataUrl} alt={text || "Generated image"} loading="lazy" />
                <button type="button" className="btn" onClick={() => void saveImage(a.dataUrl, `adt-bot-${Date.now()}.png`)}>
                  <Download size={14} /> Save
                </button>
              </figure>
            ))}
          </div>
        )}
        {message.error && (
          <div className="msg-error">
            <div>{message.error}</div>
            {!busy && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button type="button" className="btn" onClick={() => void resendFrom(conversationId, message.id)}>
                  <RotateCcw size={14} /> Retry
                </button>
                <button type="button" className="btn" onClick={() => openSettings("providers")}>
                  <Settings2 size={14} /> Settings
                </button>
              </div>
            )}
          </div>
        )}
        {!live && (
          <div className="msg-actions">
            {text && <CopyButton text={text} className="icon-btn" />}
            {text && canSpeak() && (
              <button type="button" className="icon-btn" title="Read aloud" onClick={() => {
                  const { settings, providers } = useStore.getState();
                  speak(text, { voice: settings.voice, providers, useProxy: settings.useProxy });
                }}>
                <Volume2 size={15} />
              </button>
            )}
            {!busy && (
              <button type="button" className="icon-btn" title="Regenerate" onClick={() => void resendFrom(conversationId, message.id)}>
                <RotateCcw size={14} />
              </button>
            )}
            <Stats message={message} />
          </div>
        )}
      </div>
    </div>
  );
});
