/** Board tools: bots list, create and update project tasks from any chat. */
import { registerTool, registerToolGroup, str, type ToolContext } from "../../lib/agent/tools";
import { useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { type Card, checklistProgress, type Column, countOpenCards, findColumn, normaliseDue, normaliseLabels, type Project } from "./model";
import { addCard, addComment, assignCard, cardForConversation, findCard, moveCard, updateCard, useProjects } from "./store";

registerToolGroup({ id: "projects", label: "Projects", description: "See and manage tasks on your project boards." });

const short = (id: string) => id.slice(0, 8);

function resolveProject(ref: string, ctx: Pick<ToolContext, "conversationId">): Project {
  const { projects } = useProjects.getState();
  if (!projects.length) throw new Error("There are no projects yet. The user can create one in Projects.");
  const raw = ref.trim().toLowerCase();
  if (!raw) {
    const linked = cardForConversation(ctx.conversationId)?.project;
    if (linked) return linked;
    if (projects.length === 1) return projects[0];
    throw new Error(`Say which project: ${projects.map((p) => `"${p.name}"`).join(", ")}.`);
  }
  const found =
    projects.find((p) => p.id === raw) ??
    projects.find((p) => p.name.trim().toLowerCase() === raw) ??
    (raw.length >= 6 ? projects.find((p) => p.id.startsWith(raw)) : undefined) ??
    projects.find((p) => p.name.toLowerCase().includes(raw));
  if (!found) throw new Error(`No project called "${ref}". Projects: ${projects.map((p) => `"${p.name}"`).join(", ")}.`);
  return found;
}

/** "me", a bot name, nickname or id; "" / "none" unassigns. */
function resolveBot(ref: string, self: Bot): Bot | null {
  const raw = ref.trim().toLowerCase();
  if (!raw || raw === "none" || raw === "nobody" || raw === "unassigned") return null;
  if (raw === "me" || raw === "self" || raw === "you") return self;
  const bots = useStore.getState().bots;
  const bot =
    bots.find((b) => b.id === raw) ??
    bots.find((b) => b.name.toLowerCase() === raw || b.nickname?.trim().toLowerCase() === raw) ??
    bots.find((b) => b.name.toLowerCase().includes(raw));
  if (!bot) throw new Error(`No bot called "${ref}". Bots: ${bots.map((b) => b.name).join(", ")}.`);
  return bot;
}

function statusColumn(project: Project, status: string): Column {
  const column = findColumn(project, status);
  if (!column) throw new Error(`No column "${status}" in ${project.name}. Columns: ${project.columns.map((c) => c.name).join(", ")}.`);
  return column;
}

function describeTask(card: Card, column: Column): string {
  const bots = useStore.getState().bots;
  const bot = card.botId ? bots.find((b) => b.id === card.botId) : undefined;
  const parts = [`status: ${column.name}`, `assignee: ${bot?.name ?? "none"}`];
  if (card.labels.length) parts.push(`labels: ${card.labels.join(", ")}`);
  if (card.due) parts.push(`due: ${card.due}`);
  const { done, total } = checklistProgress(card);
  if (total) parts.push(`checklist: ${done}/${total}`);
  const comments = card.activity.filter((a) => a.kind === "comment").length;
  if (comments) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`);
  const line = `- [${short(card.id)}] ${card.title} — ${parts.join("; ")}`;
  const detail = card.description.trim();
  return detail ? `${line}\n  ${detail.slice(0, 300).replace(/\n+/g, " ")}` : line;
}

registerTool({
  name: "list_projects",
  group: "projects",
  risk: "read",
  description: "List the user's projects with their columns and how many tasks each has.",
  parameters: { type: "object", properties: {} },
  async run() {
    const { projects } = useProjects.getState();
    if (!projects.length) return "No projects yet.";
    return projects
      .map((p) => {
        const total = p.columns.reduce((n, c) => n + c.cards.length, 0);
        const head = `- ${p.name} (id ${short(p.id)}): ${countOpenCards(p)} open of ${total} tasks. Columns: ${p.columns.map((c) => `${c.name} ${c.cards.length}`).join(", ")}`;
        return p.description.trim() ? `${head}\n  ${p.description.trim().slice(0, 300).replace(/\n+/g, " ")}` : head;
      })
      .join("\n");
  },
});

registerTool({
  name: "list_tasks",
  group: "projects",
  risk: "read",
  description:
    "List tasks (cards) on a project board, optionally only one status column or one assignee. Task ids in [brackets] are used by update_task and add_task_comment.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name or id. Optional when there is only one project or this chat belongs to a task." },
      status: { type: "string", description: "Column name, e.g. Backlog, To do, In progress, Review, Done" },
      assignee: { type: "string", description: "Bot name, or 'me'" },
    },
  },
  async run(args, ctx) {
    const project = resolveProject(str(args, "project"), ctx);
    const status = str(args, "status");
    const column = status ? statusColumn(project, status) : null;
    const assignee = str(args, "assignee");
    const bot = assignee ? resolveBot(assignee, ctx.bot) : undefined;
    const lines: string[] = [];
    for (const c of project.columns) {
      if (column && c.id !== column.id) continue;
      for (const card of c.cards) {
        if (bot !== undefined && (card.botId ?? null) !== (bot?.id ?? null)) continue;
        lines.push(describeTask(card, c));
      }
    }
    const scope = [column ? `in ${column.name}` : "", bot !== undefined ? `assigned to ${bot?.name ?? "nobody"}` : ""].filter(Boolean).join(" ");
    return lines.length ? `${project.name}${scope ? ` (${scope})` : ""}:\n${lines.join("\n")}` : `No tasks${scope ? ` ${scope}` : ""} in ${project.name}.`;
  },
});

registerTool({
  name: "create_task",
  group: "projects",
  risk: "write",
  description: "Add a task (card) to a project board.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project name or id (optional when there is only one)" },
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string", description: "Column to put it in (default: To do)" },
      assignee: { type: "string", description: "Bot name, or 'me'" },
      labels: { type: "array", items: { type: "string" } },
      due: { type: "string", description: "Due date, YYYY-MM-DD" },
    },
    required: ["title"],
  },
  async run(args, ctx) {
    const project = resolveProject(str(args, "project"), ctx);
    const title = str(args, "title").trim();
    if (!title) throw new Error("Give the task a title.");
    const status = str(args, "status");
    const column = status ? statusColumn(project, status) : (findColumn(project, "todo") ?? project.columns[0]);
    const assignee = str(args, "assignee");
    const bot = assignee ? resolveBot(assignee, ctx.bot) : null;
    const card = addCard(
      project.id,
      column.id,
      { title, description: str(args, "description"), botId: bot?.id, labels: normaliseLabels(args.labels), due: normaliseDue(args.due) },
      ctx.bot.name,
    );
    if (!card) throw new Error(`Couldn't add the task (the ${column.name} column may be full).`);
    return `Created task [${short(card.id)}] "${card.title}" in ${column.name} of ${project.name}${bot ? `, assigned to ${bot.name}` : ""}.`;
  },
});

registerTool({
  name: "update_task",
  group: "projects",
  risk: "write",
  description: "Change a task: move it to another status column, reassign it, or edit its title, description, labels or due date.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id from list_tasks" },
      status: { type: "string", description: "Column to move it to, e.g. In progress, Review, Done" },
      assignee: { type: "string", description: "Bot name, 'me', or 'none' to unassign" },
      title: { type: "string" },
      description: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      due: { type: "string", description: "YYYY-MM-DD, or empty to clear" },
    },
    required: ["task_id"],
  },
  async run(args, ctx) {
    const found = findCard(str(args, "task_id"));
    if (!found) throw new Error(`No task with id "${str(args, "task_id")}". Use list_tasks to see ids.`);
    const { project, card } = found;
    const changes: string[] = [];
    const patch: Parameters<typeof updateCard>[2] = {};
    if (typeof args.title === "string" && args.title.trim()) {
      patch.title = args.title;
      changes.push("title");
    }
    if (typeof args.description === "string") {
      patch.description = args.description;
      changes.push("description");
    }
    if (args.labels !== undefined) {
      patch.labels = normaliseLabels(args.labels);
      changes.push("labels");
    }
    if (args.due !== undefined) {
      patch.due = normaliseDue(args.due);
      changes.push(patch.due ? `due ${patch.due}` : "due date cleared");
    }
    if (Object.keys(patch).length) updateCard(project.id, card.id, patch);
    if (args.assignee !== undefined) {
      const bot = resolveBot(str(args, "assignee"), ctx.bot);
      if ((bot?.id ?? undefined) !== card.botId) {
        assignCard(project.id, card.id, bot?.id ?? "", bot?.name ?? "", ctx.bot.name);
        changes.push(bot ? `assigned to ${bot.name}` : "unassigned");
      }
    }
    if (str(args, "status")) {
      const column = statusColumn(project, str(args, "status"));
      if (column.id !== found.columnId) {
        moveCard(project.id, card.id, column.id, Infinity, ctx.bot.name);
        changes.push(`moved to ${column.name}`);
      }
    }
    if (!changes.length) return `Nothing to change on [${short(card.id)}] "${card.title}".`;
    return `Updated [${short(card.id)}] "${card.title}": ${changes.join(", ")}.`;
  },
});

registerTool({
  name: "add_task_comment",
  group: "projects",
  risk: "write",
  description: "Add a comment to a task (progress notes, findings, questions for the user).",
  parameters: {
    type: "object",
    properties: { task_id: { type: "string", description: "Task id from list_tasks" }, text: { type: "string" } },
    required: ["task_id", "text"],
  },
  async run(args, ctx) {
    const found = findCard(str(args, "task_id"));
    if (!found) throw new Error(`No task with id "${str(args, "task_id")}". Use list_tasks to see ids.`);
    const text = str(args, "text").trim();
    if (!text) throw new Error("The comment is empty.");
    addComment(found.project.id, found.card.id, text, ctx.bot.name);
    return `Commented on [${short(found.card.id)}] "${found.card.title}".`;
  },
});
