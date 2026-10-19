import type { CustomVoice } from "./custom-tts";
import type { VisualizationSpec } from "./agent/vendor/openbot/visualization";
/** Wire protocol a provider speaks. Almost everything (including local servers) is "openai". */
/** "cli" = a coding agent CLI on this computer (desktop app), see src/lib/cli-agents. */
export type ProviderKind = "openai" | "anthropic" | "gemini" | "cli";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** A provider connection the user configured: preset defaults plus their key and overrides. */
export type ProviderConfig = {
  id: string;
  presetId: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** Models discovered from the provider's /models endpoint (or the bundled catalog). */
  models: ModelInfo[];
  /** Extra request headers, e.g. for a private server behind a login. */
  headers?: Record<string, string>;
};

export type ModelInfo = {
  id: string;
  name?: string;
  vision?: boolean;
  reasoning?: boolean;
  context?: number | null;
};

/** A document the bots can draw on. Its text lives in IndexedDB, keyed by id. */
export type KnowledgeRef = { id: string; name: string; size: number; chars: number; addedAt: number };

export type Bot = {
  id: string;
  name: string;
  /** What you call it out loud; also its wake word ("Hey Jarvis"). */
  nickname?: string;
  /** Files only this bot uses (product docs, its instructions…). */
  knowledge?: KnowledgeRef[];
  /** Tool groups this bot may use ("all" = every available group). */
  toolGroups?: string[] | "all";
  avatar: string;
  description: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  temperature: number | null;
  thinking: ThinkingLevel;
  /** Durable facts the bot carries into every conversation. */
  memory: string[];
  /** Let the bot save new memories by emitting <remember> tags. */
  autoMemory: boolean;
  createdAt: number;
};

/** One tool the bot used while answering, as shown in the chat and recorded in the activity log. */
export type ToolCallRecord = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "awaiting" | "denied" | "running" | "done" | "error";
  /** What the tool reported back (trimmed for storage). */
  result?: string;
  /** Rich output for the chat: an image/screenshot, terminal output, or a chart. */
  display?: ToolDisplay;
  /** Present while waiting for the user's decision. */
  approval?: { summary: string; detail: string; reason: string; kind: string; allowAlways: boolean };
  startedAt?: number;
  ms?: number;
};

export type ToolDisplay =
  | { kind: "image"; src: string; caption?: string }
  | { kind: "terminal"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "visualization"; spec: VisualizationSpec }
  /** A link to another chat (e.g. the one a delegated bot worked in). */
  | { kind: "conversation"; conversationId: string; label: string; text?: string };

/** Agent settings: tools and the approval gate. */
export type AgentSettings = {
  /** Let bots use tools (search, files, computers…). */
  enabled: boolean;
  approvalPolicy: "ask-every-time" | "ask-first-time" | "allowlist" | "auto-run";
  /** Patterns that never need approval (e.g. "git status", "tool:web_search"). */
  allowlist: string[];
  /** Patterns that are always refused, whatever the policy. */
  denylist: string[];
  /** Safety cap on tool steps per answer. */
  maxSteps: number;
  /** How tools are offered: native tool calling, a text protocol for models without it, or automatic. */
  mode: "auto" | "native" | "prompted";
};

export type Attachment =
  | { kind: "image"; dataUrl: string; name: string }
  | { kind: "file"; name: string; text: string; size: number; truncated?: boolean };

export type Source = { title: string; url: string; snippet: string; content?: string };

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  /** Web pages used for this answer, cited as [1], [2]… */
  sources?: Source[];
  /** Knowledge files that were consulted for this answer. */
  knowledge?: string[];
  /** Tools used while producing this answer, in order. */
  toolCalls?: ToolCallRecord[];
  model?: string;
  error?: string;
  /** Transient progress line, e.g. "Searching the web…". */
  status?: string;
  /** Total time and time to first token, in milliseconds. */
  stats?: { ms: number; firstMs?: number };
  createdAt: number;
};

export type Conversation = {
  id: string;
  botId: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  /** Private chat: never written to storage and gone when you leave it. */
  temporary?: boolean;
  titled?: boolean;
};

/**
 * Speech recognition engine. "auto" picks per platform: the phone's or browser's own recognizer when
 * it exists, otherwise cloud Whisper (if set up), otherwise Whisper running inside the app.
 */
export type SttEngine = "auto" | "device" | "whisper-local" | "whisper-cloud";

export type TtsEngine = "system" | "openai" | "elevenlabs" | CloudTts | `custom:${string}`;
/** Natural-voice services that only need an API key. */
export type CloudTts = "fish" | "cartesia" | "deepgram";

export type VoiceSettings = {
  engine: SttEngine;
  /** Cloud Whisper: provider + model (OpenAI, Groq, LocalAI, speaches…). */
  providerId: string;
  model: string;
  /** In-app Whisper size. */
  localModel: "tiny" | "base" | "small";
  /** Spoken replies: device voice name ("" = best available) and speed. */
  voiceName: string;
  rate: number;
  /** Reply voice engine: device voices, any OpenAI-compatible /audio/speech server, or ElevenLabs. */
  tts: TtsEngine;
  ttsProviderId: string;
  ttsModel: string;
  ttsVoice: string;
  elevenKey: string;
  elevenVoiceId: string;
  elevenModel: string;
  /** Keys and voices for Fish Audio, Cartesia and Deepgram. */
  cloudTts: Record<CloudTts, { key: string; voice: string; model: string }>;
  /** Voice services the user added (any HTTP text-to-speech API). Selected as tts = "custom:<id>". */
  customVoices: CustomVoice[];
  /** How long a pause ends your turn. */
  endSilence: "fast" | "normal" | "patient";
  /** Interrupt the bot by talking. "auto" = instantly with natural voices, after a short check with device voices. */
  bargeIn: "auto" | "on" | "off";
  /** Short, spoken-style answers in voice mode. */
  concise: boolean;
  /** Optional faster model just for voice conversations ("" = the bot's own model). */
  voiceProviderId: string;
  voiceModel: string;
  /** In voice mode, go to standby after a quiet spell and wake on "Hey <nickname>". */
  wakeWord: boolean;
  /** Listen for the wake word whenever the app is open (opt-in, shows an indicator). */
  handsFree: boolean;
};

export type ThemeConfig = {
  /** Preset id, or "custom". */
  preset: string;
  /** Brand colour used for buttons, links, highlights. */
  accent: string;
  /** Optional page colour (""= neutral). Light or dark mode is derived from it. */
  background: string;
  font: string;
  /** Corner roundness in px. */
  radius: number;
};

export type Brand = {
  /** App name shown in the sidebar, welcome screen and window title. */
  name: string;
  /** Logo image as a data URL ("" = default ADT logo). */
  logo: string;
  /** Use the logo as the main bot's avatar. */
  logoAsAvatar: boolean;
  theme: ThemeConfig;
};

export type SearchEngine = "duckduckgo" | "brave" | "tavily" | "searxng";

export type Settings = {
  theme: "system" | "dark" | "light";
  agent: AgentSettings;
  brand: Brand;
  /** What the bots should call you. */
  userName: string;
  /** Who you are, what your team or company does, what the bots are for. */
  about: string;
  /** Files every bot can draw on (company profile, handbook, product docs…). */
  knowledge: KnowledgeRef[];
  sendOnEnter: boolean;
  /** Route requests through the bundled relay when one is available (desktop, self-hosted web). */
  useProxy: boolean;
  /** Applies to every bot: who you are and how you like answers. */
  customInstructions: string;
  /** Name chats from their first exchange using the chat's own model. */
  smartTitles: boolean;
  /** Read every reply aloud when it finishes. */
  autoSpeak: boolean;
  search: { engine: SearchEngine; apiKey: string; url: string; readPages: boolean; native: boolean };
  /** Provider + model used for "Imagine". Empty = pick automatically. */
  image: { providerId: string; model: string };
  voice: VoiceSettings;
  /** Composer toggles, remembered between messages. */
  modes: { search: boolean; think: boolean };
  /** Recently used "providerId::model" keys, newest first. */
  recentModels: string[];
};
