/**
 * Skills: reusable how-tos the bots share. A skill has a name (typed as /name), a description that
 * says when to use it, and instructions. Bots see the list of names and descriptions and fetch the
 * instructions with use_skill when a task calls for one; /name in the message box hands a skill to
 * the bot directly. Skills read and write the SKILL.md format (YAML front matter with name and
 * description, then the instructions), so they move to and from other agents.
 */
import { uid, useStore } from "../../lib/store";
import type { Bot, Skill } from "../../lib/types";

export const MAX_SKILLS = 200;
export const MAX_INSTRUCTIONS = 20_000;
/** Skills listed to a bot at most (by most recently updated). */
const LISTED = 40;

/** A skill name from any text: lowercase letters, digits and hyphens, 2–48 characters. */
export function skillName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** Commands the message box already uses: no skill may take these names. */
const RESERVED = new Set(["remember", "imagine", "image", "search", "research", "video", "skill", "skills"]);

export type SkillInput = Pick<Skill, "name" | "description" | "instructions"> & Partial<Pick<Skill, "bots" | "source" | "outside">>;

/** Checks a skill's fields; returns an error sentence or null. */
export function validateSkill(input: Partial<SkillInput>, others: Skill[] = [], id?: string): string | null {
  const name = input.name ?? "";
  if (!name) return "Give the skill a name.";
  if (name !== skillName(name) || name.length < 2) return "Use lowercase letters, numbers and hyphens for the name (e.g. weekly-report).";
  if (RESERVED.has(name)) return `"/${name}" is already a command; pick another name.`;
  if (others.some((s) => s.name === name && s.id !== id)) return `There's already a skill called ${name}.`;
  if (!input.description?.trim()) return "Say when to use the skill.";
  if (input.description.length > 500) return "Keep the description under 500 characters.";
  if (!input.instructions?.trim()) return "Write the skill's instructions.";
  if (input.instructions.length > MAX_INSTRUCTIONS) return `The instructions are too long (${MAX_INSTRUCTIONS.toLocaleString()} characters max).`;
  return null;
}

/**
 * The top-level text fields of YAML front matter: `key: value`, quoted values, and folded (>) or
 * literal (|) blocks. Enough for SKILL.md's name and description without a YAML library.
 */
export function frontMatter(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (/^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.test(value)) {
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value)![0];
      try {
        value = JSON.parse(quoted);
      } catch {
        value = quoted.slice(1, -1);
      }
    } else if (/^'((?:[^']|'')*)'(?:\s+#.*)?$/.test(value)) {
      value = /^'((?:[^']|'')*)'/.exec(value)![1].replace(/''/g, "'");
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

/** Reads a SKILL.md file (or plain Markdown: the name then comes from the file or first heading). */
export function parseSkillMarkdown(text: string, fileName = ""): SkillInput {
  const front = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let meta: Record<string, unknown> = {};
  let body = text;
  if (front) {
    meta = frontMatter(front[1]);
    body = front[2];
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  const fromFile = fileName.replace(/\.(md|markdown|txt)$/i, "").replace(/^skill$/i, "");
  const name = skillName(String(meta.name ?? "") || heading || fromFile || "imported-skill");
  const firstParagraph = body
    .replace(/^#.*$/m, "")
    .trim()
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  const description = String(meta.description ?? "").trim() || (firstParagraph ?? "").slice(0, 300);
  return { name, description, instructions: body.trim() };
}

/** A skill as a SKILL.md file. */
export function skillMarkdown(skill: Pick<Skill, "name" | "description" | "instructions">): string {
  const yamlString = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());
  return `---\nname: ${skill.name}\ndescription: ${yamlString(skill.description)}\n---\n\n${skill.instructions.trim()}\n`;
}

/** The skills a bot may use, most recently updated first. */
export function skillsFor(bot: Pick<Bot, "id">, skills: Skill[]): Skill[] {
  return skills.filter((s) => s.bots === "all" || s.bots.includes(bot.id)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Tells the bot which skills it has (names and when to use them); use_skill fetches the steps. */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return "";
  const lines = skills.slice(0, LISTED).map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 200)}`);
  return [
    "Skills: saved how-tos for tasks the user does again and again. When a task matches one, call use_skill with its name first and follow its steps.",
    ...lines,
    skills.length > LISTED ? `(${skills.length - LISTED} more: use_skill also finds them by name)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A skill by name (or id), exact first, then a unique partial match. */
export function findSkill(skills: Skill[], ref: string): Skill | undefined {
  const key = skillName(ref.replace(/^\//, ""));
  if (!key) return undefined;
  const exact = skills.find((s) => s.id === ref || s.name === key);
  if (exact) return exact;
  const partial = skills.filter((s) => s.name.includes(key));
  return partial.length === 1 ? partial[0] : undefined;
}

/** The skill a message hands the bot: "/name" at the start of a line (also inside a routine's instruction). */
export function invokedSkill(text: string, skills: Skill[]): Skill | undefined {
  for (const match of text.matchAll(/^\s*\/([a-z0-9][a-z0-9-]{1,47})(?=\s|$)/gm)) {
    const skill = skills.find((s) => s.name === match[1]);
    if (skill) return skill;
  }
  return undefined;
}

/** What a bot reads when it uses a skill. */
export function skillText(skill: Skill): string {
  return `Skill "${skill.name}" (${skill.description.replace(/\s+/g, " ").trim()}):\n\n${skill.instructions.trim()}`;
}

// Store -----------------------------------------------------------------------------------------

export function addSkill(input: SkillInput, now = Date.now()): Skill {
  const { skills } = useStore.getState();
  const error = validateSkill(input, skills);
  if (error) throw new Error(error);
  if (skills.length >= MAX_SKILLS) throw new Error(`You have ${MAX_SKILLS} skills, the most there can be. Delete some first.`);
  const skill: Skill = {
    id: uid(),
    name: input.name,
    description: input.description.trim(),
    instructions: input.instructions.trim(),
    bots: input.bots ?? "all",
    source: input.source ?? "user",
    ...(input.outside ? { outside: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
  useStore.setState((s) => ({ skills: [...s.skills, skill] }));
  return skill;
}

export function updateSkill(id: string, patch: Partial<SkillInput>, now = Date.now()): Skill {
  const { skills } = useStore.getState();
  const current = skills.find((s) => s.id === id);
  if (!current) throw new Error("That skill no longer exists.");
  const merged = { ...current, ...patch };
  const error = validateSkill(merged, skills, id);
  if (error) throw new Error(error);
  const updated: Skill = {
    ...merged,
    description: merged.description.trim(),
    instructions: merged.instructions.trim(),
    // Stays outside content until the user marks it as checked (Skills screen).
    outside: patch.outside ?? current.outside,
    updatedAt: now,
  };
  if (!updated.outside) delete updated.outside;
  useStore.setState((s) => ({ skills: s.skills.map((x) => (x.id === id ? updated : x)) }));
  return updated;
}

export function deleteSkill(id: string) {
  useStore.setState((s) => ({ skills: s.skills.filter((x) => x.id !== id), tombstones: { ...s.tombstones, [id]: Date.now() } }));
}
