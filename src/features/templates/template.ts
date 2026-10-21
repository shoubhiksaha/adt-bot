/**
 * Bot templates: a bot's setup as a file to share (its instructions, chosen memories, skills,
 * routines and knowledge files), never its chats, keys or logins. Adding one makes a new bot; its
 * routines arrive switched off, and a template from a file is outside content: its skills are
 * marked unchecked and its memories go through the memory screen.
 */
import { screen } from "../../lib/agent/vendor/openbot/memoryFilter";
import { loadText, saveKnowledgeText } from "../../lib/knowledge";
import { createBot, updateBot, useStore } from "../../lib/store";
import type { Bot, KnowledgeRef, ThinkingLevel } from "../../lib/types";
import { createRoutine, useRoutines } from "../automation/routines-store";
import { type Schedule, validateSchedule } from "../automation/schedule";
import { addSkill, skillName, skillsFor, validateSkill } from "../skills/skills";

export const TEMPLATE_APP = "adt-bot-template";

export type BotTemplate = {
  app: typeof TEMPLATE_APP;
  version: 1;
  bot: {
    name: string;
    nickname?: string;
    avatar: string;
    description: string;
    systemPrompt: string;
    temperature: number | null;
    thinking: ThinkingLevel;
    toolGroups?: string[] | "all";
    autoMemory: boolean;
    /** The model it was made with: used when you have that provider. */
    model?: { preset: string; model: string };
  };
  memory: string[];
  skills: { name: string; description: string; instructions: string }[];
  routines: { name: string; instruction: string; schedule: Schedule }[];
  knowledge: { name: string; text: string }[];
};

const LIMITS = { prompt: 20_000, memory: 100, fact: 500, skills: 30, routines: 20, files: 10, fileChars: 2_000_000, avatar: 300_000 };
const THINKING: ThinkingLevel[] = ["off", "low", "medium", "high"];

export type TemplateChoice = { memory: string[]; skillIds: string[]; routineIds: string[]; knowledgeIds: string[]; model: boolean };

/** Builds a template from one of your bots, with only what you chose to include. */
export async function buildTemplate(bot: Bot, choice: TemplateChoice): Promise<BotTemplate> {
  const { providers, skills } = useStore.getState();
  const provider = providers.find((p) => p.id === bot.providerId);
  const routines = useRoutines.getState().routines.filter((r) => r.botId === bot.id && choice.routineIds.includes(r.id));
  const files = (bot.knowledge ?? []).filter((k) => choice.knowledgeIds.includes(k.id));
  return {
    app: TEMPLATE_APP,
    version: 1,
    bot: {
      name: bot.name,
      ...(bot.nickname ? { nickname: bot.nickname } : {}),
      avatar: bot.avatar.length <= LIMITS.avatar ? bot.avatar : "✦",
      description: bot.description,
      systemPrompt: bot.systemPrompt,
      temperature: bot.temperature,
      thinking: bot.thinking,
      toolGroups: bot.toolGroups ?? "all",
      autoMemory: bot.autoMemory,
      ...(choice.model && provider && bot.model ? { model: { preset: provider.presetId, model: bot.model } } : {}),
    },
    memory: bot.memory.filter((m) => choice.memory.includes(m)),
    skills: skillsFor(bot, skills)
      .filter((s) => choice.skillIds.includes(s.id))
      .map(({ name, description, instructions }) => ({ name, description, instructions })),
    routines: routines.map(({ name, instruction, schedule }) => ({ name, instruction, schedule })),
    knowledge: await Promise.all(files.map(async (f) => ({ name: f.name, text: await loadText(f.id) }))),
  };
}

/**
 * An emoji or a picture inside the file. A web address would load from someone else's server when
 * the template is opened (it could tell them you looked), and SVG can carry scripts.
 */
export function safeAvatar(value: string): string {
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  if (!value || /^(data:|https?:|blob:|\.\/|javascript:)/i.test(value) || value.length > 16) return "✦";
  return value;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** Reads and checks a template file; throws a sentence saying what's wrong. */
export function parseTemplate(json: string): BotTemplate {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("This file isn't a bot template (it isn't JSON).");
  }
  if (data?.app !== TEMPLATE_APP) throw new Error("This file isn't an ADT Bot template.");
  if (data.version !== 1) throw new Error("This template was made by a newer version of ADT Bot. Update the app first.");
  const bot = (data.bot ?? {}) as Record<string, unknown>;
  const name = text(bot.name, 60).trim();
  if (!name) throw new Error("The template has no bot name.");
  const systemPrompt = text(bot.systemPrompt, LIMITS.prompt);
  const model = bot.model as { preset?: unknown; model?: unknown } | undefined;
  const list = <T>(value: unknown, max: number, map: (item: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(value) ? value : [])
      .slice(0, max)
      .map((item) => (item && typeof item === "object" ? map(item as Record<string, unknown>) : null))
      .filter((item): item is T => item !== null);
  return {
    app: TEMPLATE_APP,
    version: 1,
    bot: {
      name,
      nickname: text(bot.nickname, 40) || undefined,
      avatar: safeAvatar(text(bot.avatar, LIMITS.avatar)),
      description: text(bot.description, 300),
      systemPrompt,
      temperature: typeof bot.temperature === "number" && bot.temperature >= 0 && bot.temperature <= 2 ? bot.temperature : null,
      thinking: THINKING.includes(bot.thinking as ThinkingLevel) ? (bot.thinking as ThinkingLevel) : "off",
      toolGroups: bot.toolGroups === "all" ? "all" : Array.isArray(bot.toolGroups) ? bot.toolGroups.filter((g): g is string => typeof g === "string").slice(0, 40) : "all",
      autoMemory: bot.autoMemory !== false,
      ...(model && typeof model.preset === "string" && typeof model.model === "string" ? { model: { preset: model.preset.slice(0, 60), model: model.model.slice(0, 200) } } : {}),
    },
    memory: (Array.isArray(data.memory) ? data.memory : [])
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .slice(0, LIMITS.memory)
      .map((m) => m.trim().slice(0, LIMITS.fact)),
    skills: list(data.skills, LIMITS.skills, (s) => {
      const skill = { name: skillName(text(s.name, 60)), description: text(s.description, 500), instructions: text(s.instructions, 20_000) };
      return validateSkill(skill) ? null : skill;
    }),
    routines: list(data.routines, LIMITS.routines, (r) => {
      const routine = { name: text(r.name, 80).trim(), instruction: text(r.instruction, 8000).trim(), schedule: r.schedule as Schedule };
      if (!routine.name || !routine.instruction || !routine.schedule || typeof routine.schedule !== "object") return null;
      return validateSchedule(routine.schedule) ? null : routine;
    }),
    knowledge: list(data.knowledge, LIMITS.files, (k) => {
      const file = { name: text(k.name, 120).trim(), text: text(k.text, LIMITS.fileChars) };
      return file.name && file.text ? file : null;
    }),
  };
}

export type Installed = { bot: Bot; notes: string[] };

/**
 * Adds a template as a new bot. `trusted` is for the built-in gallery; a template from a file is
 * outside content (its skills come in unchecked, its memories are screened, its routines are off).
 */
export async function installTemplate(template: BotTemplate, trusted = false): Promise<Installed> {
  const notes: string[] = [];
  const { providers } = useStore.getState();
  const created = createBot();
  const preferred = template.bot.model && providers.find((p) => p.presetId === template.bot.model!.preset);
  const memory = trusted ? template.memory : template.memory.filter((m) => screen(m).ok);
  if (memory.length < template.memory.length) notes.push(`${template.memory.length - memory.length} memory item(s) looked like instructions or secrets and were left out.`);
  const knowledge: KnowledgeRef[] = [];
  for (const file of template.knowledge) knowledge.push(await saveKnowledgeText(file.name, file.text));
  updateBot(created.id, {
    name: template.bot.name,
    nickname: template.bot.nickname ?? "",
    avatar: template.bot.avatar,
    description: template.bot.description,
    systemPrompt: template.bot.systemPrompt,
    temperature: template.bot.temperature,
    thinking: template.bot.thinking,
    toolGroups: template.bot.toolGroups ?? "all",
    autoMemory: template.bot.autoMemory,
    memory,
    knowledge,
    ...(preferred ? { providerId: preferred.id, model: template.bot.model!.model } : {}),
  });
  if (template.bot.model && !preferred) notes.push(`It was made for ${template.bot.model.model}; it uses your default model instead (change it in the bot's settings).`);

  for (const skill of template.skills) {
    let name = skill.name;
    for (let n = 2; useStore.getState().skills.some((s) => s.name === name); n++) name = `${skill.name}-${n}`;
    try {
      addSkill({ ...skill, name, bots: [created.id], source: trusted ? "user" : "imported", outside: !trusted });
      if (name !== skill.name) notes.push(`The skill /${skill.name} was added as /${name} (you already had one with that name).`);
    } catch (error) {
      notes.push(`Skill /${skill.name}: ${(error as Error).message}`);
    }
  }
  for (const routine of template.routines) {
    try {
      await createRoutine({ botId: created.id, name: routine.name, instruction: routine.instruction, schedule: routine.schedule, enabled: false, ...(trusted ? {} : { taintedBy: ["a bot template file"] }) });
    } catch (error) {
      notes.push(`Routine "${routine.name}": ${(error as Error).message}`);
    }
  }
  if (template.routines.length) notes.push("Its routines are switched off: turn them on in Routines when you're ready.");
  return { bot: useStore.getState().bots.find((b) => b.id === created.id)!, notes };
}

/** A file name for a template. */
export function templateFileName(bot: Pick<Bot, "name">): string {
  return `${skillName(bot.name) || "bot"}.adtbot.json`;
}
