// Regenerates src/lib/catalog.json from the model catalog Rakazo uses (pi-ai).
// Run `npm run catalog` after bumping @earendil-works/pi-ai to pick up new models.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The generated catalog is not a public export, so load it from the package directory.
const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
const { MODELS } = await import(pathToFileURL(join(dirname(entry), "models.generated.js")).href);

const PROVIDERS = [
  "xai", "openai", "anthropic", "google", "openrouter", "groq", "deepseek", "mistral",
  "together", "fireworks", "cerebras", "moonshotai", "nvidia", "huggingface", "zai",
];

// Models released after the pinned pi-ai catalog was generated.
const EXTRA = {
  anthropic: [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", vision: true, reasoning: true, context: 1000000 },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", vision: true, reasoning: true, context: 1000000 },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", vision: true, reasoning: true, context: 1000000 },
  ],
};

const catalog = {};
for (const provider of PROVIDERS) {
  const models = MODELS[provider];
  if (!models) continue;
  catalog[provider] = Object.values(models)
    .filter((m) => !/realtime|tts|transcribe|image|embedding|audio/i.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      vision: Array.isArray(m.input) && m.input.includes("image"),
      reasoning: Boolean(m.reasoning),
      context: m.contextWindow ?? null,
    }))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const extra of EXTRA[provider] ?? []) {
    if (!catalog[provider].some((m) => m.id === extra.id)) catalog[provider].unshift(extra);
  }
}
writeFileSync(new URL("../src/lib/catalog.json", import.meta.url), `${JSON.stringify(catalog, null, 1)}\n`);
console.log(Object.entries(catalog).map(([p, m]) => `${p}: ${m.length}`).join("\n"));
