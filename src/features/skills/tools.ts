/** Bot tools for skills: fetch a skill's steps, and save a task that went well as a skill. */
import { registerTool, registerToolGroup, str } from "../../lib/agent/tools";
import { useStore } from "../../lib/store";
import { addSkill, findSkill, skillName, skillsFor, skillText, updateSkill } from "./skills";

registerToolGroup({ id: "skills", label: "Skills", description: "Use saved how-tos, and save new ones." });

registerTool({
  name: "use_skill",
  group: "skills",
  risk: "read",
  description: "Get the steps of one of your skills (saved how-tos) by name, before doing a task it covers.",
  parameters: { type: "object", properties: { name: { type: "string", description: "The skill's name, e.g. weekly-report" } }, required: ["name"] },
  available: ({ bot }) => skillsFor(bot, useStore.getState().skills).length > 0,
  async run(args, ctx) {
    const mine = skillsFor(ctx.bot, useStore.getState().skills);
    const skill = findSkill(mine, str(args, "name"));
    if (!skill) return `No skill called "${str(args, "name")}". Your skills: ${mine.map((s) => s.name).join(", ") || "none"}.`;
    // Steps from a file or from a chat that read the web are information, not orders.
    return skill.outside ? { content: skillText(skill), untrustedSource: `the skill "${skill.name}" (imported or written from outside content)` } : skillText(skill);
  },
});

registerTool({
  name: "save_skill",
  group: "skills",
  risk: "write",
  description:
    "Save a reusable how-to as a skill (or update one of yours with the same name), when the user asks you to remember how to do a task. " +
    "Include: when to use it, what it needs, the steps, how to check the result, what to return, and what needs the user's OK first.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short lowercase name with hyphens, e.g. weekly-report" },
      description: { type: "string", description: "When to use it, in one sentence" },
      instructions: { type: "string", description: "The how-to, in Markdown" },
    },
    required: ["name", "description", "instructions"],
  },
  async run(args, ctx) {
    const name = skillName(str(args, "name"));
    // Small models often leave out when to use it: say so from the name rather than refuse.
    const description = str(args, "description").trim() || (name ? `Use when the user asks for ${name.replace(/-/g, " ")}.` : "");
    const input = { name, description, instructions: str(args, "instructions") };
    // Written while the chat had read outside content: its steps stay marked that way.
    const outside = Boolean(ctx.taint?.sources.size);
    const existing = useStore.getState().skills.find((s) => s.name === name);
    if (existing) {
      updateSkill(existing.id, { ...input, ...(outside ? { outside: true } : {}) });
      return `Updated the skill /${name}.`;
    }
    addSkill({ ...input, source: "bot", outside });
    return `Saved the skill /${name}. The user can see and edit it in Skills, and use it by typing /${name}.`;
  },
});
