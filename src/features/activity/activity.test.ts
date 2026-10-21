// @vitest-environment node
// The agent log keeps secrets out, filters by bot/outcome/time/words, and exports CSV that a
// spreadsheet can't run as formulas. Plus the Memory screen's import and export.
import { describe, expect, it } from "vitest";
import { type ActivityEntry, redactArgs, resultPreview } from "../../lib/agent/activity";
import { activityCsv, activityStats, filterActivity, ALL } from "./log";
import { matches, memoryMarkdown, parseMemoryText } from "../memory/memory";
import type { Bot } from "../../lib/types";

const entry = (patch: Partial<ActivityEntry>): ActivityEntry => ({ id: crypto.randomUUID(), at: Date.now(), bot: "ADT", botId: "b1", tool: "run_command", summary: "", outcome: "done", ...patch });

describe("agent log", () => {
  it("hides secrets and images in arguments", () => {
    const text = redactArgs({
      url: "https://api.example.com",
      headers: { Authorization: "Bearer abc", "x-api-key": "k" },
      password: "hunter2",
      body: "my key is sk-proj-abcdefghijklmnop1234 ok",
      image: "data:image/png;base64,AAAA",
      note: "x".repeat(400),
    });
    expect(text).not.toMatch(/hunter2|Bearer abc|sk-proj-abcdefghijklmnop1234|AAAA/);
    expect(text).toMatch(/"password":"•••"/);
    expect(text).toMatch(/"body":"my key is ••• ok"/);
    expect(text).toMatch(/"image":"\[image\/png\]"/);
    expect(text.length).toBeLessThanOrEqual(601);
    expect(resultPreview("a\n\n  b")).toBe("a b");
  });

  it("filters by bot, outcome, time and words", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const log = [
      entry({ at: now - 1000, tool: "web_search", summary: "lisbon hotels", decision: "read-only" }),
      entry({ at: now - 2000, botId: "b2", bot: "Coder", outcome: "denied", decision: "asked (changes ask first); you declined" }),
      entry({ at: now - 3 * 86_400_000, outcome: "error", result: "Error: timed out" }),
      entry({ at: now - 4000, decision: "asked (this conversation just read outside content); you allowed it" }),
    ];
    expect(filterActivity(log, { ...ALL, botId: "b2" }, now)).toHaveLength(1);
    expect(filterActivity(log, { ...ALL, outcome: "asked" }, now)).toHaveLength(2);
    expect(filterActivity(log, { ...ALL, outcome: "failed" }, now)).toHaveLength(1);
    expect(filterActivity(log, { ...ALL, hours: 24 }, now)).toHaveLength(3);
    expect(filterActivity(log, { ...ALL, query: "LISBON search" }, now)).toHaveLength(1);
    expect(activityStats(log)).toEqual({ total: 4, failed: 1, refused: 1, asked: 2 });
  });

  it("exports CSV that spreadsheets read as text, not formulas", () => {
    const csv = activityCsv([entry({ at: 0, summary: '=HYPERLINK("http://evil","x")', result: "line1\nline2, more" })]);
    const [head, row] = csv.split("\r\n");
    expect(head).toBe("time,bot,tool,outcome,summary,decision,outside content,arguments,result,ms,chat");
    expect(row).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain('"line1\nline2, more"');
  });
});

describe("memory screen", () => {
  it("imports facts from Markdown or plain text, skipping headings and repeats", () => {
    expect(parseMemoryText("# What the bots remember\n\nExported 2026-10-21.\n\n## Every bot\n\n- Lives in Kolkata\n* Works as a designer\n1. Has a cat named Miso\n- Lives in Kolkata\n(nothing)\nPrefers tea")).toEqual([
      "Lives in Kolkata",
      "Works as a designer",
      "Has a cat named Miso",
      "Prefers tea",
    ]);
  });

  it("exports everything the bots remember and reads back the same facts", () => {
    const bots = [{ name: "ADT", memory: ["Likes short answers"], journal: [{ conversationId: "c", title: "Trip", summary: "Planned Lisbon.", at: 0 }] }] as unknown as Bot[];
    const md = memoryMarkdown(bots, ["Lives in Kolkata"], new Date(0));
    expect(md).toMatch(/## Every bot\n\n- Lives in Kolkata/);
    expect(md).toMatch(/## ADT\n\n- Likes short answers/);
    expect(md).toMatch(/1970-01-01, "Trip": Planned Lisbon\./);
    expect(parseMemoryText(md)).toEqual(["Lives in Kolkata", "Likes short answers"]);
    expect(matches("The user lives in Kolkata", "kolkata LIVES")).toBe(true);
    expect(matches("The user lives in Kolkata", "pune")).toBe(false);
  });
});
