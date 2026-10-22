import { hybridRank } from "./hybrid";
import { rank, subjectWords } from "./knowledge";
import type { Bot } from "./types";

/**
 * Which of a bot's memories go with a question. A small memory goes into every prompt whole, as it
 * always has. A large one would crowd the prompt, so the newest facts go in every time and the
 * rest are recalled by relevance to the question: by keywords, and by meaning when smarter search
 * is on ("what's my sister's name" recalls "Riya is my sibling").
 */

/** The bot with the facts every bot knows (Memory screen) in front of its own. */
export function withSharedMemory<T extends Pick<Bot, "memory">>(bot: T, shared: string[] | undefined): T {
  const extra = (shared ?? []).filter((f) => !bot.memory.includes(f));
  return extra.length ? { ...bot, memory: [...extra, ...bot.memory] } : bot;
}

/** Up to this much (~1,500 tokens), every memory goes into every prompt. */
export const MEMORY_IN_FULL_CHARS = 6000;
/** Above it, the newest memories up to this much always go in… */
const PINNED_CHARS = 3000;
/** …plus this many of the others, the most relevant to the question. */
const RECALLED = 10;

/** Where a bot's memories live in the vector index. */
export const memorySource = (botId: string) => `memory:${botId}`;

const size = (facts: string[]) => facts.reduce((n, f) => n + f.length + 3, 0);

/** Whether a bot has more memories than fit in every prompt. */
export function memoryIsLarge(memory: string[]): boolean {
  return size(memory) > MEMORY_IN_FULL_CHARS;
}

/** The newest memories that fit the pinned budget (in their saved order), and the rest. */
export function splitMemory(memory: string[]): { pinned: string[]; rest: string[] } {
  if (!memoryIsLarge(memory)) return { pinned: memory, rest: [] };
  let used = 0;
  let first = memory.length;
  while (first > 0 && used + memory[first - 1].length + 3 <= PINNED_CHARS) used += memory[--first].length + 3;
  return { pinned: memory.slice(first), rest: memory.slice(0, first) };
}

/** Memories ranked for a question, best first: keyword matches, fused with meaning when available. */
export async function searchMemory(bot: Pick<Bot, "id">, facts: string[], query: string, limit = RECALLED): Promise<string[]> {
  const items = facts.map((text) => ({ text, source: memorySource(bot.id) }));
  const { items: ranked } = await hybridRank(items, query, rank(items, query));
  return ranked.slice(0, limit).map((item) => item.text);
}

export type MemoryContext = {
  /** For the system prompt (changes only when memory does, so prompt caching keeps working). */
  pinned: string[];
  /** For this message's context: older memories relevant to the question. */
  recalled: string[];
};

export async function memoryContext(bot: Pick<Bot, "id" | "memory">, question: string): Promise<MemoryContext> {
  const { pinned, rest } = splitMemory(bot.memory);
  if (!rest.length || !subjectWords(question)) return { pinned, recalled: [] };
  return { pinned, recalled: await searchMemory(bot, rest, question) };
}

export function recalledPrompt(recalled: string[]): string {
  return recalled.length ? `Other things you remember about the user that may matter here:\n${recalled.map((m) => `- ${m}`).join("\n")}` : "";
}
