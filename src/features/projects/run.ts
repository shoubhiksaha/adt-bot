/**
 * "Run with bot": hands a card to its assigned bot through the normal chat flow.
 *
 * The card gets its own conversation (reused on later runs), moves to In progress while the bot
 * works, and to Review when the reply is in, with the chat linked on the card. Failures leave the
 * card where it is, flagged, so nothing is ever silently lost.
 */
import { sendInBackground } from "../../lib/chat";
import { updateConversation, useStore } from "../../lib/store";
import { addBackgroundConversation } from "../automation/conversations";
import type { Bot } from "../../lib/types";
import { type Card, findColumn, locateCard, type Project } from "./model";
import { addComment, addEvent, getProject, moveCard, updateCard } from "./store";

/** Runs in the background: the user keeps whatever chat they had open, and several cards can run at once. */
export type RunDeps = { send: (conversationId: string, text: string, shown?: string) => Promise<unknown> };

export type RunResult = { ok: true; conversationId: string } | { ok: false; error: string; conversationId?: string };

export const shortId = (id: string) => id.slice(0, 8);

/** The task as the bot reads it: project context first, then the card. */
export function taskPrompt(project: Project, card: Card, columnName: string): string {
  const lines: string[] = [`You're working on a task from the project board "${project.name}".`, ""];
  if (project.description.trim()) lines.push(`Project description:\n${project.description.trim()}`, "");
  if (project.instructions.trim()) lines.push(`Project instructions and knowledge (follow these):\n${project.instructions.trim()}`, "");
  lines.push(`Task: ${card.title}`, `Task id: ${shortId(card.id)}`, `Status: ${columnName}`);
  if (card.labels.length) lines.push(`Labels: ${card.labels.join(", ")}`);
  if (card.due) lines.push(`Due: ${card.due}`);
  if (card.description.trim()) lines.push("", `Details:\n${card.description.trim()}`);
  if (card.checklist.length) {
    lines.push("", "Checklist:", ...card.checklist.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`));
  }
  const comments = card.activity.filter((a) => a.kind === "comment").slice(-10);
  if (comments.length) lines.push("", "Comments so far:", ...comments.map((c) => `- ${c.author}: ${c.text}`));
  lines.push(
    "",
    "Do this task now. When you're finished, reply with what you did, the result, and anything the reviewer should check.",
    `If you have the project tools, you can comment on or update this task with task id ${shortId(card.id)}.`,
  );
  return lines.join("\n");
}

const excerpt = (text: string, max = 700) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function botFor(card: Card): Bot | undefined {
  return card.botId ? useStore.getState().bots.find((b) => b.id === card.botId) : undefined;
}

export async function runCardWithBot(projectId: string, cardId: string, deps: RunDeps = { send: (conversationId, text, shown) => sendInBackground(conversationId, text, { shown }) }): Promise<RunResult> {
  const project = getProject(projectId);
  const found = locateCard(project, cardId);
  if (!project || !found) return { ok: false, error: "That card no longer exists." };
  const { card } = found;
  const bot = botFor(card);
  if (!bot) return { ok: false, error: "Assign a bot to this card first." };
  if (card.run?.state === "running") return { ok: false, error: "This card is already running." };
  const chat = useStore.getState();

  // One chat per card: reuse it while it exists and belongs to the same bot.
  const existing = card.conversationId ? chat.conversations[card.conversationId] : undefined;
  let conversationId: string;
  if (existing && existing.botId === bot.id && !existing.temporary) {
    conversationId = existing.id;
  } else {
    conversationId = addBackgroundConversation(bot.id, card.title).id;
  }
  const keepTitle = () => updateConversation(conversationId, (c) => ({ ...c, title: card.title.slice(0, 60), titled: true }));
  keepTitle();

  const startColumn = found.column;
  updateCard(projectId, cardId, { conversationId, run: { state: "running", botId: bot.id, startedAt: Date.now() } });
  addEvent(projectId, cardId, `Handed to ${bot.name}`);
  const doing = findColumn(project, "doing");
  if (doing && doing.id !== startColumn.id) moveCard(projectId, cardId, doing.id, Infinity, bot.name);
  const workingColumnId = doing?.id ?? startColumn.id;

  let failure: string | undefined;
  try {
    await deps.send(conversationId, taskPrompt(project, card, doing?.name ?? startColumn.name), `Work on this card: ${card.title}`);
    keepTitle();
  } catch (error) {
    failure = (error as Error).message || "The run failed.";
  }

  const conversation = useStore.getState().conversations[conversationId];
  const last = conversation?.messages[conversation.messages.length - 1];
  if (!failure) {
    if (!last || last.role !== "assistant") failure = "The bot didn't reply.";
    else if (last.error) failure = last.error;
    else if (!last.content.trim() && !last.attachments?.length) failure = "Stopped before the bot finished.";
  }

  const now = getProject(projectId);
  const current = locateCard(now, cardId);
  if (!now || !current) return failure ? { ok: false, error: failure, conversationId } : { ok: true, conversationId };
  const started = current.card.run?.startedAt ?? Date.now();

  if (failure) {
    updateCard(projectId, cardId, { run: { state: "error", botId: bot.id, startedAt: started, finishedAt: Date.now(), error: failure } });
    addEvent(projectId, cardId, `Run failed: ${failure}`, bot.name);
    return { ok: false, error: failure, conversationId };
  }

  updateCard(projectId, cardId, { run: { state: "done", botId: bot.id, startedAt: started, finishedAt: Date.now() } });
  if (last?.content.trim()) addComment(projectId, cardId, excerpt(last.content.trim()), bot.name);
  // Only move on if nobody (user or the bot's own tools) moved the card meanwhile.
  const review = findColumn(now, "review");
  if (review && current.column.id === workingColumnId && review.id !== current.column.id) {
    moveCard(projectId, cardId, review.id, Infinity, bot.name);
  }
  addEvent(projectId, cardId, "Finished — ready for review", bot.name);
  return { ok: true, conversationId };
}
