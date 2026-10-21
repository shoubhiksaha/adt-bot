/**
 * Teach a task: what the user did once (recorded by the Mac helper) as a recipe bots can replay, and
 * as a skill in words. Clicks become presses by label, typing becomes "type into <field>" with the
 * typed text as a blank ({{search}}, {{message}}) to fill in next time, Return after typing becomes
 * "and send". Passwords are never recorded or replayed; unlabeled clicks are left out (and listed).
 */
import { MAX_STEPS, type RecipeStep } from "./recipes";

export type RecordedStep = {
  kind: "app" | "click" | "type" | "key";
  app: string;
  at?: number;
  label?: string;
  role?: string;
  field?: string;
  text?: string;
  secure?: boolean;
  combo?: string;
  button?: string;
  clicks?: number;
};

export type Draft = {
  steps: RecipeStep[];
  params: string[];
  /** Example values the user typed, per blank. */
  examples: Record<string, string>;
  /** What couldn't be turned into steps, in words. */
  skipped: string[];
};

const PRESSABLE = new Set(["button", "row", "link", "tab", "menu item", "menu", "checkbox", "radio button", "pop-up menu", "menu button", "switch", "toggle", "dock item", "disclosure"]);

/** A blank's name from a field's label: "Type a message" → message, "Search" → search. */
export function blankName(label: string, taken: string[]): string {
  const words = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !["type", "a", "an", "the", "your", "enter", "here", "write"].includes(w));
  const base = (words.at(-1) ?? "text").slice(0, 30) || "text";
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}${n}`;
  return name;
}

export function draftRecipe(recorded: RecordedStep[]): Draft {
  const steps: RecipeStep[] = [];
  const params: string[] = [];
  const examples: Record<string, string> = {};
  const skipped: string[] = [];
  let app = "";
  for (let i = 0; i < recorded.length; i++) {
    const s = recorded[i];
    const next = recorded[i + 1];
    if (s.kind === "app") {
      if (s.app && s.app !== app) steps.push({ tool: "mac_open_app", args: { app: s.app } });
      app = s.app || app;
      continue;
    }
    if (s.app && s.app !== app) {
      steps.push({ tool: "mac_open_app", args: { app: s.app } });
      app = s.app;
    }
    if (s.kind === "click") {
      // Clicking a field and then typing in it: the typing step finds the field itself.
      if (next?.kind === "type" && next.app === s.app && (next.field ?? "") === (s.label ?? "")) continue;
      if (!s.label) {
        skipped.push(`A click on an unlabeled spot in ${s.app || "an app"} (bots can't find it by name; do that part yourself or describe it in the skill).`);
        continue;
      }
      const action = s.button === "right" ? "right_click" : (s.clicks ?? 1) > 1 ? "double_click" : undefined;
      steps.push({ tool: "mac_press", args: { app: s.app, text: s.label, ...(s.role && PRESSABLE.has(s.role) ? { role: s.role.split(" ")[0] } : {}), ...(action ? { action } : {}) } });
      continue;
    }
    if (s.kind === "type") {
      if (s.secure) {
        skipped.push(`A password typed in ${s.app || "an app"}: bots never type passwords, so that part will ask you.`);
        continue;
      }
      if (!s.text) continue;
      const name = blankName(s.field || "text", params);
      params.push(name);
      examples[name] = s.text;
      const submit = next?.kind === "key" && /^(return|enter)$/.test(next.combo ?? "") && next.app === s.app;
      steps.push({ tool: "mac_set_text", args: { app: s.app, field: s.field ?? "", text: `{{${name}}}`, ...(submit ? { submit: true } : {}) } });
      if (submit) i++;
      continue;
    }
    if (s.kind === "key" && s.combo) {
      steps.push({ tool: "mac_key", args: { app: s.app, combo: s.combo.replace(/ /g, "") } });
    }
  }
  if (steps.length > MAX_STEPS) {
    skipped.push(`Only the first ${MAX_STEPS} steps were kept (a recipe can't be longer); split longer tasks.`);
    steps.length = MAX_STEPS;
    // Blanks only the dropped steps used go too.
    const used = JSON.stringify(steps);
    for (const p of [...params]) if (!used.includes(`{{${p}}}`)) params.splice(params.indexOf(p), 1);
  }
  return { steps, params, examples, skipped };
}

/** The same task in words, for a skill any bot (or a routine) can follow. */
export function stepsInWords(steps: RecipeStep[]): string {
  return steps
    .map((step, i) => {
      const a = step.args as Record<string, string | boolean | undefined>;
      const text = (v: unknown) => String(v ?? "").replace(/\{\{(\w+)\}\}/g, "<$1>");
      switch (step.tool) {
        case "mac_open_app":
          return `${i + 1}. Open ${a.app}.`;
        case "mac_press":
          return `${i + 1}. ${a.action === "right_click" ? "Right-click" : a.action === "double_click" ? "Double-click" : "Press"} “${a.text}”${a.role ? ` (${a.role})` : ""} in ${a.app}.`;
        case "mac_set_text":
          return `${i + 1}. Type ${text(a.text)} into ${a.field ? `“${a.field}”` : "the focused field"} in ${a.app}${a.submit ? " and send it (Return)" : ""}.`;
        case "mac_key":
          return `${i + 1}. Press ${a.combo} in ${a.app}.`;
        default:
          return `${i + 1}. ${step.tool} ${JSON.stringify(a)}`;
      }
    })
    .join("\n");
}
