/**
 * Projects and their kanban boards: types and pure board algebra.
 *
 * Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors
 * (src/shared/projects.ts, src/main/store/board.ts). Every function takes a project and returns the
 * next one, or null when the card or column it was pointed at isn't there, so the store, the tools
 * and the drag-and-drop layer all agree on what "move this card there" means.
 */

export type ChecklistItem = { id: string; text: string; done: boolean };

export type Activity = {
  id: string;
  at: number;
  /** A comment someone wrote, or an event the board recorded (moved, assigned, run…). */
  kind: "comment" | "event";
  /** "You", or the bot's name. */
  author: string;
  text: string;
};

export type CardRun = {
  state: "running" | "done" | "error";
  botId: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type Card = {
  id: string;
  title: string;
  description: string;
  /** Bot responsible for this card. */
  botId?: string;
  labels: string[];
  /** YYYY-MM-DD. */
  due?: string;
  checklist: ChecklistItem[];
  /** Newest last. */
  activity: Activity[];
  /** Chat that works on this card. */
  conversationId?: string;
  /** Last "Run with bot". */
  run?: CardRun;
  createdAt: number;
  updatedAt: number;
};

export type Column = {
  /** Default columns keep fixed ids (backlog, todo, doing, review, done) so renaming them never breaks "Run with bot". */
  id: string;
  name: string;
  /** Work that reaches this column is finished. */
  done: boolean;
  /** Card order is array order. */
  cards: Card[];
};

export type Project = {
  id: string;
  name: string;
  description: string;
  /** Knowledge and instructions every task in this project carries to its bot. */
  instructions: string;
  columns: Column[];
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_COLUMNS: ReadonlyArray<{ id: string; name: string; done: boolean }> = [
  { id: "backlog", name: "Backlog", done: false },
  { id: "todo", name: "To do", done: false },
  { id: "doing", name: "In progress", done: false },
  { id: "review", name: "Review", done: false },
  { id: "done", name: "Done", done: true },
];

const MAX_COLUMNS = 24;
const MAX_CARDS_PER_COLUMN = 500;
const TITLE_MAX = 200;
const TEXT_MAX = 8000;
const NAME_MAX = 60;
const LABEL_MAX = 30;
const MAX_LABELS = 12;
const MAX_CHECKLIST = 100;
const MAX_ACTIVITY = 200;

export const newId = () => crypto.randomUUID();

/** Trim, fall back, and cap — the same treatment every text field gets. */
export function clip(value: unknown, fallback: string, max: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return (raw || fallback).slice(0, max);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function normaliseLabels(value: unknown): string[] {
  // Small models send labels as a JSON string ("[]", "[\"urgent\"]") as often as a real list.
  if (typeof value === "string" && value.trim().startsWith("[")) {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      value = text.replace(/[[\]"']/g, "");
    }
  }
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: string[] = [];
  for (const item of list) {
    const label = clip(item, "", LABEL_MAX);
    if (label && !out.some((l) => l.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out.slice(0, MAX_LABELS);
}

export function normaliseDue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : undefined;
}

export function makeProject(partial: Partial<Pick<Project, "name" | "description" | "instructions">> = {}): Project {
  const now = Date.now();
  return {
    id: newId(),
    name: clip(partial.name, "New project", 120),
    description: typeof partial.description === "string" ? partial.description.slice(0, TEXT_MAX) : "",
    instructions: typeof partial.instructions === "string" ? partial.instructions.slice(0, TEXT_MAX) : "",
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c, cards: [] })),
    createdAt: now,
    updatedAt: now,
  };
}

export type CardInput = Partial<Pick<Card, "title" | "description" | "botId" | "labels" | "due" | "conversationId">>;

/** Ids and timestamps are ours; only the text comes from the caller. */
export function makeCard(partial: CardInput): Card {
  const now = Date.now();
  const card: Card = {
    id: newId(),
    title: clip(partial.title, "New card", TITLE_MAX),
    description: typeof partial.description === "string" ? partial.description.slice(0, TEXT_MAX) : "",
    labels: normaliseLabels(partial.labels),
    checklist: [],
    activity: [],
    createdAt: now,
    updatedAt: now,
  };
  if (partial.botId) card.botId = partial.botId;
  const due = normaliseDue(partial.due);
  if (due) card.due = due;
  if (partial.conversationId) card.conversationId = partial.conversationId;
  return card;
}

export type CardLocation = { column: Column; columnIndex: number; index: number; card: Card };

export function locateCard(project: Project | null | undefined, cardId: string): CardLocation | null {
  if (!project) return null;
  for (let columnIndex = 0; columnIndex < project.columns.length; columnIndex++) {
    const column = project.columns[columnIndex];
    const index = column.cards.findIndex((c) => c.id === cardId);
    if (index >= 0) return { column, columnIndex, index, card: column.cards[index] };
  }
  return null;
}

const touch = (project: Project, columns: Column[]): Project => ({ ...project, columns, updatedAt: Date.now() });

export function insertCard(project: Project, columnId: string, partial: CardInput, atTop = false): { project: Project; card: Card } | null {
  const into = project.columns.find((c) => c.id === columnId);
  if (!into || into.cards.length >= MAX_CARDS_PER_COLUMN) return null;
  const card = makeCard(partial);
  const columns = project.columns.map((c) =>
    c.id === columnId ? { ...c, cards: atTop ? [card, ...c.cards] : [...c.cards, card] } : c,
  );
  return { project: touch(project, columns), card };
}

export type CardPatch = Partial<Pick<Card, "title" | "description" | "botId" | "labels" | "due" | "conversationId" | "checklist" | "run">>;

function mergeCard(card: Card, patch: CardPatch): Card {
  const next: Card = { ...card, updatedAt: Date.now() };
  if (patch.title !== undefined) next.title = clip(patch.title, card.title, TITLE_MAX);
  if (patch.description !== undefined) next.description = String(patch.description ?? "").slice(0, TEXT_MAX);
  if (patch.labels !== undefined) next.labels = normaliseLabels(patch.labels);
  if (patch.checklist !== undefined) next.checklist = patch.checklist.slice(0, MAX_CHECKLIST);
  if ("due" in patch) next.due = normaliseDue(patch.due);
  if ("botId" in patch) next.botId = patch.botId || undefined;
  if ("conversationId" in patch) next.conversationId = patch.conversationId || undefined;
  if ("run" in patch) next.run = patch.run;
  // An empty assignment means "unassign"; keep absent keys absent.
  for (const key of ["due", "botId", "conversationId", "run"] as const) if (next[key] === undefined) delete next[key];
  return next;
}

/** Identity and creation time stay ours whatever the patch claims. */
export function patchCard(project: Project, cardId: string, patch: CardPatch): Project | null {
  if (!locateCard(project, cardId)) return null;
  return touch(
    project,
    project.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => (card.id === cardId ? mergeCard(card, patch) : card)),
    })),
  );
}

/** Applies a function to one card (checklist edits, activity…). */
export function mapCard(project: Project, cardId: string, fn: (card: Card) => Card): Project | null {
  if (!locateCard(project, cardId)) return null;
  return touch(
    project,
    project.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => (card.id === cardId ? { ...fn(card), id: card.id, updatedAt: Date.now() } : card)),
    })),
  );
}

export function appendActivity(card: Card, entry: Omit<Activity, "id" | "at">): Card {
  const item: Activity = { id: newId(), at: Date.now(), ...entry, text: entry.text.slice(0, TEXT_MAX) };
  return { ...card, activity: [...card.activity, item].slice(-MAX_ACTIVITY) };
}

/**
 * The drag-and-drop primitive, for moves within a column as well as between them. The card leaves
 * its old slot first, so `toIndex` is read against the column once that gap has closed.
 * Out-of-range indices clamp to the ends (Infinity = append).
 */
export function relocateCard(project: Project, cardId: string, toColumnId: string, toIndex: number): Project | null {
  const found = locateCard(project, cardId);
  if (!found) return null;
  const destination = project.columns.findIndex((c) => c.id === toColumnId);
  if (destination === -1) return null;
  const columns = project.columns.map((c) => ({ ...c, cards: c.cards.filter((entry) => entry.id !== cardId) }));
  const target = columns[destination];
  const cards = [...target.cards];
  cards.splice(clamp(toIndex, 0, cards.length), 0, { ...found.card, updatedAt: Date.now() });
  columns[destination] = { ...target, cards };
  return touch(project, columns);
}

/**
 * Index for "drop before this card" (null = at the end), computed after the dragged card is
 * lifted out. Working from an anchor card rather than a visual slot keeps drops right while a
 * filter hides some cards.
 */
export function indexBefore(project: Project, cardId: string, toColumnId: string, beforeCardId: string | null): number {
  const column = project.columns.find((c) => c.id === toColumnId);
  if (!column) return 0;
  const rest = column.cards.filter((c) => c.id !== cardId);
  if (!beforeCardId) return rest.length;
  const index = rest.findIndex((c) => c.id === beforeCardId);
  return index === -1 ? rest.length : index;
}

export function dropCard(project: Project, cardId: string): Project | null {
  if (!locateCard(project, cardId)) return null;
  return touch(
    project,
    project.columns.map((c) => ({ ...c, cards: c.cards.filter((card) => card.id !== cardId) })),
  );
}

export function appendColumn(project: Project, name: string): Project | null {
  if (project.columns.length >= MAX_COLUMNS) return null;
  const column: Column = { id: newId(), name: clip(name, "New column", NAME_MAX), done: false, cards: [] };
  return touch(project, [...project.columns, column]);
}

export function renameColumnIn(project: Project, columnId: string, name: string): Project | null {
  const current = project.columns.find((c) => c.id === columnId);
  if (!current) return null;
  return touch(
    project,
    project.columns.map((c) => (c.id === columnId ? { ...c, name: clip(name, current.name, NAME_MAX) } : c)),
  );
}

export function markColumnDone(project: Project, columnId: string, done: boolean): Project | null {
  if (!project.columns.some((c) => c.id === columnId)) return null;
  return touch(project, project.columns.map((c) => (c.id === columnId ? { ...c, done } : c)));
}

/** Moves a column one step left (-1) or right (+1). */
export function shiftColumn(project: Project, columnId: string, delta: -1 | 1): Project | null {
  const index = project.columns.findIndex((c) => c.id === columnId);
  const to = index + delta;
  if (index === -1 || to < 0 || to >= project.columns.length) return null;
  const columns = [...project.columns];
  [columns[index], columns[to]] = [columns[to], columns[index]];
  return touch(project, columns);
}

/** Where a removed column's cards go: the column to its left, or the new leftmost. */
export function rehomeColumn(columns: ReadonlyArray<Column>, columnId: string): Column | null {
  const index = columns.findIndex((c) => c.id === columnId);
  if (index === -1 || columns.length <= 1) return null;
  const remaining = columns.filter((c) => c.id !== columnId);
  return remaining[Math.max(0, index - 1)] ?? null;
}

/** Cards outlive their column; the last column can't be removed. */
export function dropColumn(project: Project, columnId: string): Project | null {
  const doomed = project.columns.find((c) => c.id === columnId);
  const home = rehomeColumn(project.columns, columnId);
  if (!doomed || !home) return null;
  return touch(
    project,
    project.columns
      .filter((c) => c.id !== columnId)
      .map((c) => (c.id === home.id ? { ...c, cards: [...c.cards, ...doomed.cards] } : c)),
  );
}

/** Outstanding work: every card not sitting in a finished column. */
export function countOpenCards(project: Project): number {
  return project.columns.reduce((total, c) => (c.done ? total : total + c.cards.length), 0);
}

const ALIASES: Record<string, string> = {
  backlog: "backlog",
  icebox: "backlog",
  todo: "todo",
  "to do": "todo",
  "to-do": "todo",
  next: "todo",
  doing: "doing",
  "in progress": "doing",
  "in-progress": "doing",
  in_progress: "doing",
  inprogress: "doing",
  progress: "doing",
  wip: "doing",
  started: "doing",
  review: "review",
  "in review": "review",
  reviewing: "review",
  done: "done",
  complete: "done",
  completed: "done",
  finished: "done",
  closed: "done",
};

/**
 * A column from a status the user or a bot typed: its id, its (current) name, or a common alias
 * ("in progress", "wip", "completed"…). Aliases find the default column even after a rename and
 * fall back to a column whose name reads the same.
 */
export function findColumn(project: Project, status: string): Column | null {
  const raw = status.trim().toLowerCase();
  if (!raw) return null;
  const byId = project.columns.find((c) => c.id.toLowerCase() === raw);
  if (byId) return byId;
  const byName = project.columns.find((c) => c.name.trim().toLowerCase() === raw);
  if (byName) return byName;
  const role = ALIASES[raw] ?? ALIASES[raw.replace(/_/g, " ")];
  if (!role) return null;
  const byRole = project.columns.find((c) => c.id === role);
  if (byRole) return byRole;
  const byAlias = project.columns.find((c) => ALIASES[c.name.trim().toLowerCase()] === role);
  if (byAlias) return byAlias;
  return role === "done" ? (project.columns.find((c) => c.done) ?? null) : null;
}

/** Checklist progress, e.g. "2/5". */
export function checklistProgress(card: Card): { done: number; total: number } {
  return { done: card.checklist.filter((i) => i.done).length, total: card.checklist.length };
}

/** Repairs anything loaded from storage so the board never crashes on an older or damaged record. */
export function normaliseProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<Project>;
  if (typeof p.id !== "string") return null;
  const columns = Array.isArray(p.columns) && p.columns.length ? p.columns : DEFAULT_COLUMNS.map((c) => ({ ...c, cards: [] }));
  return {
    id: p.id,
    name: clip(p.name, "Project", 120),
    description: typeof p.description === "string" ? p.description : "",
    instructions: typeof p.instructions === "string" ? p.instructions : "",
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now(),
    columns: columns.map((c) => ({
      id: String(c.id ?? newId()),
      name: clip(c.name, "Column", NAME_MAX),
      done: c.done === true,
      cards: (Array.isArray(c.cards) ? c.cards : [])
        .filter((card) => card && typeof card.id === "string")
        .map((card) => ({
          ...card,
          title: clip(card.title, "Card", TITLE_MAX),
          description: typeof card.description === "string" ? card.description : "",
          labels: normaliseLabels(card.labels),
          checklist: Array.isArray(card.checklist) ? card.checklist : [],
          activity: Array.isArray(card.activity) ? card.activity : [],
          createdAt: Number(card.createdAt) || Date.now(),
          updatedAt: Number(card.updatedAt) || Date.now(),
        })),
    })),
  };
}
