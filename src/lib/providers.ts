import type { ModelInfo, ProviderKind } from "./types";

export type ProviderPreset = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Where to get a key. Empty for local servers. */
  keyUrl?: string;
  needsKey: boolean;
  /** Runs on hardware the user controls: pick the default model from what is installed. */
  local?: boolean;
  /** "cli" = coding agent CLIs run by the desktop app (hidden elsewhere). */
  group: "cloud" | "local" | "private" | "cli";
  defaultModel: string;
  note?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "xai",
    name: "xAI (Grok)",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    needsKey: true,
    defaultModel: "grok-4.7",
  },
  {
    id: "openai",
    name: "OpenAI",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
    defaultModel: "gpt-5.5",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    group: "cloud",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
    defaultModel: "claude-sonnet-5-5",
  },
  {
    id: "google",
    name: "Google Gemini",
    group: "cloud",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
    defaultModel: "gemini-3.8-flash",
  },
  {
    id: "openrouter",
    name: "OpenRouter (300+ models)",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
    defaultModel: "~x-ai/grok-latest",
    note: "Supports a web search toggle per bot.",
  },
  {
    id: "groq",
    name: "Groq",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
    defaultModel: "deepseek-flash",
  },
  {
    id: "mistral",
    name: "Mistral",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    needsKey: true,
    defaultModel: "mistral-medium-latest",
  },
  {
    id: "together",
    name: "Together AI",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    needsKey: true,
    defaultModel: "openai/gpt-oss-120b",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyUrl: "https://fireworks.ai/account/api-keys",
    needsKey: true,
    defaultModel: "accounts/fireworks/models/kimi-k3",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai",
    needsKey: true,
    defaultModel: "gpt-oss-120b",
  },
  {
    id: "perplexity",
    name: "Perplexity (built-in web search)",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    keyUrl: "https://www.perplexity.ai/settings/api",
    needsKey: true,
    defaultModel: "sonar-pro",
  },
  {
    id: "moonshotai",
    name: "Moonshot (Kimi)",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    keyUrl: "https://platform.moonshot.ai",
    needsKey: true,
    defaultModel: "kimi-k3",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyUrl: "https://build.nvidia.com",
    needsKey: true,
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    group: "cloud",
    kind: "openai",
    baseUrl: "https://router.huggingface.co/v1",
    keyUrl: "https://huggingface.co/settings/tokens",
    needsKey: true,
    defaultModel: "openai/gpt-oss-120b",
  },
  // Local LLM servers. All of them expose the OpenAI-compatible API, so no key is needed.
  {
    id: "ollama",
    name: "Ollama (local)",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    local: true,
    defaultModel: "llama3.2",
    note: "Run `ollama serve`, then `ollama pull <model>`. From a phone, use your computer's LAN IP and start Ollama with OLLAMA_HOST=0.0.0.0.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
    note: "Start the server from LM Studio's Developer tab. Enable CORS there for the browser version.",
  },
  {
    id: "llamacpp",
    name: "llama.cpp server (local)",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
    note: "Run `llama-server -m model.gguf`.",
  },
  {
    id: "vllm",
    name: "vLLM (local)",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
  },
  {
    id: "jan",
    name: "Jan (local)",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:1337/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
  },
  {
    id: "localai",
    name: "LocalAI",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
  },
  {
    id: "koboldcpp",
    name: "KoboldCpp",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:5001/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
  },
  {
    id: "gpt4all",
    name: "GPT4All",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:4891/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
    note: "Enable the local API server in GPT4All settings.",
  },
  {
    id: "textgen",
    name: "text-generation-webui",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:5000/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
    note: "Start it with the --api flag.",
  },
  {
    id: "llamafile",
    name: "llamafile",
    group: "local",
    kind: "openai",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
  },
  // Self-hosted servers on a LAN, VPN (Tailscale, WireGuard) or company network.
  {
    id: "private-openai",
    name: "Private server (OpenAI-compatible)",
    group: "private",
    kind: "openai",
    baseUrl: "",
    needsKey: false,
    local: true,
    defaultModel: "",
    note:
      "Any model server you host: Ollama, vLLM, LM Studio, llama.cpp, TGI, SGLang… on another machine. " +
      "Example: http://192.168.1.50:11434/v1 or https://llm.mycompany.internal/v1. Add the key or login headers your server expects.",
  },
  {
    id: "openwebui",
    name: "Open WebUI",
    group: "private",
    kind: "openai",
    baseUrl: "http://localhost:3000/api",
    needsKey: true,
    local: true,
    defaultModel: "",
    note: "Use an API key from Open WebUI → Settings → Account. Change the host if it runs on another machine.",
  },
  {
    id: "litellm",
    name: "LiteLLM proxy",
    group: "private",
    kind: "openai",
    baseUrl: "http://localhost:4000/v1",
    needsKey: false,
    local: true,
    defaultModel: "",
    note: "Use a LiteLLM virtual key if your proxy requires one.",
  },
  {
    id: "custom-openai",
    name: "Custom OpenAI-compatible",
    group: "private",
    kind: "openai",
    baseUrl: "",
    needsKey: false,
    defaultModel: "",
    note: "Any endpoint that speaks /v1/chat/completions: Azure, gateways, hosted inference, and more.",
  },
  {
    id: "custom-anthropic",
    name: "Custom Anthropic-compatible",
    group: "private",
    kind: "anthropic",
    baseUrl: "",
    needsKey: true,
    defaultModel: "",
  },
  ...(
    [
      ["claude", "Claude Code (local CLI)", "Uses your Claude Code login and its tools (default permissions), working in the ADT Bot Workspace folder."],
      ["codex", "Codex (local CLI)", "Uses your Codex CLI login, working in the ADT Bot Workspace folder."],
      ["gemini", "Gemini CLI (local)", "Uses your Gemini CLI login, working in the ADT Bot Workspace folder."],
      ["opencode", "OpenCode (local CLI)", "Uses the models configured in your OpenCode install."],
    ] as const
  ).map(
    ([agent, name, note]): ProviderPreset => ({
      id: `cli-${agent}`,
      name,
      group: "cli",
      kind: "cli",
      baseUrl: `cli:${agent}`,
      needsKey: false,
      local: true,
      defaultModel: "default",
      note: `${note} Desktop app only; each reply runs the command-line tool once.`,
    }),
  ),
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Bundled models for a preset, so the picker works before "Fetch" is pressed. Loaded on demand. */
export async function catalogModels(presetId: string): Promise<ModelInfo[]> {
  const { default: catalog } = await import("./catalog.json");
  return (catalog as Record<string, ModelInfo[]>)[presetId] ?? [];
}

/** Parses "Name: value" lines into request headers. */
export function parseHeaders(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (/^[\w-]+$/.test(name) && value) headers[name] = value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

export function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** Best guess for vision support when the provider's /models response does not say. */
export function guessVision(modelId: string): boolean {
  return /vision|vl\b|-vl|gpt-4o|gpt-[5-9]|claude|gemini|grok-[4-9]|llava|bakllava|minicpm-v|moondream|internvl|pixtral|gemma-?[34]|qwen.*vl|llama-?4|kimi-k[3-9]|mistral-(medium|small)/i.test(
    modelId,
  );
}
