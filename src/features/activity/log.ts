import type { ActivityEntry } from "../../lib/agent/activity";

export type ActivityFilter = {
  botId: string;
  /** "ran" = done, "failed" = error, "refused" = denied (by a rule or by you), "asked" = needed your OK. */
  outcome: "all" | "ran" | "failed" | "refused" | "asked";
  /** Hours back, 0 = all time. */
  hours: number;
  query: string;
};

export const ALL: ActivityFilter = { botId: "", outcome: "all", hours: 0, query: "" };

/** Whether the action needed the user's OK (they answered either way). */
export function wasAsked(entry: ActivityEntry): boolean {
  return /^asked\b|needed approval/.test(entry.decision ?? "");
}

export function filterActivity(entries: ActivityEntry[], filter: ActivityFilter, now = Date.now()): ActivityEntry[] {
  const since = filter.hours ? now - filter.hours * 3600_000 : 0;
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (e.at < since) return false;
    if (filter.botId && e.botId !== filter.botId) return false;
    if (filter.outcome === "ran" && e.outcome !== "done") return false;
    if (filter.outcome === "failed" && e.outcome !== "error") return false;
    if (filter.outcome === "refused" && e.outcome !== "denied") return false;
    if (filter.outcome === "asked" && !wasAsked(e)) return false;
    if (!words.length) return true;
    const hay = `${e.bot} ${e.tool} ${e.summary} ${e.args ?? ""} ${e.result ?? ""} ${e.decision ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function activityStats(entries: ActivityEntry[]) {
  return {
    total: entries.length,
    failed: entries.filter((e) => e.outcome === "error").length,
    refused: entries.filter((e) => e.outcome === "denied").length,
    asked: entries.filter(wasAsked).length,
  };
}

const COLUMNS = ["time", "bot", "tool", "outcome", "summary", "decision", "outside content", "arguments", "result", "ms", "chat"] as const;

/** The log as CSV (spreadsheets), one action per row. */
export function activityCsv(entries: ActivityEntry[]): string {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? "" : String(value);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = entries.map((e) =>
    [new Date(e.at).toISOString(), e.bot, e.tool, e.outcome, e.summary, e.decision, e.taint, e.args, e.result, e.ms, e.conversationId].map(cell).join(","),
  );
  return [COLUMNS.join(","), ...rows].join("\r\n");
}
