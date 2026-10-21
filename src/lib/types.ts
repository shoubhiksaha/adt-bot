import type { CustomVoice } from "./custom-tts";
import type { SpeechModel } from "./speech-models";
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
  /** Last change (sync). */
  updatedAt?: number;
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
  /**
   * Learn from chats: save facts the user states (<remember> tags, the remember tool) and, after a
   * chat goes quiet, a note on what it was about plus lasting facts and preferences (src/lib/learning.ts).
   */
  autoMemory: boolean;
  /** Notes on past conversations, one per chat, recalled in later chats when relevant. */
  journal?: JournalEntry[];
  createdAt: number;
  /** Last change (sync). */
  updatedAt?: number;
};

/**
 * A skill: a reusable how-to (when to use it, the steps, checks, what to return, what needs an OK),
 * shared by the bots. Same shape as a SKILL.md file (name + description + instructions), so skills
 * move between ADT Bot and other agents that read that format.
 */
export type Skill = {
  id: string;
  /** Lowercase words joined by hyphens; typed as /name in the message box. */
  name: string;
  /** When to use it: bots decide from this. */
  description: string;
  /** The how-to itself (Markdown). */
  instructions: string;
  /** Bots that may use it ("all" = every bot). */
  bots: string[] | "all";
  source: "user" | "bot" | "imported" | "recorded";
  /**
   * Imported from a file, or written by a bot whose chat had read outside content: its steps count
   * as outside content when used, so Full access asks before commands and file changes.
   */
  outside?: boolean;
  createdAt: number;
  updatedAt: number;
};

/** A bot's note on one past conversation, so the topic can be picked up later. */
export type JournalEntry = {
  conversationId: string;
  title: string;
  summary: string;
  /** When the note was last written. */
  at: number;
  /** The chat had read outside content (web pages, connectors…), so recalling the note counts as outside content too. */
  outside?: boolean;
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
  | { kind: "conversation"; conversationId: string; label: string; text?: string }
  /** A video kept on this device (src/lib/video.ts). */
  | { kind: "video"; mediaId: string; mime: string; name: string };

/** Agent settings: tools and the approval gate. */
export type AgentSettings = {
  /** Let bots use tools (search, files, computers…). */
  enabled: boolean;
  approvalPolicy: "ask-every-time" | "ask-first-time" | "allowlist" | "auto-run";
  /** Patterns that never need approval (e.g. "git status", "tool:web_search"). */
  allowlist: string[];
  /** Patterns that are always refused, whatever the policy. */
  denylist: string[];
  /**
   * How much of this computer bots can reach. "sandbox": only the ADT Bot Workspace folder, with
   * commands confined by the OS. "restricted": everything, asking before changes (approval policy).
   * "full": everything, without asking (the deny list still applies).
   */
  access: "sandbox" | "restricted" | "full";
  /** Full access still confirms destructive actions (deleting, sudo, AppleScript, quitting apps). */
  confirmDestructive: boolean;
  /** Safety cap on tool steps per answer. */
  maxSteps: number;
  /** How tools are offered: native tool calling, a text protocol for models without it, or automatic. */
  mode: "auto" | "native" | "prompted";
};

export type Attachment =
  | { kind: "image"; dataUrl: string; name: string }
  | { kind: "file"; name: string; text: string; size: number; truncated?: boolean }
  /** A video kept on this device (in IndexedDB, by id): too big to live in the chat itself. */
  | { kind: "video"; mediaId: string; name: string; mime: string };

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
  /** Length of `content` when the latest tool step started: text before it narrated the work, text after it is the answer. */
  narrationEnd?: number;
  model?: string;
  error?: string;
  /** Transient progress line, e.g. "Searching the web…". */
  status?: string;
  /** Total time and time to first token, in milliseconds. */
  stats?: { ms: number; firstMs?: number };
  /** Claude's summary of the conversation up to this reply (server-side compaction), sent back on later turns. */
  compaction?: Record<string, unknown>;
  /** Group chats: the bot that wrote this reply. */
  botId?: string;
  /** Group chats: this reply sums up the discussion. */
  summary?: boolean;
  createdAt: number;
};

/**
 * A group chat's bots and how they take turns. "discuss": each answers in turn, building on the
 * others. "debate": they take opposite sides and challenge each other. "panel": each answers on its
 * own first, then they may react. `rounds` is how many times each bot speaks per message; the
 * summariser (any bot) sums up at the end.
 */
export type GroupSettings = { mode: "discuss" | "debate" | "panel"; rounds: number; summarizer?: string };

export type Conversation = {
  id: string;
  botId: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  /** Private chat: never written to storage and gone when you leave it. */
  temporary?: boolean;
  titled?: boolean;
  /** Started by the app rather than the user: a routine run, or a task one bot handed another. */
  origin?: "routine" | "task";
  /** The last message the bot has learned from (src/lib/learning.ts). */
  learnedThrough?: string;
  /** Group chat: its bots in speaking order (2–6; botId is the first). */
  members?: string[];
  group?: GroupSettings;
  /** Last change of any kind (sync; updatedAt only moves when a reply starts or ends). */
  rev?: number;
};

/**
 * Speech recognition engine. "auto" picks per platform: the phone's or browser's own recognizer when
 * it exists, otherwise cloud Whisper (if set up), otherwise Whisper running inside the app.
 */
export type SttEngine = "auto" | "device" | "whisper-local" | "whisper-cloud";

/**
 * Natural voices generated on this device (no key, works offline): "local" is Supertonic (English),
 * "supertonic3" is Supertonic 3 (31 languages), "kokoro" is Kokoro (more natural, slower to start
 * each sentence).
 */
export type TtsEngine = "system" | "local" | "supertonic3" | "kokoro" | "openai" | "elevenlabs" | CloudTts | `custom:${string}`;
/** Natural-voice services that only need an API key. */
export type CloudTts = "fish" | "cartesia" | "deepgram";

export type VoiceSettings = {
  engine: SttEngine;
  /** Cloud Whisper: provider + model (OpenAI, Groq, LocalAI, speaches…). */
  providerId: string;
  model: string;
  /** In-app speech model: a Whisper size, or Moonshine (English only; Whisper is used for other languages). */
  localModel: SpeechModel;
  /** Spoken replies: device voice name ("" = best available) and speed. */
  voiceName: string;
  rate: number;
  /** Reply voice engine: device voices, any OpenAI-compatible /audio/speech server, or ElevenLabs. */
  tts: TtsEngine;
  /** On-device natural voice (Supertonic, either version): F1–F5, M1–M5. */
  localVoice: string;
  /** On-device Kokoro voice, e.g. af_heart. */
  kokoroVoice: string;
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
  /**
   * Start answering during a pause that probably ends your turn, before it's certain (on-device
   * speech recognition). Nothing is shown, saved or run until the turn is over; dropped if you carry on.
   */
  earlyReply: boolean;
  /** Short, spoken-style answers in voice mode. */
  concise: boolean;
  /** Optional faster model just for voice conversations ("" = the bot's own model). */
  voiceProviderId: string;
  voiceModel: string;
  /** In voice mode, go to standby after a quiet spell and wake on "Hey <nickname>". */
  wakeWord: boolean;
  /** Listen for the wake word whenever the app is open (opt-in, shows an indicator). */
  handsFree: boolean;
  /**
   * Voice mode's conversation: the app's own (speech recognition, the bot's model, the reply voice
   * above), or Gemini Live (one model that hears and speaks; the bot's instructions and tools still apply).
   */
  conversation: "app" | "gemini-live";
  /** How voice mode looks: the glowing orb, an animated face that talks, or the bot's own picture. */
  look: "orb" | "face" | "picture";
  /** Gemini Live: the Google Gemini provider whose key it uses ("" = the first one with a key), model and voice. */
  liveProviderId: string;
  liveModel: string;
  liveVoice: string;
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
  /** Facts every bot knows about the user (Memory screen); each bot also has its own. */
  sharedMemory: string[];
  /** Sync between devices through your own ADT Bot server (src/lib/sync.ts). `code` is kept with the keys. */
  sync: { enabled: boolean; server: string; code: string; keys: boolean; device: string };
  /** Your always-on ADT Bot server (ADT_AGENT_TOKEN on the server), for routines that run there. `token` is kept with the keys. */
  server: { url: string; token: string };
  /** "Smarter memory search": also find memories and knowledge passages by meaning, with an on-device model. */
  semanticSearch: boolean;
  sendOnEnter: boolean;
  /** Route requests through the bundled relay when one is available (desktop, self-hosted web). */
  useProxy: boolean;
  /** Applies to every bot: who you are and how you like answers. */
  customInstructions: string;
  /** Name chats from their first exchange using the chat's own model. */
  smartTitles: boolean;
  /** Read the answer aloud when the question was dictated with the mic button (typed questions never are). */
  autoSpeak: boolean;
  search: { engine: SearchEngine; apiKey: string; url: string; readPages: boolean; native: boolean };
  /** Provider + model used for "Imagine". Empty = pick automatically. */
  image: { providerId: string; model: string };
  /** Provider + model used for /video. Empty = pick automatically (Google or xAI). */
  video: { providerId: string; model: string };
  voice: VoiceSettings;
  /** Composer toggles, remembered between messages. */
  modes: { search: boolean; think: boolean };
  /** Recently used "providerId::model" keys, newest first. */
  recentModels: string[];
};
