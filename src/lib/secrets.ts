// Secrets the app keeps: provider API keys and header values, search and voice keys, connector tokens,
// headers and environment values, room PINs. On desktop they're encrypted with the OS keychain by the
// main process (electron/secrets.cjs). The app's own storage (IndexedDB, localStorage) keeps everything
// else with the secrets blanked, and the window holds them only in memory while it runs. Web, Android
// and iOS have no keychain the app can use here, so there they stay in the app's storage on the device.
import { create } from "zustand";
import type { CustomVoice } from "./custom-tts";
import type { ConnectorConfig } from "./mcp/connectors";
import type { ProviderConfig, Settings } from "./types";

export type SecretMap = Record<string, string>;

/** Where one secret sits in a store, e.g. ["provider", id, "apiKey"]. */
const key = (...parts: string[]) => JSON.stringify(parts);

/** Key order doesn't matter when comparing two maps. */
const stable = (map: SecretMap) => JSON.stringify(Object.keys(map).sort().map((k) => [k, map[k]]));

export type SecretCodec<T> = {
  /** The value with every secret blanked, and the secrets that were taken out. */
  split(value: T): { value: T; secrets: SecretMap };
  /** Puts secrets back into a blanked value. */
  join(value: T, secrets: SecretMap): T;
};

// Bridge ------------------------------------------------------------------------------------------

export type VaultRead = { available: boolean; value: SecretMap | null; error?: "locked" };

export type SecretBridge = {
  get(namespace: string): Promise<VaultRead>;
  set(namespace: string, value: SecretMap): Promise<{ ok: boolean; error?: string }>;
  clear(namespace: string): Promise<unknown>;
};

type DesktopWindow = { adtbotDesktop?: { invoke?: (channel: string, payload?: unknown) => Promise<unknown> } };

/** The desktop app's keychain store (adt:secrets:*), or null on web and mobile. */
export function desktopSecretBridge(): SecretBridge | null {
  const invoke = typeof window !== "undefined" ? (window as unknown as DesktopWindow).adtbotDesktop?.invoke : undefined;
  if (!invoke) return null;
  return {
    get: (namespace) => invoke("adt:secrets:get", { namespace }) as Promise<VaultRead>,
    set: (namespace, value) => invoke("adt:secrets:set", { namespace, value }) as Promise<{ ok: boolean }>,
    clear: (namespace) => invoke("adt:secrets:clear", { namespace }),
  };
}

// Status for Settings -----------------------------------------------------------------------------

/**
 * none: no keychain on this platform (web, mobile). vault: encrypted by the OS keychain.
 * plain: desktop without a usable keyring. locked: saved secrets that can't be decrypted right now.
 * failed: the keychain stopped accepting them during this run.
 */
export type KeeperMode = "pending" | "none" | "vault" | "plain" | "locked" | "failed";

export const useKeyStorage = create<{ modes: Record<string, KeeperMode> }>(() => ({ modes: {} }));

export type KeyStorageSummary = "device" | "keychain" | "unencrypted" | "locked" | "pending";

export function summarizeKeyStorage(modes: Record<string, KeeperMode>): KeyStorageSummary {
  const all = Object.values(modes);
  if (!all.length || all.includes("pending")) return "pending";
  if (all.includes("locked")) return "locked";
  if (all.includes("plain") || all.includes("failed")) return "unencrypted";
  if (all.every((m) => m === "none")) return "device";
  return "keychain";
}

/** What Settings says about where keys are kept ("" while it's still being worked out). */
export function keyStorageText(summary: KeyStorageSummary): string {
  switch (summary) {
    case "keychain":
      return "API keys, tokens and PINs are encrypted with your system keychain and only decrypted while ADT Bot runs.";
    case "unencrypted":
      return "ADT Bot couldn't use a system keychain on this computer (on Linux: GNOME Keyring or KWallet), so keys are stored unencrypted in the app's data. Set one up and restart ADT Bot to encrypt them.";
    case "locked":
      return "Some saved keys couldn't be unlocked from your system keychain. They're still saved: unlock the keychain (or sign in again) and restart ADT Bot. Keys you enter meanwhile are stored unencrypted until then.";
    case "device":
      return "Keys are kept in this app's storage on this device only.";
    default:
      return "";
  }
}

// Keeper ------------------------------------------------------------------------------------------

/**
 * One store's secrets (e.g. "app" for providers and settings). The store passes what it reads through
 * load() and what it writes through forDisk(); the keeper moves the secrets to and from the keychain.
 */
export class SecretKeeper<T> {
  mode: KeeperMode = "pending";
  /** Called when the keychain stops taking writes: the store should save again, secrets included. */
  onFallback?: () => void;
  private opened?: Promise<SecretMap>;
  private saved = stable({});
  private chain: Promise<unknown> = Promise.resolve();
  readonly namespace: string;
  private readonly codec: SecretCodec<T>;
  private readonly bridge: SecretBridge | null;

  constructor(namespace: string, codec: SecretCodec<T>, bridge: SecretBridge | null = desktopSecretBridge()) {
    this.namespace = namespace;
    this.codec = codec;
    this.bridge = bridge;
  }

  private setMode(mode: KeeperMode) {
    this.mode = mode;
    useKeyStorage.setState((s) => ({ modes: { ...s.modes, [this.namespace]: mode } }));
  }

  /** Reads the keychain once. Never throws: anything unexpected means "keep working as before". */
  open(): Promise<SecretMap> {
    this.opened ??= (async () => {
      let mode: KeeperMode = "none";
      let map: SecretMap = {};
      try {
        const result = this.bridge ? await this.bridge.get(this.namespace) : null;
        // Saved earlier but unreadable now: leave them be (never overwrite) until the keyring is back.
        if (result?.error) mode = "locked";
        else if (result && !result.available) mode = "plain";
        else if (result) {
          map = result.value ?? {};
          this.saved = stable(map);
          mode = "vault";
        }
      } catch {
        mode = "none";
      }
      this.setMode(mode);
      return map;
    })();
    return this.opened;
  }

  /**
   * A stored value with its secrets put back. Secrets still stored in it in plain text (from older
   * versions) move to the keychain first, then `rewrite` stores the value without them.
   */
  async load(stored: T, rewrite: (blanked: T) => unknown): Promise<T> {
    const vault = await this.open();
    if (this.mode !== "vault") return stored;
    const { value: blanked, secrets: plain } = this.codec.split(stored);
    // A plain copy is newer than the keychain's (written after a failed save, or by an older version).
    const secrets = { ...vault, ...plain };
    if (Object.keys(plain).length) {
      if (!(await this.write(secrets))) return stored;
      try {
        await rewrite(blanked);
      } catch {
        // The plain copy stays until the next save or launch, which moves it again.
      }
    }
    return this.codec.join(blanked, secrets);
  }

  /** What to write to the app's own storage: with the keychain, the value without its secrets. */
  forDisk(value: T): T {
    if (this.mode !== "vault") return value;
    const { value: blanked, secrets } = this.codec.split(value);
    if (stable(secrets) !== this.saved) void this.write(secrets);
    return blanked;
  }

  /** Forgets this store's secrets in the keychain ("Erase all data"). */
  async clear() {
    this.saved = stable({});
    await this.chain;
    await this.bridge?.clear(this.namespace).catch(() => undefined);
  }

  private write(secrets: SecretMap): Promise<boolean> {
    const previous = this.saved;
    // Set before the round trip so the next save doesn't send the same map again.
    this.saved = stable(secrets);
    const run = this.chain.then(async () => {
      try {
        if ((await this.bridge?.set(this.namespace, secrets))?.ok) return true;
      } catch {
        // handled below
      }
      this.saved = previous;
      this.setMode("failed");
      this.onFallback?.();
      return false;
    });
    this.chain = run;
    return run;
  }
}

// Codecs ------------------------------------------------------------------------------------------

/** Takes every non-empty value out of a record (header values, environment values). */
function takeAll(record: Record<string, string> | undefined, path: string[], secrets: SecretMap) {
  if (!record) return record;
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      if (typeof value === "string" && value) secrets[key(...path, name)] = value;
      return [name, ""];
    }),
  );
}

function putAll(record: Record<string, string> | undefined, path: string[], secrets: SecretMap) {
  if (!record) return record;
  return Object.fromEntries(Object.entries(record).map(([name, value]) => [name, secrets[key(...path, name)] ?? value]));
}

function take<T extends object, K extends keyof T>(item: T, field: K, path: string[], secrets: SecretMap): T {
  const value = item[field];
  if (typeof value !== "string" || !value) return item;
  secrets[key(...path)] = value;
  return { ...item, [field]: "" };
}

function put<T extends object, K extends keyof T>(item: T, field: K, path: string[], secrets: SecretMap): T {
  const value = secrets[key(...path)];
  return value === undefined ? item : { ...item, [field]: value };
}

/** "Name: value" lines: values that aren't {{placeholders}} are blanked. */
export const blankHeaderLines = (text: string) =>
  text
    .split("\n")
    .map((line) => {
      const i = line.indexOf(":");
      return i > 0 && !line.includes("{{") ? `${line.slice(0, i)}: ` : line;
    })
    .join("\n");

type AppSecretsShape = { providers?: ProviderConfig[]; settings?: Settings };

function splitSettings(settings: Settings, secrets: SecretMap): Settings {
  const out = { ...settings };
  if (settings.search) out.search = take(settings.search, "apiKey", ["search", "apiKey"], secrets);
  if (settings.sync) out.sync = take(settings.sync, "code", ["sync", "code"], secrets);
  const voice = settings.voice;
  if (voice) {
    let next = take(voice, "elevenKey", ["voice", "elevenKey"], secrets);
    if (voice.cloudTts) {
      next = {
        ...next,
        cloudTts: Object.fromEntries(
          Object.entries(voice.cloudTts).map(([id, c]) => [id, c ? take(c, "key", ["voice", "cloudTts", id, "key"], secrets) : c]),
        ) as Settings["voice"]["cloudTts"],
      };
    }
    if (Array.isArray(voice.customVoices)) {
      next = {
        ...next,
        customVoices: voice.customVoices.map((c: CustomVoice) => {
          let item = take(c, "key", ["voice", "custom", c.id, "key"], secrets);
          const headers = c.headers ?? "";
          const blank = blankHeaderLines(headers);
          if (blank !== headers) {
            secrets[key("voice", "custom", c.id, "headers")] = headers;
            item = { ...item, headers: blank };
          }
          return item;
        }),
      };
    }
    out.voice = next;
  }
  return out;
}

function joinSettings(settings: Settings, secrets: SecretMap): Settings {
  const out = { ...settings };
  if (settings.search) out.search = put(settings.search, "apiKey", ["search", "apiKey"], secrets);
  if (settings.sync) out.sync = put(settings.sync, "code", ["sync", "code"], secrets);
  const voice = settings.voice;
  if (voice) {
    let next = put(voice, "elevenKey", ["voice", "elevenKey"], secrets);
    if (voice.cloudTts) {
      next = {
        ...next,
        cloudTts: Object.fromEntries(
          Object.entries(voice.cloudTts).map(([id, c]) => [id, c ? put(c, "key", ["voice", "cloudTts", id, "key"], secrets) : c]),
        ) as Settings["voice"]["cloudTts"],
      };
    }
    if (Array.isArray(voice.customVoices)) {
      next = {
        ...next,
        customVoices: voice.customVoices.map((c: CustomVoice) =>
          put(put(c, "key", ["voice", "custom", c.id, "key"], secrets), "headers", ["voice", "custom", c.id, "headers"], secrets),
        ),
      };
    }
    out.voice = next;
  }
  return out;
}

/** Providers (keys, header values) and settings (search and voice keys). Used for the "app" store and backups. */
export function appSecretsCodec<T extends AppSecretsShape>(): SecretCodec<T> {
  return {
    split(state) {
      const secrets: SecretMap = {};
      const value = { ...state };
      if (Array.isArray(state.providers)) {
        value.providers = state.providers.map((p) => {
          const item = take(p, "apiKey", ["provider", p.id, "apiKey"], secrets);
          return p.headers ? { ...item, headers: takeAll(p.headers, ["provider", p.id, "header"], secrets) } : item;
        });
      }
      if (state.settings) value.settings = splitSettings(state.settings, secrets);
      return { value, secrets };
    },
    join(state, secrets) {
      const value = { ...state };
      if (Array.isArray(state.providers)) {
        value.providers = state.providers.map((p) => {
          const item = put(p, "apiKey", ["provider", p.id, "apiKey"], secrets);
          return p.headers ? { ...item, headers: putAll(p.headers, ["provider", p.id, "header"], secrets) } : item;
        });
      }
      if (state.settings) value.settings = joinSettings(state.settings, secrets);
      return value;
    },
  };
}

/** Connectors: tokens, header values and environment values (MCP servers often take API keys there). */
export const connectorSecretsCodec: SecretCodec<ConnectorConfig[]> = {
  split(servers) {
    const secrets: SecretMap = {};
    const value = (Array.isArray(servers) ? servers : []).map((server) => {
      const item = take(server, "token", ["connector", server.id, "token"], secrets);
      return {
        ...item,
        ...(server.headers ? { headers: takeAll(server.headers, ["connector", server.id, "header"], secrets) } : {}),
        ...(server.env ? { env: takeAll(server.env, ["connector", server.id, "env"], secrets) } : {}),
      };
    });
    return { value, secrets };
  },
  join(servers, secrets) {
    return (Array.isArray(servers) ? servers : []).map((server) => {
      const item = put(server, "token", ["connector", server.id, "token"], secrets);
      return {
        ...item,
        ...(server.headers ? { headers: putAll(server.headers, ["connector", server.id, "header"], secrets) } : {}),
        ...(server.env ? { env: putAll(server.env, ["connector", server.id, "env"], secrets) } : {}),
      };
    });
  },
};

type RoomsShape = { configs?: { id: string; pin: string }[] };

/** Room PINs. */
export function roomSecretsCodec<T extends RoomsShape>(): SecretCodec<T> {
  return {
    split(state) {
      const secrets: SecretMap = {};
      const configs = state.configs?.map((c) => take(c, "pin", ["room", c.id, "pin"], secrets));
      return { value: configs ? { ...state, configs } : state, secrets };
    },
    join(state, secrets) {
      const configs = state.configs?.map((c) => put(c, "pin", ["room", c.id, "pin"], secrets));
      return configs ? { ...state, configs } : state;
    },
  };
}
