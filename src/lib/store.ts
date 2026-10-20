import { del, get, set } from "idb-keyval";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import brandDefaults from "../brand.json";
import { isSealed, openSecrets, sealSecrets } from "./backup-crypto";
import { BOT_PRESETS } from "./presets";
import { catalogModels, presetById } from "./providers";
import { appSecretsCodec, SecretKeeper, type SecretMap } from "./secrets";
import type { Bot, Conversation, ProviderConfig, Settings } from "./types";

export const uid = () => crypto.randomUUID();

const STORAGE_KEY = "adtbot-state";
const LEGACY_KEYS = ["grokbot-state"];

export type State = {
  providers: ProviderConfig[];
  bots: Bot[];
  conversations: Record<string, Conversation>;
  activeBotId: string | null;
  activeConversationId: string | null;
  settings: Settings;
  /** Conversation currently receiving a reply. Not persisted. */
  streamingId: string | null;
  hydrated: boolean;
};

type Persisted = Omit<State, "streamingId" | "hydrated">;

/** Keys and secret header values: in the OS keychain on desktop (src/lib/secrets.ts). */
const appKeeper = new SecretKeeper<Persisted>("app", appSecretsCodec<Persisted>());

/**
 * IndexedDB storage that writes at most every 700 ms. Streaming replies update the store ~30
 * times a second; serialising every chat (with images) that often made long chats janky.
 */
function createThrottledStorage(): PersistStorage<Persisted> & { flush: () => void } {
  let pending: StorageValue<Persisted> | null = null;
  let latest: StorageValue<Persisted> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const value = pending;
    pending = null;
    const state = appKeeper.forDisk(value.state);
    // Without IndexedDB (tests in Node, locked-down webviews) set() throws synchronously, inside a timer.
    try {
      void set(STORAGE_KEY, { ...value, state }).catch((error) => console.error("Could not save", error));
    } catch (error) {
      console.error("Could not save", error);
    }
  };

  // If the keychain stops taking keys, save again with them in place so nothing is lost.
  appKeeper.onFallback = () => {
    pending ??= latest;
    flush();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  }

  return {
    flush,
    getItem: async (name) => {
      let value = await get(name);
      for (const legacy of LEGACY_KEYS) value ??= await get(legacy);
      if (value == null) {
        await appKeeper.open();
        return null;
      }
      // Older versions stored a JSON string.
      const stored = (typeof value === "string" ? JSON.parse(value) : value) as StorageValue<Persisted>;
      const state = await appKeeper.load(stored.state, async (blanked) => {
        // Keys moved to the keychain: drop the plain copies, including any under older names.
        await set(STORAGE_KEY, { ...stored, state: blanked });
        for (const legacy of LEGACY_KEYS) await del(legacy);
      });
      return { ...stored, state };
    },
    setItem: (_name, value) => {
      pending = latest = value;
      timer ??= setTimeout(flush, 700);
    },
    removeItem: async (name) => {
      pending = latest = null;
      await del(name);
      for (const legacy of LEGACY_KEYS) await del(legacy);
      await appKeeper.clear();
    },
  };
}

const storage = createThrottledStorage();
export const flushStorage = storage.flush;

/** "Erase all data": the saved state and its keys in the keychain. */
export async function eraseAllData() {
  useStore.persist.clearStorage();
  await appKeeper.clear();
}

/** Build-time brand (see `npm run brand`); the app's own Appearance settings start from it. */
export const DEFAULT_THEME: Settings["brand"]["theme"] = { ...brandDefaults.theme };

export const defaultSettings: Settings = {
  theme: "system",
  agent: {
    enabled: true,
    approvalPolicy: "ask-first-time",
    access: "restricted",
    confirmDestructive: true,
    allowlist: [],
    denylist: ["rm -rf /", "sudo *", "mkfs*", ":(){*", "shutdown*", "reboot*"],
    maxSteps: 12,
    mode: "auto",
  },
  brand: { name: brandDefaults.name || "ADT Bot", logo: brandDefaults.logo || "", logoAsAvatar: Boolean(brandDefaults.logoAsAvatar), theme: DEFAULT_THEME },
  userName: "",
  about: "",
  knowledge: [],
  semanticSearch: false,
  sendOnEnter: true,
  useProxy: true,
  customInstructions: "",
  smartTitles: true,
  autoSpeak: false,
  search: { engine: "duckduckgo", apiKey: "", url: "", readPages: true, native: true },
  image: { providerId: "", model: "" },
  voice: {
    engine: "auto",
    providerId: "",
    model: "",
    localModel: "base",
    voiceName: "",
    rate: 1,
    tts: "system",
    localVoice: "F1",
    kokoroVoice: "af_heart",
    ttsProviderId: "",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "alloy",
    elevenKey: "",
    cloudTts: {
      fish: { key: "", voice: "", model: "s2.1-pro" },
      cartesia: { key: "", voice: "", model: "sonic-3.6" },
      deepgram: { key: "", voice: "", model: "aura-2-thalia-en" },
    },
    customVoices: [],
    elevenVoiceId: "",
    elevenModel: "eleven_flash_v2_5",
    endSilence: "normal",
    bargeIn: "auto",
    earlyReply: true,
    concise: true,
    voiceProviderId: "",
    voiceModel: "",
    wakeWord: true,
    handsFree: false,
    conversation: "app",
    liveProviderId: "",
    liveModel: "gemini-3.8-live",
    liveVoice: "Kore",
  },
  modes: { search: false, think: false },
  recentModels: [],
};

function makeBot(preset = BOT_PRESETS[0], providerId = "", model = ""): Bot {
  return {
    id: uid(),
    name: preset.name,
    avatar: preset.avatar,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    temperature: preset.temperature,
    providerId,
    model,
    thinking: "off",
    memory: [],
    autoMemory: true,
    nickname: "",
    knowledge: [],
    createdAt: Date.now(),
  };
}

export const useStore = create<State>()(
  persist(
    (): State => ({
      providers: [],
      bots: BOT_PRESETS.map((preset) => makeBot(preset)),
      conversations: {},
      activeBotId: null,
      activeConversationId: null,
      settings: defaultSettings,
      streamingId: null,
      hydrated: false,
    }),
    {
      name: STORAGE_KEY,
      version: 4,
      storage,
      // Private chats never touch the disk.
      partialize: ({ streamingId: _s, hydrated: _h, conversations, activeConversationId, ...rest }) => {
        const saved = Object.fromEntries(Object.entries(conversations).filter(([, c]) => !c.temporary));
        return {
          ...rest,
          conversations: saved,
          activeConversationId: activeConversationId && saved[activeConversationId] ? activeConversationId : null,
        };
      },
      migrate: (persisted, version) => {
        const state = persisted as Persisted;
        if (version < 2) {
          // The flagship persona used to be called "Grok".
          const adt = BOT_PRESETS[0];
          state.bots = (state.bots ?? []).map((bot) =>
            bot.name === "Grok" && bot.systemPrompt.startsWith("You are Grok")
              ? { ...bot, name: adt.name, avatar: adt.avatar, description: adt.description, systemPrompt: adt.systemPrompt }
              : bot,
          );
        }
        if (version < 3) {
          state.bots = (state.bots ?? []).map((bot) => ({ ...bot, nickname: bot.nickname ?? "", knowledge: bot.knowledge ?? [] }));
        }
        if (version < 4) {
          // The default look became the ADT brand. Only untouched old defaults move; custom themes stay.
          const theme = state.settings?.brand?.theme as Partial<Settings["brand"]["theme"]> | undefined;
          const untouched =
            !theme || (theme.preset === "adt" && theme.accent?.toLowerCase() === "#3b82f6" && !theme.background && (theme.font ?? "system") === "system");
          if (state.settings?.brand && untouched) state.settings.brand.theme = { ...DEFAULT_THEME };
        }
        return state;
      },
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Persisted>;
        const settings = { ...defaultSettings, ...saved.settings } as Settings;
        for (const key of ["search", "image", "voice", "modes", "brand", "agent"] as const) {
          settings[key] = { ...defaultSettings[key], ...saved.settings?.[key] } as never;
        }
        settings.brand.theme = { ...DEFAULT_THEME, ...saved.settings?.brand?.theme };
        const savedCloud = saved.settings?.voice?.cloudTts;
        settings.voice.cloudTts = Object.fromEntries(
          Object.entries(defaultSettings.voice.cloudTts).map(([id, d]) => [id, { ...d, ...savedCloud?.[id as keyof typeof savedCloud] }]),
        ) as Settings["voice"]["cloudTts"];
        return { ...current, ...saved, settings };
      },
      onRehydrateStorage: () => () => useStore.setState({ hydrated: true }),
    },
  ),
);

const setState = useStore.setState;
const getState = useStore.getState;

// Providers ---------------------------------------------------------------

export function addProvider(
  presetId: string,
  apiKey: string,
  baseUrl?: string,
  model?: string,
  headers?: Record<string, string>,
): ProviderConfig {
  const preset = presetById(presetId);
  if (!preset) throw new Error(`Unknown provider ${presetId}`);
  const provider: ProviderConfig = {
    id: uid(),
    presetId,
    name: preset.name,
    kind: preset.kind,
    baseUrl: (baseUrl || preset.baseUrl).trim(),
    apiKey: apiKey.trim(),
    models: [],
    headers,
  };
  const defaultModel = model?.trim() || preset.defaultModel || "";
  // Fill the model list from the bundled catalog unless the caller already fetched the live list.
  void catalogModels(presetId).then((models) => {
    if (!models.length) return;
    setState((s) => ({
      providers: s.providers.map((p) => (p.id === provider.id && p.models.length === 0 ? { ...p, models } : p)),
    }));
  });
  setState((s) => ({
    providers: [...s.providers, provider],
    // Bots without a working provider adopt the new one.
    bots: s.bots.map((bot) =>
      s.providers.some((p) => p.id === bot.providerId) ? bot : { ...bot, providerId: provider.id, model: defaultModel },
    ),
  }));
  return provider;
}

export function updateProvider(id: string, patch: Partial<ProviderConfig>) {
  setState((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

export function removeProvider(id: string) {
  setState((s) => ({ providers: s.providers.filter((p) => p.id !== id) }));
}

// Bots --------------------------------------------------------------------

export function createBot(presetIndex = 1): Bot {
  const { providers, bots } = getState();
  const fallback = bots.find((b) => providers.some((p) => p.id === b.providerId));
  const bot = makeBot(BOT_PRESETS[presetIndex], fallback?.providerId ?? providers[0]?.id ?? "", fallback?.model ?? "");
  bot.name = "New bot";
  setState((s) => ({ bots: [...s.bots, bot], activeBotId: bot.id, activeConversationId: null }));
  return bot;
}

export function updateBot(id: string, patch: Partial<Bot>) {
  setState((s) => ({ bots: s.bots.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
}

export function setBotModel(botId: string, providerId: string, model: string) {
  updateBot(botId, { providerId, model });
  const key = `${providerId}::${model}`;
  setState((s) => ({
    settings: { ...s.settings, recentModels: [key, ...s.settings.recentModels.filter((k) => k !== key)].slice(0, 6) },
  }));
}

export function deleteBot(id: string) {
  setState((s) => {
    const conversations = Object.fromEntries(Object.entries(s.conversations).filter(([, c]) => c.botId !== id));
    const bots = s.bots.filter((b) => b.id !== id);
    return { bots, conversations, activeBotId: bots[0]?.id ?? null, activeConversationId: null };
  });
}

export function addMemory(botId: string, facts: string[]) {
  const clean = facts.map((f) => f.trim()).filter(Boolean);
  if (!clean.length) return;
  setState((s) => ({
    bots: s.bots.map((b) =>
      b.id === botId ? { ...b, memory: [...b.memory, ...clean.filter((f) => !b.memory.includes(f))] } : b,
    ),
  }));
}

// Conversations -------------------------------------------------------------

/** Leaving a private chat discards it. */
function dropTemporary(s: State, keep?: string): Record<string, Conversation> {
  const current = s.activeConversationId ? s.conversations[s.activeConversationId] : undefined;
  if (!current?.temporary || current.id === keep) return s.conversations;
  const { [current.id]: _gone, ...rest } = s.conversations;
  return rest;
}

export function selectBot(botId: string) {
  setState((s) => ({ conversations: dropTemporary(s), activeBotId: botId, activeConversationId: null }));
}

export function openConversation(id: string) {
  setState((s) => {
    const conversation = s.conversations[id];
    if (!conversation) return {};
    return { conversations: dropTemporary(s, id), activeConversationId: id, activeBotId: conversation.botId };
  });
}

export function newConversation(botId: string, temporary = false): Conversation {
  const conversation: Conversation = {
    id: uid(),
    botId,
    title: temporary ? "Private chat" : "New chat",
    messages: [],
    updatedAt: Date.now(),
    temporary: temporary || undefined,
  };
  setState((s) => ({
    conversations: { ...dropTemporary(s), [conversation.id]: conversation },
    activeBotId: botId,
    activeConversationId: conversation.id,
  }));
  return conversation;
}

/** Back to the bot's empty state; the chat is created on the first message. */
export function startNewChat(botId: string) {
  setState((s) => ({ conversations: dropTemporary(s), activeBotId: botId, activeConversationId: null }));
}

export function updateConversation(id: string, update: (c: Conversation) => Conversation) {
  setState((s) => {
    const current = s.conversations[id];
    return current ? { conversations: { ...s.conversations, [id]: update(current) } } : {};
  });
}

export function renameConversation(id: string, title: string) {
  const clean = title.trim();
  if (clean) updateConversation(id, (c) => ({ ...c, title: clean, titled: true }));
}

export function deleteConversation(id: string) {
  setState((s) => {
    const { [id]: _removed, ...rest } = s.conversations;
    return { conversations: rest, activeConversationId: s.activeConversationId === id ? null : s.activeConversationId };
  });
}

export function updateSettings(patch: Partial<Settings>) {
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

// Backup ------------------------------------------------------------------

/** Settings without any key, token or secret header value. */
export function withoutSecrets(settings: Settings): Settings {
  return appSecretsCodec<{ settings: Settings }>().split({ settings }).value.settings;
}

/** Everything a backup holds, with keys and secret header values blanked, plus the keys taken out. */
function backupParts() {
  const { providers, bots, conversations, settings } = getState();
  const { value, secrets } = appSecretsCodec<{ providers: ProviderConfig[]; settings: Settings }>().split({ providers, settings });
  const body = {
    app: "adt-bot",
    version: 3,
    exportedAt: new Date().toISOString(),
    providers: value.providers,
    bots,
    conversations: Object.fromEntries(Object.entries(conversations).filter(([, c]) => !c.temporary)),
    settings: value.settings,
  };
  return { body, secrets };
}

/** A backup without any key (safe to keep anywhere). */
export function exportData(): string {
  return JSON.stringify(backupParts().body, null, 2);
}

/** A backup whose keys are sealed with a password: the file never holds them in plain text. */
export async function exportDataWithKeys(password: string): Promise<string> {
  const { body, secrets } = backupParts();
  return JSON.stringify({ ...body, version: 4, secrets: await sealSecrets(secrets, password) }, null, 2);
}

/** The backup has password-protected keys (made with "Export with keys"). */
export function backupHasSealedKeys(json: string): boolean {
  try {
    return isSealed(JSON.parse(json)?.secrets);
  } catch {
    return false;
  }
}

/** The backup with its keys put back, for importData(). A wrong password throws. */
export async function unlockBackup(json: string, password: string): Promise<string> {
  const data = JSON.parse(json);
  const secrets = await openSecrets<SecretMap>(data.secrets, password);
  const joined = appSecretsCodec<{ providers?: ProviderConfig[]; settings?: Settings }>().join({ providers: data.providers, settings: data.settings }, secrets ?? {});
  const { secrets: _sealed, ...rest } = data;
  return JSON.stringify({ ...rest, providers: joined.providers, settings: joined.settings });
}

/**
 * Providers in a backup that would send your chats somewhere new: a provider you already have whose
 * address changed, or a new one with a key or address filled in. Shown before importing.
 */
export function importChanges(json: string): string[] {
  const data = JSON.parse(json);
  const current = new Map(getState().providers.map((p) => [p.id, p]));
  const changes: string[] = [];
  for (const p of (data?.providers ?? []) as ProviderConfig[]) {
    const mine = current.get(p.id);
    if (mine && (mine.baseUrl ?? "") !== (p.baseUrl ?? "")) changes.push(`${p.name || p.id}: ${mine.baseUrl || "(default)"} → ${p.baseUrl || "(default)"}`);
    else if (mine && JSON.stringify(mine.headers ?? {}) !== JSON.stringify(p.headers ?? {})) changes.push(`${p.name || p.id}: different request headers`);
    else if (!mine && p.baseUrl) changes.push(`${p.name || p.id} (new): ${p.baseUrl}`);
  }
  return changes;
}

export function importData(json: string) {
  const data = JSON.parse(json);
  if (data?.app !== "adt-bot" && data?.app !== "grokbot") throw new Error("This file is not an ADT Bot backup.");
  // A backup file may come from someone else: it can't loosen what bots may do without asking.
  const { agent } = getState().settings;
  const imported = { ...defaultSettings, ...data.settings };
  setState({
    providers: data.providers ?? [],
    bots: data.bots ?? [],
    conversations: data.conversations ?? {},
    settings: {
      ...imported,
      // An imported file never changes what bots may do on this computer.
      agent: {
        ...defaultSettings.agent,
        ...imported.agent,
        approvalPolicy: agent.approvalPolicy,
        allowlist: agent.allowlist,
        denylist: agent.denylist,
        access: agent.access,
        confirmDestructive: agent.confirmDestructive,
      },
    },
    activeBotId: data.bots?.[0]?.id ?? null,
    activeConversationId: null,
  });
}

/** Markdown transcript of a chat, for copying or saving. */
export function conversationMarkdown(id: string): string {
  const { conversations, bots } = getState();
  const conversation = conversations[id];
  if (!conversation) return "";
  const bot = bots.find((b) => b.id === conversation.botId);
  const lines = [`# ${conversation.title}`, ""];
  for (const m of conversation.messages) {
    lines.push(`**${m.role === "user" ? "You" : (bot?.name ?? "Assistant")}:**`, "", m.content || m.error || "", "");
    if (m.sources?.length) {
      lines.push(...m.sources.map((s, i) => `[${i + 1}] [${s.title}](${s.url})`), "");
    }
  }
  return lines.join("\n");
}
