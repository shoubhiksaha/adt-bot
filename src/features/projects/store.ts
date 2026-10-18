import { del, get, set } from "idb-keyval";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import {
  appendActivity,
  appendColumn,
  type Card,
  type CardInput,
  type CardPatch,
  type ChecklistItem,
  clip,
  dropCard,
  dropColumn,
  insertCard,
  locateCard,
  makeProject,
  mapCard,
  markColumnDone,
  newId,
  normaliseProject,
  patchCard,
  type Project,
  relocateCard,
  renameColumnIn,
  shiftColumn,
} from "./model";

const STORAGE_KEY = "adtbot-projects";

export type ProjectsState = {
  projects: Project[];
  /** Board on screen (null = the project list). */
  activeProjectId: string | null;
  hydrated: boolean;
};

type Persisted = Pick<ProjectsState, "projects" | "activeProjectId">;

/** IndexedDB storage that writes at most every 500 ms (same pattern as the main store). */
function createThrottledStorage(): PersistStorage<Persisted> & { flush: () => void } {
  const available = typeof indexedDB !== "undefined";
  let pending: StorageValue<Persisted> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending || !available) return;
    const value = pending;
    pending = null;
    void set(STORAGE_KEY, value).catch((error) => console.error("Could not save projects", error));
  };
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  }
  return {
    flush,
    getItem: async (name) => {
      if (!available) return null;
      const value = await get(name);
      return value == null ? null : (value as StorageValue<Persisted>);
    },
    setItem: (_name, value) => {
      pending = value;
      timer ??= setTimeout(flush, 500);
    },
    removeItem: async (name) => {
      pending = null;
      if (available) await del(name);
    },
  };
}

const storage = createThrottledStorage();
export const flushProjects = storage.flush;

/** Repairs saved data: damaged records are fixed or dropped, and runs cut off by a reload are flagged. */
export function restore(persisted: unknown): Persisted {
  const saved = (persisted ?? {}) as Partial<Persisted>;
  const projects = (Array.isArray(saved.projects) ? saved.projects : []).map(normaliseProject).filter((p): p is Project => p !== null);
  // A run can't survive a reload: the reply it was waiting for is gone.
  const repaired = projects.map((p) => ({
    ...p,
    columns: p.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) =>
        card.run?.state === "running" ? { ...card, run: { ...card.run, state: "error" as const, error: "Interrupted (the app was closed)" } } : card,
      ),
    })),
  }));
  const activeProjectId = repaired.some((p) => p.id === saved.activeProjectId) ? (saved.activeProjectId ?? null) : null;
  return { projects: repaired, activeProjectId };
}

export const useProjects = create<ProjectsState>()(
  persist((): ProjectsState => ({ projects: [], activeProjectId: null, hydrated: false }), {
    name: STORAGE_KEY,
    version: 1,
    storage,
    partialize: ({ projects, activeProjectId }) => ({ projects, activeProjectId }),
    merge: (persisted, current) => ({ ...current, ...restore(persisted) }),
    onRehydrateStorage: () => () => useProjects.setState({ hydrated: true }),
  }),
);

const getState = () => useProjects.getState();

export function getProject(id: string): Project | undefined {
  return getState().projects.find((p) => p.id === id);
}

/** Applies a pure board change to one project. False when the project, card or column was missing. */
function mutate(projectId: string, fn: (project: Project) => Project | null): boolean {
  let changed = false;
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => {
      if (p.id !== projectId) return p;
      const next = fn(p);
      if (!next) return p;
      changed = true;
      return next;
    }),
  }));
  return changed;
}

// Projects -----------------------------------------------------------------

export function createProject(partial: Partial<Pick<Project, "name" | "description" | "instructions">> = {}, open = true): Project {
  const project = makeProject(partial);
  useProjects.setState((s) => ({ projects: [project, ...s.projects], activeProjectId: open ? project.id : s.activeProjectId }));
  return project;
}

export function updateProject(id: string, patch: Partial<Pick<Project, "name" | "description" | "instructions">>): boolean {
  return mutate(id, (p) => ({
    ...p,
    ...(patch.name !== undefined ? { name: clip(patch.name, p.name, 120) } : {}),
    ...(patch.description !== undefined ? { description: patch.description.slice(0, 8000) } : {}),
    ...(patch.instructions !== undefined ? { instructions: patch.instructions.slice(0, 8000) } : {}),
    updatedAt: Date.now(),
  }));
}

export function deleteProject(id: string) {
  useProjects.setState((s) => ({
    projects: s.projects.filter((p) => p.id !== id),
    activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
  }));
}

export function openProject(id: string | null) {
  useProjects.setState({ activeProjectId: id });
}

// Cards --------------------------------------------------------------------

export function addCard(projectId: string, columnId: string, input: CardInput, author = "You"): Card | null {
  let createdId = "";
  mutate(projectId, (p) => {
    const result = insertCard(p, columnId, input);
    if (!result) return null;
    createdId = result.card.id;
    const column = p.columns.find((c) => c.id === columnId);
    return mapCard(result.project, result.card.id, (card) => appendActivity(card, { kind: "event", author, text: `Created in ${column?.name ?? "the board"}` }));
  });
  return createdId ? (locateCard(getProject(projectId), createdId)?.card ?? null) : null;
}

export function updateCard(projectId: string, cardId: string, patch: CardPatch): boolean {
  return mutate(projectId, (p) => patchCard(p, cardId, patch));
}

/** Assigns (or unassigns, with "") a bot and records it on the card. */
export function assignCard(projectId: string, cardId: string, botId: string, botName: string, author = "You"): boolean {
  return mutate(projectId, (p) => {
    const next = patchCard(p, cardId, { botId });
    return next && mapCard(next, cardId, (card) => appendActivity(card, { kind: "event", author, text: botId ? `Assigned to ${botName}` : "Unassigned" }));
  });
}

/** Moves a card (index counted after lifting it out) and records a column change on the card. */
export function moveCard(projectId: string, cardId: string, toColumnId: string, toIndex = Infinity, author = "You"): boolean {
  return mutate(projectId, (p) => {
    const from = locateCard(p, cardId);
    const next = relocateCard(p, cardId, toColumnId, toIndex);
    if (!from || !next) return null;
    if (from.column.id === toColumnId) return next;
    const to = next.columns.find((c) => c.id === toColumnId)!;
    return mapCard(next, cardId, (card) => appendActivity(card, { kind: "event", author, text: `Moved from ${from.column.name} to ${to.name}` }));
  });
}

export function deleteCard(projectId: string, cardId: string): boolean {
  return mutate(projectId, (p) => dropCard(p, cardId));
}

export function addComment(projectId: string, cardId: string, text: string, author = "You"): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return mutate(projectId, (p) => mapCard(p, cardId, (card) => appendActivity(card, { kind: "comment", author, text: clean })));
}

export function addEvent(projectId: string, cardId: string, text: string, author = "You"): boolean {
  return mutate(projectId, (p) => mapCard(p, cardId, (card) => appendActivity(card, { kind: "event", author, text })));
}

export function addChecklistItem(projectId: string, cardId: string, text: string): boolean {
  const clean = text.trim().slice(0, 300);
  if (!clean) return false;
  return mutate(projectId, (p) => mapCard(p, cardId, (card) => ({ ...card, checklist: [...card.checklist, { id: newId(), text: clean, done: false }].slice(0, 100) })));
}

export function updateChecklistItem(projectId: string, cardId: string, itemId: string, patch: Partial<Omit<ChecklistItem, "id">>): boolean {
  return mutate(projectId, (p) =>
    mapCard(p, cardId, (card) => ({ ...card, checklist: card.checklist.map((i) => (i.id === itemId ? { ...i, ...patch, id: i.id } : i)) })),
  );
}

export function removeChecklistItem(projectId: string, cardId: string, itemId: string): boolean {
  return mutate(projectId, (p) => mapCard(p, cardId, (card) => ({ ...card, checklist: card.checklist.filter((i) => i.id !== itemId) })));
}

// Columns ------------------------------------------------------------------

export const addColumn = (projectId: string, name: string) => mutate(projectId, (p) => appendColumn(p, name));
export const renameColumn = (projectId: string, columnId: string, name: string) => mutate(projectId, (p) => renameColumnIn(p, columnId, name));
export const removeColumn = (projectId: string, columnId: string) => mutate(projectId, (p) => dropColumn(p, columnId));
export const setColumnDone = (projectId: string, columnId: string, done: boolean) => mutate(projectId, (p) => markColumnDone(p, columnId, done));
export const moveColumn = (projectId: string, columnId: string, delta: -1 | 1) => mutate(projectId, (p) => shiftColumn(p, columnId, delta));

// Lookups ------------------------------------------------------------------

/** A card anywhere, by full id or an id prefix of 6+ characters (what list_tasks shows). */
export function findCard(cardId: string): { project: Project; card: Card; columnId: string; columnName: string } | null {
  const raw = cardId.trim().toLowerCase();
  if (!raw) return null;
  let match: { project: Project; card: Card; columnId: string; columnName: string } | null = null;
  for (const project of getState().projects) {
    for (const column of project.columns) {
      for (const card of column.cards) {
        if (card.id === raw) return { project, card, columnId: column.id, columnName: column.name };
        if (raw.length >= 6 && card.id.startsWith(raw)) {
          if (match) return null; // ambiguous prefix
          match = { project, card, columnId: column.id, columnName: column.name };
        }
      }
    }
  }
  return match;
}

/** The project and card a chat was started from, if any. */
export function cardForConversation(conversationId: string): { project: Project; card: Card } | null {
  if (!conversationId) return null;
  for (const project of getState().projects) {
    for (const column of project.columns) {
      const card = column.cards.find((c) => c.conversationId === conversationId);
      if (card) return { project, card };
    }
  }
  return null;
}
