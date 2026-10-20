import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ToolRisk } from "../../lib/agent/tools";

/**
 * Recipes: app tasks the bot worked out once (e.g. "send a WhatsApp message"), saved as steps with
 * {{placeholders}} and replayed later without the model figuring them out again. The idea comes
 * from Ghost OS's recipes (github.com/ghostwright/ghost-os, MIT): a capable model learns the
 * workflow once, then it runs fast and the same way every time.
 */
export type RecipeStep = { tool: string; args: Record<string, unknown>; note?: string };

export type Recipe = {
  name: string;
  description: string;
  params: string[];
  steps: RecipeStep[];
  createdAt: number;
  runs: number;
  lastRunAt?: number;
};

type RecipeState = { recipes: Recipe[] };

export const useRecipes = create<RecipeState>()(
  persist((): RecipeState => ({ recipes: [] }), {
    name: "adt-mac-recipes",
    storage: createJSONStorage(() => localStorage),
  }),
);

/** Tools a recipe may use: acting in apps and browsers, nothing else. */
export const RECIPE_TOOLS = new Set([
  "mac_open_app",
  "mac_ui",
  "mac_press",
  "mac_set_text",
  "mac_key",
  "mac_type",
  "mac_click",
  "mac_scroll",
  "mac_browser",
  "mac_find_text",
]);

export const MAX_STEPS = 25;

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _'-]{0,59}$/u;
const PLACEHOLDER = /\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu;

/** Checks a recipe the model wants to save; returns it cleaned, or throws saying what's wrong. */
export function validateRecipe(input: { name: string; description?: string; params?: unknown; steps?: unknown }): Omit<Recipe, "createdAt" | "runs"> {
  const name = String(input.name ?? "").trim();
  if (!NAME.test(name)) throw new Error("Give the recipe a short name (letters, numbers, spaces), e.g. \"send whatsapp message\".");
  const params = Array.isArray(input.params) ? [...new Set(input.params.map((p) => String(p).trim()).filter(Boolean))] : [];
  if (params.some((p) => !/^[\p{L}\p{N}_]{1,40}$/u.test(p))) throw new Error("Parameter names are single words, e.g. contact, message.");
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error("A recipe needs at least one step.");
  if (input.steps.length > MAX_STEPS) throw new Error(`A recipe can have at most ${MAX_STEPS} steps.`);
  const steps = input.steps.map((raw, i): RecipeStep => {
    const step = raw as Partial<RecipeStep>;
    const tool = String(step?.tool ?? "");
    if (!RECIPE_TOOLS.has(tool)) throw new Error(`Step ${i + 1}: "${tool}" can't be used in a recipe. Use: ${[...RECIPE_TOOLS].join(", ")}.`);
    const args = step.args && typeof step.args === "object" && !Array.isArray(step.args) ? { ...step.args } : {};
    // Element ids change every time a window is read: recipes must name things.
    if ("id" in args) throw new Error(`Step ${i + 1}: use the element's text (text, field or element) instead of its id; ids change every time.`);
    for (const used of JSON.stringify(args).matchAll(PLACEHOLDER)) {
      if (!params.includes(used[1])) throw new Error(`Step ${i + 1} uses {{${used[1]}}}, which isn't in params.`);
    }
    return { tool, args, ...(step.note ? { note: String(step.note).slice(0, 200) } : {}) };
  });
  return { name, description: String(input.description ?? "").trim().slice(0, 300), params, steps };
}

/** The step's arguments with {{placeholders}} filled in. */
export function fill(args: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  const sub = (value: unknown): unknown => {
    if (typeof value === "string") {
      // A whole-string placeholder keeps the value as given; inside text it's spliced in.
      return value.replace(PLACEHOLDER, (_, key: string) => values[key] ?? "");
    }
    if (Array.isArray(value)) return value.map(sub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sub(v)]));
    return value;
  };
  return sub(args) as Record<string, unknown>;
}

/** Placeholders a run is missing values for. */
export function missingParams(recipe: Recipe, values: Record<string, string>): string[] {
  return recipe.params.filter((p) => !String(values[p] ?? "").trim());
}

const RANK: Record<ToolRisk, number> = { read: 0, write: 1, external: 2, destructive: 3 };

/** The riskiest step decides whether running the recipe asks first. */
export function highestRisk(risks: ToolRisk[]): ToolRisk {
  return risks.reduce<ToolRisk>((top, r) => (RANK[r] > RANK[top] ? r : top), "read");
}

export function findRecipe(name: string): Recipe | undefined {
  const want = name.trim().toLowerCase();
  const all = useRecipes.getState().recipes;
  return all.find((r) => r.name.toLowerCase() === want) ?? all.find((r) => r.name.toLowerCase().includes(want));
}

export function saveRecipe(recipe: Omit<Recipe, "createdAt" | "runs">): { replaced: boolean } {
  let replaced = false;
  useRecipes.setState((s) => {
    const others = s.recipes.filter((r) => {
      const same = r.name.toLowerCase() === recipe.name.toLowerCase();
      replaced ||= same;
      return !same;
    });
    return { recipes: [...others, { ...recipe, createdAt: Date.now(), runs: 0 }].slice(-100) };
  });
  return { replaced };
}

export function deleteRecipe(name: string): boolean {
  const before = useRecipes.getState().recipes.length;
  useRecipes.setState((s) => ({ recipes: s.recipes.filter((r) => r.name.toLowerCase() !== name.trim().toLowerCase()) }));
  return useRecipes.getState().recipes.length < before;
}

export function markRun(name: string) {
  useRecipes.setState((s) => ({ recipes: s.recipes.map((r) => (r.name === name ? { ...r, runs: r.runs + 1, lastRunAt: Date.now() } : r)) }));
}

/** One line per recipe, for the model. */
export function recipeLine(r: Recipe): string {
  return `- "${r.name}"${r.params.length ? ` (${r.params.join(", ")})` : ""}: ${r.description || `${r.steps.length} steps`}`;
}
