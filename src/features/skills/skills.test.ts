// @vitest-environment node
// Skills: SKILL.md in and out, names, which bot gets which, "/name" in a message, and skills from
// outside content staying marked as such.
import { beforeEach, describe, expect, it } from "vitest";
import { getTool, type ToolContext } from "../../lib/agent/tools";
import { taintSensitive } from "../../lib/agent/approvals";
import { defaultSettings, useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import {
  addSkill,
  findSkill,
  frontMatter,
  invokedSkill,
  parseSkillMarkdown,
  skillMarkdown,
  skillName,
  skillsFor,
  skillsPrompt,
  updateSkill,
  validateSkill,
} from "./skills";
import "./tools";

const bot = { id: "b1", name: "ADT", memory: [] } as unknown as Bot;
const ctx = (taint: string[] = []) =>
  ({ bot, conversationId: "c", settings: defaultSettings, providers: [], platform: "web", signal: new AbortController().signal, progress: () => undefined, taint: { sources: new Set(taint) } }) as ToolContext;

beforeEach(() => useStore.setState({ skills: [], settings: defaultSettings }));

describe("SKILL.md", () => {
  it("reads name, description and steps, and writes them back", () => {
    const md = `---\nname: weekly-report\ndescription: >\n  Writing the Friday status report\n  from this week's tasks\nlicense: MIT\n---\n\n# Weekly report\n\n1. Read the done cards.\n2. Write three bullets.\n`;
    const skill = parseSkillMarkdown(md, "SKILL.md");
    expect(skill).toEqual({ name: "weekly-report", description: "Writing the Friday status report from this week's tasks", instructions: "# Weekly report\n\n1. Read the done cards.\n2. Write three bullets." });
    expect(parseSkillMarkdown(skillMarkdown(skill))).toEqual(skill);
  });

  it("copes with plain Markdown and odd front matter", () => {
    expect(parseSkillMarkdown("# Expense Filing!\n\nHow I file expenses.\n\n- step", "x.md")).toMatchObject({ name: "expense-filing", description: "How I file expenses." });
    expect(parseSkillMarkdown("Just steps.", "Trip Planning.md").name).toBe("trip-planning");
    expect(frontMatter(`name: "a: b"\ndescription: 'it''s fine' # note\nother: |\n  line 1\n  line 2`)).toEqual({ name: "a: b", description: "it's fine", other: "line 1\nline 2" });
  });
});

describe("names and checks", () => {
  it("makes names safe for /name", () => {
    expect(skillName("  Weekly Report (Fridays) ")).toBe("weekly-report-fridays");
    expect(skillName("Résumé tips")).toBe("resume-tips");
    expect(validateSkill({ name: "search", description: "d", instructions: "i" })).toMatch(/already a command/);
    expect(validateSkill({ name: "Bad Name", description: "d", instructions: "i" })).toMatch(/lowercase/);
    expect(validateSkill({ name: "ok-name", description: "d", instructions: "i" })).toBeNull();
    addSkill({ name: "ok-name", description: "d", instructions: "i" });
    expect(() => addSkill({ name: "ok-name", description: "d", instructions: "i" })).toThrow(/already a skill/);
  });

  it("gives each bot its skills, lists them for the model, and finds them by name", () => {
    const all = addSkill({ name: "trip-planning", description: "Planning trips the way the user likes", instructions: "…" });
    const other = addSkill({ name: "code-review", description: "Reviewing a pull request", instructions: "…", bots: ["someone-else"] });
    const mine = skillsFor(bot, useStore.getState().skills);
    expect(mine.map((s) => s.name)).toEqual(["trip-planning"]);
    expect(skillsPrompt(mine)).toMatch(/call use_skill[\s\S]*- trip-planning: Planning trips/);
    expect(findSkill(mine, "/trip")).toBe(all);
    expect(findSkill(mine, "code-review")).toBeUndefined();
    expect(other.bots).toEqual(["someone-else"]);
  });

  it("spots /name at the start of a line, also inside a routine's framed instruction", () => {
    const skills = [addSkill({ name: "weekly-report", description: "d", instructions: "i" })];
    expect(invokedSkill("/weekly-report for last week", skills)?.name).toBe("weekly-report");
    expect(invokedSkill("[Routine fired]\n/weekly-report\n(stay quiet if nothing new)", skills)?.name).toBe("weekly-report");
    expect(invokedSkill("see /weekly-report", skills)).toBeUndefined();
    expect(invokedSkill("/weekly-reports", skills)).toBeUndefined();
  });
});

describe("bot tools", () => {
  it("use_skill hands over the steps; imported ones as outside content", async () => {
    const tool = getTool("use_skill")!;
    addSkill({ name: "mine", description: "d", instructions: "Do A then B." });
    addSkill({ name: "from-file", description: "d", instructions: "Do C.", source: "imported", outside: true });
    expect(await tool.run({ name: "mine" }, ctx())).toMatch(/Do A then B\./);
    expect(await tool.run({ name: "from-file" }, ctx())).toMatchObject({ untrustedSource: expect.stringMatching(/from-file/) });
    expect(await tool.run({ name: "nope" }, ctx())).toMatch(/No skill called "nope". Your skills: mine, from-file/);
  });

  it("save_skill saves, updates by name, and marks skills written after reading outside content", async () => {
    const tool = getTool("save_skill")!;
    expect(await tool.run({ name: "Weekly Report", description: "Friday report", instructions: "1. …" }, ctx())).toMatch(/Saved the skill \/weekly-report/);
    let [skill] = useStore.getState().skills;
    expect(skill).toMatchObject({ name: "weekly-report", source: "bot" });
    expect(skill.outside).toBeUndefined();
    await tool.run({ name: "weekly-report", description: "Friday report", instructions: "2. …" }, ctx(["a web page"]));
    [skill] = useStore.getState().skills;
    expect(skill).toMatchObject({ instructions: "2. …", outside: true });
    // Only the user clears it.
    updateSkill(skill.id, { instructions: "3. …" });
    expect(useStore.getState().skills[0].outside).toBe(true);
    updateSkill(skill.id, { outside: false });
    expect(useStore.getState().skills[0].outside).toBeUndefined();
  });

  it("saving a skill asks first once a turn has read outside content, even with Full access", () => {
    expect(taintSensitive(getTool("save_skill")!, "write")).toBe(true);
    expect(taintSensitive(getTool("use_skill")!, "read")).toBe(false);
  });
});
