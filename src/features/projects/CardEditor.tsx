import { LoaderCircle, MessageSquare, Play, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useStore } from "../../lib/store";
import { checklistProgress, locateCard, type Project } from "./model";
import {
  addChecklistItem,
  addComment,
  assignCard,
  deleteCard,
  moveCard,
  removeChecklistItem,
  updateCard,
  updateChecklistItem,
} from "./store";

/** Local text that is written to the board on blur and when the editor closes. */
function useDraft(value: string, commit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const latest = useRef({ draft: value, value, commit });
  latest.current = { draft, value, commit };
  useEffect(() => setDraft(value), [value]);
  useEffect(
    () => () => {
      const { draft: d, value: v, commit: c } = latest.current;
      if (d !== v) c(d);
    },
    [],
  );
  const flush = () => draft !== value && commit(draft);
  return [draft, setDraft, flush] as const;
}

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function CardEditor({
  project,
  cardId,
  onClose,
  onRun,
  onOpenChat,
}: {
  project: Project;
  cardId: string;
  onClose: () => void;
  onRun: (cardId: string) => void;
  onOpenChat: (conversationId: string) => void;
}) {
  const found = locateCard(project, cardId);
  const bots = useStore((s) => s.bots);
  const conversation = useStore((s) => (found?.card.conversationId ? s.conversations[found.card.conversationId] : undefined));
  const card = found?.card;
  const [title, setTitle, flushTitle] = useDraft(card?.title ?? "", (t) => card && t.trim() && updateCard(project.id, card.id, { title: t }));
  const [description, setDescription, flushDescription] = useDraft(card?.description ?? "", (d) => card && updateCard(project.id, card.id, { description: d }));
  const [label, setLabel] = useState("");
  const [item, setItem] = useState("");
  const [comment, setComment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!found) onClose();
  }, [found, onClose]);
  if (!found || !card) return null;

  const progress = checklistProgress(card);
  const running = card.run?.state === "running";
  const bot = bots.find((b) => b.id === card.botId);
  const addLabel = () => {
    if (!label.trim()) return;
    updateCard(project.id, card.id, { labels: [...card.labels, label] });
    setLabel("");
  };
  const addItem = () => {
    if (addChecklistItem(project.id, card.id, item)) setItem("");
  };
  const postComment = () => {
    if (addComment(project.id, card.id, comment)) setComment("");
  };

  return (
    <Dialog title="Card" onClose={onClose}>
      <div className="pj-editor">
        <div className="field">
          <label htmlFor="pj-card-title">Title</label>
          <input
            id="pj-card-title"
            className="input"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={flushTitle}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </div>

        <div className="field-row pj-wrap-row">
          <div className="field">
            <label htmlFor="pj-card-col">Column</label>
            <select id="pj-card-col" className="select" value={found.column.id} onChange={(e) => moveCard(project.id, card.id, e.target.value)}>
              {project.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pj-card-bot">Assignee</label>
            <select
              id="pj-card-bot"
              className="select"
              value={bot ? bot.id : ""}
              onChange={(e) => {
                const next = bots.find((b) => b.id === e.target.value);
                assignCard(project.id, card.id, next?.id ?? "", next?.name ?? "");
              }}
            >
              <option value="">Nobody</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pj-card-due">Due</label>
            <input id="pj-card-due" type="date" className="input" value={card.due ?? ""} onChange={(e) => updateCard(project.id, card.id, { due: e.target.value || undefined })} />
          </div>
        </div>

        <div className="pj-run-box">
          <div className="grow small">
            {running ? (
              <span className="pj-run running">
                <LoaderCircle size={13} className="spin" /> {bot?.name ?? "The bot"} is working on this…
              </span>
            ) : card.run?.state === "error" ? (
              <span className="pj-run error">Last run failed: {card.run.error}</span>
            ) : card.run?.state === "done" ? (
              <span className="pj-run done">Last run finished {when(card.run.finishedAt ?? card.run.startedAt)}</span>
            ) : (
              <span className="muted">{bot ? `Hand this card to ${bot.name}: it gets its own chat and moves to In progress, then Review.` : "Assign a bot to run this card."}</span>
            )}
          </div>
          <div className="btn-row">
            {card.conversationId &&
              (conversation ? (
                <button type="button" className="btn" onClick={() => onOpenChat(conversation.id)}>
                  <MessageSquare size={15} /> Open chat
                </button>
              ) : (
                <span className="muted small">Its chat was deleted</span>
              ))}
            <button
              type="button"
              className="btn primary"
              disabled={!bot || running}
              onClick={() => onRun(card.id)}
            >
              <Play size={15} /> {card.run ? "Run again" : "Run with bot"}
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="pj-card-desc">Description</label>
          <textarea
            id="pj-card-desc"
            className="textarea"
            style={{ minHeight: 90 }}
            value={description}
            placeholder="What needs doing, acceptance criteria, links…"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={flushDescription}
          />
        </div>

        <div className="field">
          <span className="field-label">Labels</span>
          <div className="pj-labels">
            {card.labels.map((l) => (
              <span key={l} className="pj-label">
                {l}
                <button type="button" aria-label={`Remove label ${l}`} onClick={() => updateCard(project.id, card.id, { labels: card.labels.filter((x) => x !== l) })}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <input
              className="input pj-label-input"
              value={label}
              maxLength={30}
              placeholder="Add label"
              aria-label="Add label"
              onChange={(e) => setLabel(e.target.value)}
              onBlur={addLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addLabel();
                }
              }}
            />
          </div>
        </div>

        <div className="field">
          <span className="field-label">
            Checklist {progress.total > 0 && <span className="muted">{`${progress.done}/${progress.total}`}</span>}
          </span>
          {progress.total > 0 && (
            <div className="pj-progress" aria-hidden="true">
              <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
          )}
          <ul className="pj-checklist">
            {card.checklist.map((i) => (
              <li key={i.id}>
                <input type="checkbox" checked={i.done} aria-label={i.text} onChange={(e) => updateChecklistItem(project.id, card.id, i.id, { done: e.target.checked })} />
                <span className={i.done ? "grow pj-done-text" : "grow"}>{i.text}</span>
                <button type="button" className="icon-btn pj-small-btn" aria-label={`Remove ${i.text}`} onClick={() => removeChecklistItem(project.id, card.id, i.id)}>
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="input-group"
            onSubmit={(e) => {
              e.preventDefault();
              addItem();
            }}
          >
            <input className="input" value={item} maxLength={300} placeholder="Add an item" aria-label="New checklist item" onChange={(e) => setItem(e.target.value)} />
            <button type="submit" className="btn" disabled={!item.trim()}>
              Add
            </button>
          </form>
        </div>

        <div className="field">
          <span className="field-label">Comments &amp; activity</span>
          <form
            className="pj-comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              postComment();
            }}
          >
            <textarea
              className="textarea"
              style={{ minHeight: 60 }}
              value={comment}
              placeholder="Write a comment"
              aria-label="Comment"
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  postComment();
                }
              }}
            />
            <button type="submit" className="btn" disabled={!comment.trim()}>
              Comment
            </button>
          </form>
          <ul className="pj-activity">
            {[...card.activity].reverse().map((a) => (
              <li key={a.id} className={a.kind}>
                <div className="pj-activity-head">
                  <strong>{a.author}</strong>
                  <span className="muted small">{when(a.at)}</span>
                </div>
                <div className={a.kind === "comment" ? "pj-comment-text" : "muted small"}>{a.text}</div>
              </li>
            ))}
          </ul>
        </div>

        <div className="btn-row dialog-actions" style={{ justifyContent: "space-between" }}>
          <span className="muted small">Created {when(card.createdAt)}</span>
          {confirmDelete ? (
            <div className="btn-row">
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  deleteCard(project.id, card.id);
                  onClose();
                }}
              >
                Delete card
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </div>
          ) : (
            <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={15} /> Delete…
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
