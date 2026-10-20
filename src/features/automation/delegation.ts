/**
 * Bots working together: one bot hands a task to another, which does it with its own model,
 * prompt, knowledge and tools in a linked chat, and reports back.
 *
 * The reply shape (Status / Result / Evidence / Unblock) follows the idea of nightly-labs OpenBot's
 * teammate policy, re-written here; no code was copied.
 */
import { sendInBackground } from "../../lib/chat";
import { useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { addBackgroundConversation } from "./conversations";

/** user → bot A → bot B → bot C, and C can't hand work on any further. */
export const MAX_DELEGATION_DEPTH = 2;
export const DELEGATION_TIMEOUT_MS = 5 * 60_000;

type Chain = { depth: number; bots: string[] };

/** Delegated chats and how they were reached: conversationId → depth and the bots above it. */
const chains = new Map<string, Chain>();

export function registerChain(conversationId: string, chain: Chain) {
  chains.set(conversationId, chain);
}

export function chainFor(conversationId: string, botId: string): Chain {
  return chains.get(conversationId) ?? { depth: 0, bots: [botId] };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^@/, "");

/** Finds a bot by name or nickname: exact first, then a unique partial match. */
export function resolveBot(bots: Bot[], ref: string): Bot | { error: string } {
  const key = norm(ref);
  if (!key) return { error: "Say which bot to ask (its name or nickname)." };
  const exact = bots.filter((b) => b.id === ref || norm(b.name) === key || (b.nickname && norm(b.nickname) === key));
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : bots.filter((b) => norm(b.name).includes(key) || (b.nickname && norm(b.nickname).includes(key)));
  if (partial.length === 1) return partial[0];
  const names = bots.map((b) => b.name).join(", ");
  if (partial.length > 1) return { error: `"${ref}" matches several bots (${partial.map((b) => b.name).join(", ")}). Use the full name.` };
  return { error: `There's no bot called "${ref}". Bots: ${names || "none"}.` };
}

export type DelegationCheck = { ok: true; chain: Chain } | { ok: false; reason: string };

/** Loop guards: no asking yourself, no handing work back up the chain, and a depth limit. */
export function checkDelegation(caller: Bot, target: Bot, conversationId: string): DelegationCheck {
  const chain = chainFor(conversationId, caller.id);
  if (target.id === caller.id) return { ok: false, reason: "You can't delegate to yourself; do the task directly." };
  if (chain.bots.includes(target.id)) {
    return { ok: false, reason: `${target.name} handed this work to you, so don't send it back. Finish it yourself or report what's blocking you.` };
  }
  if (chain.depth >= MAX_DELEGATION_DEPTH) {
    return { ok: false, reason: `This task is already ${chain.depth} hand-offs deep, the limit. Do it yourself or report what's blocking you.` };
  }
  return { ok: true, chain: { depth: chain.depth + 1, bots: [...chain.bots, target.id] } };
}

/** The message the other bot receives. */
export function delegationPrompt(callerName: string, task: string, context = ""): string {
  return [
    `Task from ${callerName}, another bot working for the same user:`,
    "",
    task.trim(),
    ...(context.trim() ? ["", `Background from ${callerName}:`, context.trim()] : []),
    "",
    `Do this yourself with your own tools and knowledge. ${callerName} will pass your answer on to the user, ` +
      "so make it complete on its own. Don't take risky actions (sending, paying, deleting, posting) unless the task says the user asked for them.",
    "End with a report in exactly this shape:",
    "Status: done | partial | blocked",
    "Result: the outcome itself (the answer, findings, or what you changed)",
    'Evidence: sources, files, commands or tool results that back it up, or "none"',
    "Unblock: the single thing needed to finish (only when partial or blocked)",
  ].join("\n");
}

/** Makes sure the caller always gets the four-part shape, even from a model that ignored it. */
export function normaliseReport(text: string, problem?: string): string {
  const body = text.trim();
  if (problem) {
    return [`Status: ${body ? "partial" : "blocked"}`, `Result: ${body || "No answer."}`, "Evidence: none", `Unblock: ${problem}`].join("\n");
  }
  if (/^\W*status\W*:/im.test(body)) return body;
  return ["Status: done", `Result: ${body || "No answer."}`, "Evidence: none"].join("\n");
}

export type DelegationResult = { report: string; conversationId: string; title: string; ok: boolean };

/** Runs `target` on the task in a linked chat and returns its report. Throws when a guard refuses. */
export async function delegate(options: {
  caller: Bot;
  target: Bot;
  task: string;
  context?: string;
  conversationId: string;
  signal: AbortSignal;
  progress?: (text: string) => void;
  timeoutMs?: number;
  /** The caller was working for a shared room, or where approvals can't be answered: so is the helper. */
  shared?: boolean;
  unattended?: boolean;
  /** Outside content the caller's turn had read: the helper's turn starts with it. */
  taintedBy?: string[];
}): Promise<DelegationResult> {
  const { caller, target, task, conversationId, progress } = options;
  if (!task.trim()) throw new Error("Describe the task for the other bot.");
  const check = checkDelegation(caller, target, conversationId);
  if (!check.ok) throw new Error(check.reason);

  const parentTemporary = Boolean(useStore.getState().conversations[conversationId]?.temporary);
  const title = `Task from ${caller.name}: ${task.trim().split("\n")[0]}`;
  const conversation = addBackgroundConversation(target.id, title, parentTemporary);
  registerChain(conversation.id, check.chain);

  const timeoutMs = options.timeoutMs ?? DELEGATION_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  progress?.(`${target.name} is working on it…`);

  // The other bot's actions still need the user's OK; point them at the chat where the card is.
  let waiting = false;
  const unsubscribe = useStore.subscribe((state) => {
    const last = state.conversations[conversation.id]?.messages.at(-1);
    const now = Boolean(last?.toolCalls?.some((c) => c.status === "awaiting"));
    if (now !== waiting) {
      waiting = now;
      progress?.(now ? `${target.name} needs your approval: open the chat "${conversation.title}".` : `${target.name} is working on it…`);
    }
  });

  try {
    const reply = await sendInBackground(conversation.id, delegationPrompt(caller.name, task, options.context), {
      signal,
      shared: options.shared,
      unattended: options.unattended,
      taintedBy: options.taintedBy,
    });
    if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const text = reply?.content ?? "";
    const problem = timeout.aborted
      ? `${target.name} ran out of time (${Math.round(timeoutMs / 60_000)} min). Try a smaller task.`
      : reply?.error
        ? reply.error
        : !reply
          ? `${target.name} didn't answer.`
          : undefined;
    return { report: normaliseReport(text, problem), conversationId: conversation.id, title: conversation.title, ok: !problem };
  } finally {
    unsubscribe();
  }
}
