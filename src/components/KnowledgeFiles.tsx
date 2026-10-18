import { BookOpen, Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "../lib/images";
import { addKnowledgeFile, FULL_TEXT_LIMIT, removeKnowledgeText } from "../lib/knowledge";
import type { KnowledgeRef } from "../lib/types";

export const KNOWLEDGE_ACCEPT = ".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json,.xml,.yaml,.yml,.rtf,.log,text/*";

/** Upload and manage knowledge files (company profile, handbook, product docs, instructions…). */
export function KnowledgeFiles({ refs, onChange, hint }: { refs: KnowledgeRef[]; onChange: (refs: KnowledgeRef[]) => void; hint: string }) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const total = refs.reduce((n, r) => n + r.chars, 0);

  const add = async (files: Iterable<File>) => {
    const list = [...files];
    if (!list.length) return;
    setError(null);
    setBusy((n) => n + list.length);
    const results = await Promise.allSettled(list.map(addKnowledgeFile));
    setBusy((n) => n - list.length);
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
    if (failed.length) setError(failed.join(" "));
    if (added.length) onChange([...refs, ...added]);
  };

  return (
    <div className="knowledge">
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void add(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        {busy ? <Loader2 size={18} className="spin" /> : <Upload size={18} />}
        <div>
          <strong>{busy ? "Reading…" : "Add files"}</strong>
          <div className="small muted">{hint} PDF, Word, Markdown, HTML, text, CSV, JSON.</div>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={KNOWLEDGE_ACCEPT}
          onChange={(e) => {
            if (e.target.files) void add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="small error-text">{error}</div>}
      {refs.length > 0 && (
        <ul className="knowledge-list">
          {refs.map((ref) => (
            <li key={ref.id}>
              <BookOpen size={15} className="muted" />
              <span className="grow ellipsis" title={ref.name}>
                {ref.name}
              </span>
              <span className="small muted">
                {formatBytes(ref.size)} · {Math.round(ref.chars / 4).toLocaleString()} tokens
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${ref.name}`}
                onClick={() => {
                  void removeKnowledgeText(ref.id);
                  onChange(refs.filter((r) => r.id !== ref.id));
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {total > 0 && (
        <div className="small muted">
          {total <= FULL_TEXT_LIMIT
            ? "Small enough to include in full with every question."
            : "Large: for each question, only the most relevant passages are sent, so chats stay fast and cheap."}
        </div>
      )}
    </div>
  );
}
