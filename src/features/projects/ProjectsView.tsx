/**
 * Projects workspace: the project list and each project's kanban board.
 *
 * Board interaction adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors
 * (renderer KanbanBoard/KanbanColumn/KanbanCard): HTML5 drag and drop for the mouse, a Move menu
 * for keyboards and touch screens.
 */
import { ArrowLeft, Calendar, Check, ListChecks, LoaderCircle, MessageCircle, MessageSquare, Pencil, Play, Plus, SquareKanban, TriangleAlert, X } from "lucide-react";
import { type DragEvent, useCallback, useMemo, useState } from "react";
import { BotAvatar } from "../../components/Avatar";
import { openConversation, useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { openView } from "../registry";
import { CardEditor } from "./CardEditor";
import { Menu, type MenuItem } from "./Menu";
import { type Card, checklistProgress, type Column, countOpenCards, indexBefore, type Project, rehomeColumn } from "./model";
import { ProjectEditor } from "./ProjectEditor";
import "./projects.css";
import { runCardWithBot } from "./run";
import {
  addCard,
  addColumn,
  deleteCard,
  moveCard,
  moveColumn,
  openProject,
  removeColumn,
  renameColumn,
  setColumnDone,
  useProjects,
} from "./store";

export default function ProjectsView() {
  const hydrated = useProjects((s) => s.hydrated);
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId));
  if (!hydrated) return <div className="muted small" style={{ padding: 20 }}>Loading…</div>;
  return project ? <BoardView project={project} /> : <ProjectList />;
}

// Project list ------------------------------------------------------------------------------

function ProjectList() {
  const projects = useProjects((s) => s.projects);
  const [creating, setCreating] = useState(false);
  return (
    <div className="pj-list-page">
      <div className="pj-list-head">
        <div>
          <h2>Projects</h2>
          <p className="muted small">Boards of tasks your bots can work through. Assign a card to a bot and run it.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> New project
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="empty pj-empty">
          <SquareKanban size={30} />
          <h1>No projects yet</h1>
          <p className="muted">Create a project, add cards to its board, and hand them to your bots.</p>
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> Create your first project
          </button>
        </div>
      ) : (
        <div className="pj-grid">
          {projects.map((p) => {
            const total = p.columns.reduce((n, c) => n + c.cards.length, 0);
            return (
              <button key={p.id} type="button" className="pj-tile" onClick={() => openProject(p.id)}>
                <strong>{p.name}</strong>
                {p.description.trim() && <span className="muted small pj-clamp">{p.description}</span>}
                <span className="pj-bar" aria-hidden="true">
                  {total > 0 &&
                    p.columns.map((c) => c.cards.length > 0 && <span key={c.id} className={c.done ? "done" : undefined} style={{ flex: c.cards.length }} />)}
                </span>
                <span className="muted small">
                  {countOpenCards(p)} open · {total} card{total === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {creating && <ProjectEditor onClose={() => setCreating(false)} />}
    </div>
  );
}

// Board ----------------------------------------------------------------------------------------

type DropTarget = { columnId: string; before: string | null };

/** The card the pointer is above (drop goes before it), or null for the end of the column. */
function anchorAt(list: HTMLElement, clientY: number, dragged: string): string | null {
  for (const el of Array.from(list.querySelectorAll<HTMLElement>("[data-card]"))) {
    if (el.dataset.card === dragged) continue;
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return el.dataset.card ?? null;
  }
  return null;
}

function BoardView({ project }: { project: Project }) {
  const bots = useStore((s) => s.bots);
  const [botFilter, setBotFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnName, setColumnName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b] as const)), [bots]);

  const visible = (card: Card) => {
    if (botFilter === "none" ? card.botId && botMap.has(card.botId) : botFilter !== "all" && card.botId !== botFilter) return false;
    const q = query.trim().toLowerCase();
    return !q || card.title.toLowerCase().includes(q) || card.description.toLowerCase().includes(q) || card.labels.some((l) => l.toLowerCase().includes(q));
  };

  const clearDrag = () => {
    setDrag(null);
    setDrop(null);
  };
  const commitDrop = (target: DropTarget) => {
    if (drag) moveCard(project.id, drag, target.columnId, indexBefore(project, drag, target.columnId, target.before));
    clearDrag();
  };

  const run = useCallback(
    (cardId: string) => {
      setNotice(null);
      void runCardWithBot(project.id, cardId).then((result) => {
        if (!result.ok) setNotice(result.error);
      });
    },
    [project.id],
  );
  const openChat = useCallback((conversationId: string) => {
    openConversation(conversationId);
    openView(null);
  }, []);

  const total = project.columns.reduce((n, c) => n + c.cards.length, 0);
  const filtering = botFilter !== "all" || query.trim() !== "";

  return (
    <div className="pj-board-page">
      <div className="pj-toolbar">
        <button type="button" className="icon-btn" aria-label="All projects" title="All projects" onClick={() => openProject(null)}>
          <ArrowLeft size={18} />
        </button>
        <div className="pj-title">
          <h2>{project.name}</h2>
          <span className="muted small">
            {countOpenCards(project)} open · {total} card{total === 1 ? "" : "s"}
          </span>
        </div>
        <button type="button" className="icon-btn" aria-label="Edit project" title="Edit project" onClick={() => setEditingProject(true)}>
          <Pencil size={16} />
        </button>
        <div className="pj-filters">
          <select className="select" value={botFilter} aria-label="Filter by bot" onChange={(e) => setBotFilter(e.target.value)}>
            <option value="all">All bots</option>
            <option value="none">Unassigned</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <input className="input" type="search" value={query} placeholder="Filter cards" aria-label="Filter cards" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {project.instructions.trim() === "" && project.description.trim() === "" && total === 0 && (
        <p className="pj-hint muted small">
          Tip: add knowledge and instructions to the project (pencil icon) — the bot gets them with every card it runs.
        </p>
      )}
      {notice && (
        <div className="pj-notice" role="alert">
          <TriangleAlert size={15} />
          <span className="grow">{notice}</span>
          <button type="button" className="icon-btn pj-small-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="pj-board" onDragEnd={clearDrag}>
        {project.columns.map((column, index) => (
          <KanbanColumn
            key={column.id}
            project={project}
            column={column}
            index={index}
            cards={column.cards.filter(visible)}
            hidden={filtering ? column.cards.length - column.cards.filter(visible).length : 0}
            bots={botMap}
            drag={drag}
            drop={drop?.columnId === column.id ? drop : null}
            onDragStart={setDrag}
            onDragOver={(target) => setDrop((d) => (d && d.columnId === target.columnId && d.before === target.before ? d : target))}
            onDrop={commitDrop}
            onOpen={setEditingId}
            onRun={run}
            onOpenChat={openChat}
            onAdd={(title) => {
              const card = addCard(project.id, column.id, { title, botId: botFilter !== "all" && botFilter !== "none" ? botFilter : undefined });
              if (!card) setNotice("That column is full.");
            }}
          />
        ))}
        <div className="pj-newcol">
          {addingColumn ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (columnName.trim()) addColumn(project.id, columnName);
                setColumnName("");
                setAddingColumn(false);
              }}
            >
              <input
                className="input"
                autoFocus
                maxLength={60}
                value={columnName}
                placeholder="Column name"
                aria-label="New column name"
                onChange={(e) => setColumnName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setAddingColumn(false);
                  }
                }}
              />
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button type="submit" className="btn primary" disabled={!columnName.trim()}>
                  Add
                </button>
                <button type="button" className="btn" onClick={() => setAddingColumn(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="pj-addcol" onClick={() => setAddingColumn(true)}>
              <Plus size={14} /> Add column
            </button>
          )}
        </div>
      </div>

      {editingId && <CardEditor project={project} cardId={editingId} onClose={() => setEditingId(null)} onRun={run} onOpenChat={openChat} />}
      {editingProject && <ProjectEditor project={project} onClose={() => setEditingProject(false)} />}
    </div>
  );
}

// Column -----------------------------------------------------------------------------------------

function KanbanColumn(props: {
  project: Project;
  column: Column;
  index: number;
  cards: Card[];
  hidden: number;
  bots: Map<string, Bot>;
  drag: string | null;
  drop: DropTarget | null;
  onDragStart: (cardId: string) => void;
  onDragOver: (target: DropTarget) => void;
  onDrop: (target: DropTarget) => void;
  onOpen: (cardId: string) => void;
  onRun: (cardId: string) => void;
  onOpenChat: (conversationId: string) => void;
  onAdd: (title: string) => void;
}) {
  const { project, column, index, cards, drag, drop } = props;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const home = rehomeColumn(project.columns, column.id);

  const track = (e: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    props.onDragOver({ columnId: column.id, before: anchorAt(e.currentTarget, e.clientY, drag) });
  };

  const commitRename = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== column.name) renameColumn(project.id, column.id, name);
  };

  const menu: MenuItem[] = [
    { label: "Add a card", onSelect: () => setAdding(true) },
    {
      label: "Rename",
      onSelect: () => {
        setName(column.name);
        setRenaming(true);
      },
    },
    { label: "Move column left", onSelect: () => moveColumn(project.id, column.id, -1), disabled: index === 0 },
    { label: "Move column right", onSelect: () => moveColumn(project.id, column.id, 1), disabled: index === project.columns.length - 1 },
    { label: column.done ? "Don't count as finished" : "Count cards here as finished", onSelect: () => setColumnDone(project.id, column.id, !column.done) },
    "separator",
    { label: "Delete column…", danger: true, disabled: !home, onSelect: () => setConfirmRemove(true) },
  ];

  return (
    <section className={`pj-col${column.done ? " is-done" : ""}`} aria-label={`${column.name}, ${column.cards.length} cards`}>
      <header className="pj-col-head">
        {renaming ? (
          <input
            className="input pj-col-rename"
            autoFocus
            value={name}
            maxLength={60}
            aria-label={`Rename ${column.name}`}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(column.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <>
            <h3 onDoubleClick={() => setRenaming(true)}>
              {column.name}
              {column.done && <Check size={13} className="pj-done-mark" aria-label="Finished work" />}
            </h3>
            <span className="pj-count">{props.hidden ? `${cards.length}/${column.cards.length}` : column.cards.length}</span>
            <button type="button" className="icon-btn pj-small-btn" aria-label={`Add a card to ${column.name}`} title="Add a card" onClick={() => setAdding(true)}>
              <Plus size={15} />
            </button>
            <Menu label={`${column.name} options`} items={menu} />
          </>
        )}
      </header>
      {confirmRemove && home && (
        <div className="pj-confirm small">
          Delete “{column.name}”? Its {column.cards.length} card{column.cards.length === 1 ? "" : "s"} move to {home.name}.
          <div className="btn-row">
            <button type="button" className="btn danger" onClick={() => removeColumn(project.id, column.id)}>
              Delete
            </button>
            <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div
        className={`pj-col-body${drop ? " is-target" : ""}`}
        onDragEnter={track}
        onDragOver={track}
        onDragLeave={(e) => {
          if (drag && !e.currentTarget.contains(e.relatedTarget as Node | null)) props.onDragOver({ columnId: "", before: null });
        }}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          props.onDrop({ columnId: column.id, before: anchorAt(e.currentTarget, e.clientY, drag) });
        }}
      >
        {cards.length === 0 && !drop && <p className="pj-col-empty muted small">{props.hidden ? "No matching cards" : "Nothing here yet"}</p>}
        {cards.map((card, i) => (
          <div key={card.id} className="pj-slot">
            {drop?.before === card.id && <span className="pj-drop" aria-hidden="true" />}
            <KanbanCard
              project={project}
              column={column}
              card={card}
              index={i}
              bot={card.botId ? props.bots.get(card.botId) : undefined}
              dragging={drag === card.id}
              onDragStart={() => props.onDragStart(card.id)}
              onOpen={() => props.onOpen(card.id)}
              onRun={() => props.onRun(card.id)}
              onOpenChat={props.onOpenChat}
              neighbours={cards}
            />
          </div>
        ))}
        {drop && drop.before === null && <span className="pj-drop" aria-hidden="true" />}
      </div>

      {adding ? (
        <form
          className="pj-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            props.onAdd(title.trim());
            setTitle("");
          }}
        >
          <input
            className="input"
            autoFocus
            value={title}
            maxLength={200}
            placeholder="What needs doing?"
            aria-label={`New card in ${column.name}`}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setTitle("");
                setAdding(false);
              }
            }}
          />
          <div className="btn-row">
            <button type="submit" className="btn primary" disabled={!title.trim()}>
              Add card
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTitle("");
                setAdding(false);
              }}
            >
              Done
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="pj-addcard" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add a card
        </button>
      )}
    </section>
  );
}

// Card ---------------------------------------------------------------------------------------------

function dueState(due: string | undefined, done: boolean): "" | "soon" | "overdue" {
  if (!due || done) return "";
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (due < todayKey) return "overdue";
  const soon = new Date(today.getTime() + 2 * 86400000);
  const soonKey = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  return due <= soonKey ? "soon" : "";
}

function KanbanCard(props: {
  project: Project;
  column: Column;
  card: Card;
  /** Position among the visible cards of this column. */
  index: number;
  neighbours: Card[];
  bot?: Bot;
  dragging: boolean;
  onDragStart: () => void;
  onOpen: () => void;
  onRun: () => void;
  onOpenChat: (conversationId: string) => void;
}) {
  const { project, column, card, index, neighbours, bot } = props;
  const progress = checklistProgress(card);
  const running = card.run?.state === "running";
  const due = dueState(card.due, column.done);
  const comments = card.activity.filter((a) => a.kind === "comment").length;
  const chatExists = useStore((s) => Boolean(card.conversationId && s.conversations[card.conversationId]));

  // Moves are relative to visible neighbours, so they stay intuitive while a filter is on.
  const moveBefore = (anchor: string | null) => moveCard(project.id, card.id, column.id, indexBefore(project, card.id, column.id, anchor));
  const menu: MenuItem[] = [
    { label: "Open", onSelect: props.onOpen },
    { label: running ? "Running…" : "Run with bot", disabled: !bot || running, onSelect: props.onRun },
    ...(card.conversationId && chatExists ? [{ label: "Open chat", onSelect: () => props.onOpenChat(card.conversationId!) }] : []),
    "separator",
    { label: "Move up", disabled: index === 0, onSelect: () => moveBefore(neighbours[index - 1]?.id ?? null) },
    { label: "Move down", disabled: index >= neighbours.length - 1, onSelect: () => moveBefore(neighbours[index + 2]?.id ?? null) },
    ...project.columns.filter((c) => c.id !== column.id).map((c) => ({ label: `Move to ${c.name}`, onSelect: () => moveCard(project.id, card.id, c.id) })),
    "separator",
    { label: "Delete card", danger: true, onSelect: () => deleteCard(project.id, card.id) },
  ];

  return (
    <article
      className={`pj-card${props.dragging ? " is-dragging" : ""}${running ? " is-running" : ""}`}
      data-card={card.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        props.onDragStart();
      }}
    >
      <button type="button" className="pj-card-main" onClick={props.onOpen} aria-label={`Open card ${card.title}`}>
        {card.labels.length > 0 && (
          <span className="pj-labels small-labels">
            {card.labels.map((l) => (
              <span key={l} className="pj-label">
                {l}
              </span>
            ))}
          </span>
        )}
        <span className="pj-card-title">{card.title}</span>
      </button>
      <div className="pj-card-foot">
        {bot && (
          <span className="pj-meta" title={`Assigned to ${bot.name}`}>
            <BotAvatar bot={bot} size="mini" />
          </span>
        )}
        {card.due && (
          <span className={`pj-meta pj-due ${due}`} title={due === "overdue" ? "Overdue" : "Due"}>
            <Calendar size={12} /> {card.due.slice(5)}
          </span>
        )}
        {progress.total > 0 && (
          <span className={`pj-meta${progress.done === progress.total ? " pj-complete" : ""}`} title="Checklist">
            <ListChecks size={12} /> {progress.done}/{progress.total}
          </span>
        )}
        {comments > 0 && (
          <span className="pj-meta" title="Comments">
            <MessageCircle size={12} /> {comments}
          </span>
        )}
        {running && (
          <span className="pj-meta pj-run running" title="The bot is working on this">
            <LoaderCircle size={12} className="spin" /> Running
          </span>
        )}
        {card.run?.state === "error" && (
          <span className="pj-meta pj-run error" title={card.run.error}>
            <TriangleAlert size={12} /> Failed
          </span>
        )}
        <span className="grow" />
        {card.conversationId && chatExists && (
          <button type="button" className="icon-btn pj-small-btn" aria-label={`Open the chat for ${card.title}`} title="Open chat" onClick={() => props.onOpenChat(card.conversationId!)}>
            <MessageSquare size={14} />
          </button>
        )}
        {bot && !running && (
          <button type="button" className="icon-btn pj-small-btn" aria-label={`Run ${card.title} with ${bot.name}`} title={`Run with ${bot.name}`} disabled={running} onClick={props.onRun}>
            <Play size={14} />
          </button>
        )}
        <Menu label={`Actions for ${card.title}`} items={menu} />
      </div>
    </article>
  );
}
