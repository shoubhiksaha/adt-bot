// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTool, type ToolContext } from "../../lib/agent/tools";
import { defaultSettings, uid, updateConversation, useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { findColumn, indexBefore, locateCard, makeProject, normaliseProject, relocateCard } from "./model";
import { runCardWithBot, taskPrompt } from "./run";
import {
  addCard,
  addChecklistItem,
  addColumn,
  addComment,
  assignCard,
  createProject,
  deleteCard,
  findCard,
  getProject,
  moveCard,
  moveColumn,
  removeChecklistItem,
  removeColumn,
  renameColumn,
  restore,
  updateChecklistItem,
  updateProject,
  useProjects,
} from "./store";
import "./tools";

// The real chat flow needs providers and the network; the run tests drive a fake one.
vi.mock("../../lib/chat", () => ({ sendMessage: vi.fn() }));

const makeBot = (id: string, name: string): Bot => ({
  id, name, avatar: "*", description: "", systemPrompt: "", providerId: "p", model: "m",
  temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0,
});
const ada = makeBot("bot-ada", "Ada");
const max = makeBot("bot-max", "Max");

beforeEach(() => {
  useProjects.setState({ projects: [], activeProjectId: null });
  useStore.setState({ bots: [ada, max], conversations: {}, activeBotId: ada.id, activeConversationId: null, streamingId: null });
});

const columnOf = (projectId: string, cardId: string) => locateCard(getProject(projectId), cardId)?.column.id;
const ctx = (bot: Bot = ada, conversationId = "c0"): ToolContext => ({
  bot, conversationId, settings: defaultSettings, providers: [], platform: "web", signal: new AbortController().signal, progress: () => undefined,
});
const tool = (name: string, args: Record<string, unknown>, context = ctx()) => getTool(name)!.run(args, context).then((r) => (typeof r === "string" ? r : r.content));

describe("board model", () => {
  it("creates projects with the five default columns", () => {
    const p = makeProject({ name: "  Launch " });
    expect(p.name).toBe("Launch");
    expect(p.columns.map((c) => c.name)).toEqual(["Backlog", "To do", "In progress", "Review", "Done"]);
    expect(p.columns.filter((c) => c.done).map((c) => c.id)).toEqual(["done"]);
  });

  it("relocates within and across columns, clamping the index", () => {
    const p = createProject({ name: "P" });
    const a = addCard(p.id, "todo", { title: "A" })!;
    const b = addCard(p.id, "todo", { title: "B" })!;
    const c = addCard(p.id, "todo", { title: "C" })!;
    const project = getProject(p.id)!;
    // Drop A before C → B, A, C
    const reordered = relocateCard(project, a.id, "todo", indexBefore(project, a.id, "todo", c.id))!;
    expect(reordered.columns[1].cards.map((x) => x.title)).toEqual(["B", "A", "C"]);
    const across = relocateCard(reordered, b.id, "done", 99)!;
    expect(across.columns[4].cards.map((x) => x.title)).toEqual(["B"]);
    expect(relocateCard(project, "nope", "done", 0)).toBeNull();
    expect(relocateCard(project, a.id, "nope", 0)).toBeNull();
  });

  it("finds columns by id, name or alias, even after a rename", () => {
    const p = createProject({ name: "P" });
    renameColumn(p.id, "doing", "Working on it");
    const project = getProject(p.id)!;
    expect(findColumn(project, "in progress")?.id).toBe("doing");
    expect(findColumn(project, "IN_PROGRESS")?.id).toBe("doing");
    expect(findColumn(project, "working on it")?.id).toBe("doing");
    expect(findColumn(project, "completed")?.id).toBe("done");
    expect(findColumn(project, "to-do")?.id).toBe("todo");
    expect(findColumn(project, "nonsense")).toBeNull();
  });

  it("repairs damaged saved data and flags runs cut off by a reload", () => {
    expect(normaliseProject(null)).toBeNull();
    const fixed = normaliseProject({ id: "x", name: "", columns: [{ id: "a", name: "A", cards: [{ id: "k", title: "T" }, { nope: 1 }] }] })!;
    expect(fixed.name).toBe("Project");
    expect(fixed.columns[0].cards).toHaveLength(1);
    expect(fixed.columns[0].cards[0].labels).toEqual([]);
    const p = makeProject({ name: "Saved" });
    p.columns[2].cards.push({ ...p.columns[0].cards[0], ...{ id: "r", title: "Running", description: "", labels: [], checklist: [], activity: [], createdAt: 1, updatedAt: 1, run: { state: "running", botId: ada.id, startedAt: 1 } } });
    const restored = restore({ projects: [p, { bad: true }], activeProjectId: "gone" });
    expect(restored.projects).toHaveLength(1);
    expect(restored.activeProjectId).toBeNull();
    expect(restored.projects[0].columns[2].cards[0].run?.state).toBe("error");
  });
});

describe("projects store", () => {
  it("creates, opens, edits and deletes projects", () => {
    const p = createProject({ name: "Site", description: "d", instructions: "Use British English" });
    expect(useProjects.getState().activeProjectId).toBe(p.id);
    updateProject(p.id, { name: "Website", instructions: "Be brief" });
    expect(getProject(p.id)).toMatchObject({ name: "Website", instructions: "Be brief", description: "d" });
  });

  it("adds cards with labels and due dates and records activity on moves", () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "backlog", { title: "Write copy", labels: ["copy", "Copy", " web "], due: "2026-11-01T10:00" })!;
    expect(card.labels).toEqual(["copy", "web"]);
    expect(card.due).toBe("2026-11-01");
    expect(card.activity[0].text).toBe("Created in Backlog");
    moveCard(p.id, card.id, "review");
    const moved = locateCard(getProject(p.id), card.id)!;
    expect(moved.column.id).toBe("review");
    expect(moved.card.activity.at(-1)?.text).toBe("Moved from Backlog to Review");
    // Reordering inside a column is not an event worth logging.
    moveCard(p.id, card.id, "review", 0);
    expect(locateCard(getProject(p.id), card.id)!.card.activity).toHaveLength(2);
    expect(addCard(p.id, "missing", { title: "x" })).toBeNull();
  });

  it("handles checklist, comments, assignment and deletion", () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "todo", { title: "T" })!;
    addChecklistItem(p.id, card.id, "one");
    addChecklistItem(p.id, card.id, "two");
    expect(addChecklistItem(p.id, card.id, "  ")).toBe(false);
    let current = locateCard(getProject(p.id), card.id)!.card;
    updateChecklistItem(p.id, card.id, current.checklist[0].id, { done: true });
    removeChecklistItem(p.id, card.id, current.checklist[1].id);
    addComment(p.id, card.id, "Looks good", "Ada");
    assignCard(p.id, card.id, max.id, max.name);
    current = locateCard(getProject(p.id), card.id)!.card;
    expect(current.checklist).toEqual([{ id: expect.any(String), text: "one", done: true }]);
    expect(current.botId).toBe(max.id);
    expect(current.activity.map((a) => [a.kind, a.author, a.text]).slice(1)).toEqual([
      ["comment", "Ada", "Looks good"],
      ["event", "You", "Assigned to Max"],
    ]);
    deleteCard(p.id, card.id);
    expect(locateCard(getProject(p.id), card.id)).toBeNull();
  });

  it("adds, renames, reorders and removes columns without losing cards", () => {
    const p = createProject({ name: "P" });
    addColumn(p.id, "Blocked");
    expect(getProject(p.id)!.columns.at(-1)?.name).toBe("Blocked");
    const card = addCard(p.id, "review", { title: "R" })!;
    moveColumn(p.id, "review", -1);
    expect(getProject(p.id)!.columns.map((c) => c.id).slice(0, 4)).toEqual(["backlog", "todo", "review", "doing"]);
    removeColumn(p.id, "review");
    expect(columnOf(p.id, card.id)).toBe("todo");
    expect(getProject(p.id)!.columns.some((c) => c.id === "review")).toBe(false);
  });

  it("finds cards by short id prefix", () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "todo", { title: "T" })!;
    expect(findCard(card.id.slice(0, 8))?.card.id).toBe(card.id);
    expect(findCard(card.id.slice(0, 3))).toBeNull();
  });
});

describe("project tools", () => {
  it("lists projects and tasks", async () => {
    expect(await tool("list_projects", {})).toBe("No projects yet.");
    const p = createProject({ name: "Launch", description: "Product launch" });
    addCard(p.id, "todo", { title: "Press release", botId: ada.id, labels: ["pr"] });
    addCard(p.id, "done", { title: "Pick date" });
    const projects = await tool("list_projects", {});
    expect(projects).toContain("Launch");
    expect(projects).toContain("1 open of 2 tasks");
    const tasks = await tool("list_tasks", {});
    expect(tasks).toContain("Press release — status: To do; assignee: Ada; labels: pr");
    expect(tasks).toContain("Pick date — status: Done; assignee: none");
    expect(await tool("list_tasks", { status: "done" })).not.toContain("Press release");
    expect(await tool("list_tasks", { assignee: "me" })).not.toContain("Pick date");
  });

  it("asks which project when there are several", async () => {
    createProject({ name: "One" });
    createProject({ name: "Two" });
    await expect(tool("list_tasks", {})).rejects.toThrow(/Say which project/);
    expect(await tool("list_tasks", { project: "two" })).toBe("No tasks in Two.");
  });

  it("creates, updates and comments on tasks", async () => {
    const p = createProject({ name: "Launch" });
    const created = await tool("create_task", { title: "Draft FAQ", description: "10 questions", assignee: "Max", labels: ["docs"], due: "2026-12-01" });
    expect(created).toMatch(/Created task \[([0-9a-f]{8})\] "Draft FAQ" in To do of Launch, assigned to Max/);
    const id = /\[([0-9a-f]{8})\]/.exec(created)![1];
    const card = findCard(id)!.card;
    expect(card).toMatchObject({ botId: max.id, labels: ["docs"], due: "2026-12-01", description: "10 questions" });
    expect(card.activity[0].author).toBe("Ada");

    const updated = await tool("update_task", { task_id: id, status: "in progress", assignee: "me", description: "12 questions" });
    expect(updated).toContain("moved to In progress");
    expect(updated).toContain("assigned to Ada");
    const after = findCard(id)!;
    expect(after.columnId).toBe("doing");
    expect(after.card.description).toBe("12 questions");
    expect(after.card.botId).toBe(ada.id);

    await tool("update_task", { task_id: id, assignee: "none" });
    expect(findCard(id)!.card.botId).toBeUndefined();

    expect(await tool("add_task_comment", { task_id: id, text: "First draft done" })).toContain("Commented");
    expect(findCard(id)!.card.activity.at(-1)).toMatchObject({ kind: "comment", author: "Ada", text: "First draft done" });

    await expect(tool("update_task", { task_id: "zzzzzzzz", status: "done" })).rejects.toThrow(/No task/);
    await expect(tool("update_task", { task_id: id, status: "limbo" })).rejects.toThrow(/No column/);
    await expect(tool("create_task", { title: "x", assignee: "Nobody-here" })).rejects.toThrow(/No bot/);
    expect(getProject(p.id)!.columns[1].cards).toHaveLength(0);
  });

  it("registers with the right risk levels", () => {
    expect(getTool("list_projects")?.risk).toBe("read");
    expect(getTool("list_tasks")?.risk).toBe("read");
    for (const name of ["create_task", "update_task", "add_task_comment"]) expect(getTool(name)?.risk).toBe("write");
  });
});

describe("run with bot", () => {
  /** Stands in for sendMessage: adds the user turn and a reply to the active chat. */
  function fakeChat(reply: { content?: string; error?: string }, during?: () => void) {
    const prompts: string[] = [];
    const send = vi.fn(async (activeConversationId: string, text: string, _shown?: string) => {
      prompts.push(text);
      updateConversation(activeConversationId!, (c) => ({
        ...c,
        title: c.messages.length ? c.title : text.slice(0, 40),
        messages: [...c.messages, { id: uid(), role: "user", content: text, createdAt: Date.now() }],
      }));
      await Promise.resolve();
      during?.();
      updateConversation(activeConversationId!, (c) => ({
        ...c,
        messages: [...c.messages, { id: uid(), role: "assistant", content: reply.content ?? "", error: reply.error, createdAt: Date.now() }],
      }));
    });
    return { send, prompts };
  }

  it("moves the card to In progress, then Review, and links the chat", async () => {
    const p = createProject({ name: "Launch", instructions: "Write in plain English." });
    const card = addCard(p.id, "todo", { title: "Write tagline", description: "Short and punchy", botId: ada.id })!;
    let duringColumn: string | undefined;
    let duringState: string | undefined;
    const chat = fakeChat({ content: "Here are three taglines." }, () => {
      duringColumn = columnOf(p.id, card.id);
      duringState = locateCard(getProject(p.id), card.id)?.card.run?.state;
    });

    const result = await runCardWithBot(p.id, card.id, chat);
    expect(result.ok).toBe(true);
    expect(duringColumn).toBe("doing");
    expect(duringState).toBe("running");

    const after = locateCard(getProject(p.id), card.id)!;
    expect(after.column.id).toBe("review");
    expect(after.card.run?.state).toBe("done");
    expect(after.card.conversationId).toBe(result.ok && result.conversationId);
    const conversation = useStore.getState().conversations[after.card.conversationId!];
    expect(conversation.botId).toBe(ada.id);
    expect(conversation.title).toBe("Write tagline");
    expect(after.card.activity.some((a) => a.kind === "comment" && a.author === "Ada" && a.text.includes("three taglines"))).toBe(true);
    expect(chat.prompts[0]).toContain("Write in plain English.");
    expect(chat.prompts[0]).toContain("Task: Write tagline");
    expect(chat.prompts[0]).toContain("Short and punchy");
    // The chat shows a short line for the long task prompt.
    expect(chat.send.mock.calls[0][2]).toBe("Work on this card: Write tagline");
  });

  it("reuses the card's chat on a second run", async () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "todo", { title: "T", botId: ada.id })!;
    const first = await runCardWithBot(p.id, card.id, fakeChat({ content: "done" }));
    moveCard(p.id, card.id, "todo");
    const second = await runCardWithBot(p.id, card.id, fakeChat({ content: "done again" }));
    expect(first.ok && second.ok && first.conversationId === second.conversationId).toBe(true);
    expect(Object.keys(useStore.getState().conversations)).toHaveLength(1);
    expect(columnOf(p.id, card.id)).toBe("review");
  });

  it("keeps a failed card in In progress and flags it", async () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "backlog", { title: "T", botId: ada.id })!;
    const result = await runCardWithBot(p.id, card.id, fakeChat({ error: "Invalid API key" }));
    expect(result).toMatchObject({ ok: false, error: "Invalid API key" });
    const after = locateCard(getProject(p.id), card.id)!;
    expect(after.column.id).toBe("doing");
    expect(after.card.run).toMatchObject({ state: "error", error: "Invalid API key" });
    expect(after.card.conversationId).toBeTruthy();
  });

  it("treats a thrown send or an empty reply as a failure", async () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "todo", { title: "T", botId: ada.id })!;
    const thrown = await runCardWithBot(p.id, card.id, { send: async () => Promise.reject(new Error("offline")) });
    expect(thrown).toMatchObject({ ok: false, error: "offline" });
    const empty = await runCardWithBot(p.id, card.id, fakeChat({ content: "" }));
    expect(empty).toMatchObject({ ok: false, error: "Stopped before the bot finished." });
  });

  it("leaves the card where the bot put it", async () => {
    const p = createProject({ name: "P" });
    const card = addCard(p.id, "todo", { title: "T", botId: ada.id })!;
    await runCardWithBot(p.id, card.id, fakeChat({ content: "ok" }, () => moveCard(p.id, card.id, "done", Infinity, "Ada")));
    expect(columnOf(p.id, card.id)).toBe("done");
  });

  it("refuses without a bot or for a missing card, and runs in the background", async () => {
    const p = createProject({ name: "P" });
    const unassigned = addCard(p.id, "todo", { title: "U" })!;
    const send = vi.fn(async () => undefined);
    expect(await runCardWithBot(p.id, unassigned.id, { send })).toMatchObject({ ok: false, error: expect.stringMatching(/Assign a bot/) });
    const card = addCard(p.id, "todo", { title: "T", botId: ada.id })!;
    expect(send).not.toHaveBeenCalled();
    expect(columnOf(p.id, card.id)).toBe("todo");
    expect(await runCardWithBot(p.id, "missing", { send })).toMatchObject({ ok: false });
    // Another chat streaming doesn't block a card, and the user's open chat stays open.
    useStore.setState({ streamingId: "other", activeConversationId: "mine" });
    const result = await runCardWithBot(p.id, card.id, fakeChat({ content: "ok" }));
    expect(result.ok).toBe(true);
    expect(useStore.getState().activeConversationId).toBe("mine");
    useStore.setState({ streamingId: null, activeConversationId: null });
  });

  it("tools default to the project of the chat a card runs in", async () => {
    createProject({ name: "Other" });
    const p = createProject({ name: "Mine" });
    const card = addCard(p.id, "todo", { title: "T", botId: ada.id })!;
    const result = await runCardWithBot(p.id, card.id, fakeChat({ content: "ok" }));
    const conversationId = result.ok ? result.conversationId : "";
    expect(await tool("list_tasks", {}, ctx(ada, conversationId))).toContain("Mine");
  });

  it("builds a prompt with checklist and comments", () => {
    const p = createProject({ name: "P", description: "About P" });
    const card = addCard(p.id, "todo", { title: "T", labels: ["a"], due: "2026-10-30" })!;
    addChecklistItem(p.id, card.id, "step one");
    addComment(p.id, card.id, "Remember the logo");
    const prompt = taskPrompt(getProject(p.id)!, locateCard(getProject(p.id), card.id)!.card, "To do");
    expect(prompt).toContain("About P");
    expect(prompt).toContain("- [ ] step one");
    expect(prompt).toContain("- You: Remember the logo");
    expect(prompt).toContain("Due: 2026-10-30");
    expect(prompt).toContain(`Task id: ${card.id.slice(0, 8)}`);
  });
});

describe("labels from small models", () => {
  it("accepts JSON-string lists and drops empty ones", async () => {
    const { normaliseLabels } = await import("./model");
    expect(normaliseLabels("[]")).toEqual([]);
    expect(normaliseLabels('["urgent", "web"]')).toEqual(["urgent", "web"]);
    expect(normaliseLabels("[urgent, web")).toEqual(["urgent", "web"]);
    expect(normaliseLabels("a, b")).toEqual(["a", "b"]);
  });
});
