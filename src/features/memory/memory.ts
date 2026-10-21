import type { Bot } from "../../lib/types";

/** Everything the bots remember, as a Markdown file to keep or move to another device. */
export function memoryMarkdown(bots: Bot[], shared: string[], now = new Date()): string {
  const lines = [`# What the bots remember`, "", `Exported ${now.toISOString().slice(0, 10)}.`, ""];
  lines.push("## Every bot", "", ...(shared.length ? shared.map((f) => `- ${f}`) : ["(nothing)"]), "");
  for (const bot of bots) {
    lines.push(`## ${bot.name}`, "", ...(bot.memory.length ? bot.memory.map((f) => `- ${f}`) : ["(nothing)"]), "");
    if (bot.journal?.length) {
      lines.push(`### ${bot.name}'s notes on past chats`, "");
      for (const n of bot.journal) lines.push(`- ${new Date(n.at).toISOString().slice(0, 10)}, "${n.title}": ${n.summary}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Facts from a text or Markdown file: list items ("- ", "* ", "1. "), or plain lines. Headings,
 * placeholders and blank lines are skipped; very long lines are cut.
 */
export function parseMemoryText(text: string): string[] {
  const facts: string[] = [];
  let inNotes = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // An exported file's notes on past chats aren't facts.
    if (line.startsWith("#")) inNotes = /notes on past chats/i.test(line);
    if (!line || inNotes || line.startsWith("#") || /^exported\b/i.test(line) || line === "(nothing)") continue;
    const fact = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (fact.length < 3) continue;
    const clipped = fact.length > 500 ? fact.slice(0, 500) : fact;
    if (!facts.includes(clipped)) facts.push(clipped);
  }
  return facts;
}

/** Whether a fact or note matches the search box (every word, any order, any case). */
export function matches(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}
