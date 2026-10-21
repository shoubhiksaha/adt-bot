// @vitest-environment node
// Teach a task: what the Mac helper recorded (this is its real output for a test run) becomes a
// recipe with blanks, Return after typing becomes "and send", passwords and unlabeled clicks are
// left out (and said so), and the recipe passes the same checks as one a bot saves.
import { describe, expect, it } from "vitest";
import { validateRecipe } from "./recipes";
import { blankName, draftRecipe, type RecordedStep, stepsInWords } from "./teach";

const RECORDED: RecordedStep[] = [
  { kind: "app", app: "WhatsApp" },
  { kind: "click", app: "WhatsApp", role: "search field", label: "Search" },
  { kind: "type", app: "WhatsApp", field: "Search", text: "Mom" },
  { kind: "click", app: "WhatsApp", role: "row", label: "Mom" },
  { kind: "type", app: "WhatsApp", field: "Type a message", text: "On my way" },
  { kind: "key", app: "WhatsApp", combo: "return" },
  { kind: "type", app: "WhatsApp", field: "Password", secure: true },
  { kind: "key", app: "Notes", combo: "cmd+s" },
];

describe("teach a task", () => {
  it("turns the recording into a recipe with blanks", () => {
    const draft = draftRecipe(RECORDED);
    expect(draft.steps).toEqual([
      { tool: "mac_open_app", args: { app: "WhatsApp" } },
      { tool: "mac_set_text", args: { app: "WhatsApp", field: "Search", text: "{{search}}" } },
      { tool: "mac_press", args: { app: "WhatsApp", text: "Mom", role: "row" } },
      { tool: "mac_set_text", args: { app: "WhatsApp", field: "Type a message", text: "{{message}}", submit: true } },
      { tool: "mac_open_app", args: { app: "Notes" } },
      { tool: "mac_key", args: { app: "Notes", combo: "cmd+s" } },
    ]);
    expect(draft.params).toEqual(["search", "message"]);
    expect(draft.examples).toEqual({ search: "Mom", message: "On my way" });
    expect(draft.skipped).toEqual([expect.stringMatching(/password typed in WhatsApp: bots never type passwords/)]);
    // The same checks as a recipe a bot saves.
    expect(validateRecipe({ name: "message mom", params: draft.params, steps: draft.steps }).steps).toHaveLength(6);
  });

  it("describes it in words for a skill", () => {
    expect(stepsInWords(draftRecipe(RECORDED).steps)).toBe(
      [
        "1. Open WhatsApp.",
        "2. Type <search> into “Search” in WhatsApp.",
        "3. Press “Mom” (row) in WhatsApp.",
        "4. Type <message> into “Type a message” in WhatsApp and send it (Return).",
        "5. Open Notes.",
        "6. Press cmd+s in Notes.",
      ].join("\n"),
    );
  });

  it("leaves out clicks it can't name, keeps right and double clicks, and names blanks well", () => {
    const draft = draftRecipe([
      { kind: "click", app: "Finder", role: "image" },
      { kind: "click", app: "Finder", role: "row", label: "Report.pdf", clicks: 2 },
      { kind: "click", app: "Finder", role: "row", label: "Report.pdf", button: "right" },
      { kind: "key", app: "Finder", combo: "page down" },
    ]);
    expect(draft.skipped[0]).toMatch(/unlabeled spot in Finder/);
    expect(draft.steps.slice(1)).toEqual([
      { tool: "mac_press", args: { app: "Finder", text: "Report.pdf", role: "row", action: "double_click" } },
      { tool: "mac_press", args: { app: "Finder", text: "Report.pdf", role: "row", action: "right_click" } },
      { tool: "mac_key", args: { app: "Finder", combo: "pagedown" } },
    ]);
    expect(blankName("Type a message", [])).toBe("message");
    expect(blankName("Search", ["search"])).toBe("search2");
    expect(blankName("", [])).toBe("text");
  });

  it("keeps a long recording to the recipe limit", () => {
    const long: RecordedStep[] = Array.from({ length: 40 }, (_, i) => ({ kind: "click", app: "Mail", role: "button", label: `B${i}` }));
    const draft = draftRecipe(long);
    expect(draft.steps).toHaveLength(25);
    expect(draft.skipped.at(-1)).toMatch(/first 25 steps/);
  });
});
