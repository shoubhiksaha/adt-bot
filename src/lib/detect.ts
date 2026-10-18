import { listModels } from "./llm";
import { PROVIDER_PRESETS, type ProviderPreset } from "./providers";
import { detectEnv } from "./transport";
import type { ModelInfo } from "./types";

export type FoundServer = { preset: ProviderPreset; models: ModelInfo[] };

/**
 * Looks for local AI servers (Ollama, LM Studio, llama.cpp, Jan…) on this computer.
 * Needs the desktop app or the self-hosted relay; a static web page can't see localhost.
 */
export async function detectLocalServers(useProxy: boolean): Promise<FoundServer[]> {
  const env = await detectEnv();
  if (env.platform === "android" || env.platform === "ios") return [];
  const seen = new Set<string>();
  const candidates = PROVIDER_PRESETS.filter((p) => p.group === "local" && !seen.has(p.baseUrl) && seen.add(p.baseUrl));
  const results = await Promise.all(
    candidates.map(async (preset) => {
      try {
        const models = await listModels(
          { id: preset.id, presetId: preset.id, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, apiKey: "", models: [] },
          useProxy,
          AbortSignal.timeout(2500),
        );
        return { preset, models };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is FoundServer => r !== null);
}
