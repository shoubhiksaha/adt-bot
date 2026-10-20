// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConnectorConfig } from "./mcp/connectors";
import {
  appSecretsCodec,
  connectorSecretsCodec,
  keyStorageText,
  roomSecretsCodec,
  type SecretBridge,
  SecretKeeper,
  type SecretMap,
  summarizeKeyStorage,
  type VaultRead,
} from "./secrets";
import type { ProviderConfig, Settings } from "./types";

/** An in-memory stand-in for the desktop keychain store (adt:secrets:*). */
function fakeVault(options: { available?: boolean; locked?: string[]; failWrites?: boolean } = {}) {
  const stores: Record<string, SecretMap> = {};
  const calls: { op: string; namespace: string; value?: SecretMap }[] = [];
  const bridge: SecretBridge = {
    get: async (namespace): Promise<VaultRead> => {
      calls.push({ op: "get", namespace });
      if (options.locked?.includes(namespace)) return { available: options.available ?? true, value: null, error: "locked" };
      return { available: options.available ?? true, value: stores[namespace] ? { ...stores[namespace] } : null };
    },
    set: async (namespace, value) => {
      calls.push({ op: "set", namespace, value });
      if (options.failWrites || options.available === false) return { ok: false, error: "unavailable" };
      stores[namespace] = { ...value };
      return { ok: true };
    },
    clear: async (namespace) => {
      calls.push({ op: "clear", namespace });
      delete stores[namespace];
    },
  };
  return { bridge, stores, calls, writes: () => calls.filter((c) => c.op === "set") };
}

const provider = (id: string, apiKey: string, headers?: Record<string, string>): ProviderConfig => ({
  id,
  presetId: "openai",
  name: id,
  kind: "openai",
  baseUrl: "https://api.example",
  apiKey,
  models: [],
  ...(headers ? { headers } : {}),
});

const settings = {
  theme: "system",
  search: { engine: "brave", apiKey: "brave-1", url: "", readPages: true, native: true },
  voice: {
    elevenKey: "el-1",
    cloudTts: { fish: { key: "fish-1", voice: "v", model: "m" }, cartesia: { key: "", voice: "", model: "" }, deepgram: { key: "dg-1", voice: "", model: "" } },
    customVoices: [
      { id: "cv", name: "Sarvam", url: "https://x", headers: "api-subscription-key: {{key}}\nx-extra: raw-secret\ncontent-type: application/json", body: "", response: "audio", audioPath: "", key: "cv-key", voice: "", model: "" },
    ],
  },
} as unknown as Settings;

type App = { providers: ProviderConfig[]; settings: Settings; bots: unknown[] };
const app = (): App => ({
  providers: [provider("p1", "sk-1", { Authorization: "Basic abc", "CF-Access-Client-Id": "id-1" }), provider("p2", "")],
  settings,
  bots: [{ id: "b" }],
});
const SECRETS = ["sk-1", "Basic abc", "id-1", "brave-1", "el-1", "fish-1", "dg-1", "cv-key", "raw-secret"];

describe("secret codecs", () => {
  const codec = appSecretsCodec<App>();

  it("takes every key, token and secret header value out of the app state", () => {
    const { value, secrets } = codec.split(app());
    const text = JSON.stringify(value);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(Object.values(secrets).sort()).toEqual(
      ["sk-1", "Basic abc", "id-1", "brave-1", "el-1", "fish-1", "dg-1", "cv-key", "api-subscription-key: {{key}}\nx-extra: raw-secret\ncontent-type: application/json"].sort(),
    );
    // Header names and {{placeholders}} stay so the setup is still recognisable.
    expect(value.providers[0].headers).toEqual({ Authorization: "", "CF-Access-Client-Id": "" });
    expect(value.settings.voice.customVoices[0].headers).toContain("api-subscription-key: {{key}}");
    expect(value.bots).toEqual([{ id: "b" }]);
  });

  it("puts them back exactly", () => {
    const original = app();
    const { value, secrets } = codec.split(original);
    expect(codec.join(value, secrets)).toEqual(original);
  });

  it("copes with older, partial state", () => {
    const partial = { providers: [provider("p", "k")] } as unknown as App;
    const { value, secrets } = codec.split(partial);
    expect(codec.join(value, secrets)).toEqual(partial);
    const noVoice = { settings: { search: { apiKey: "s" } } } as unknown as App;
    expect(codec.split(noVoice).secrets).toEqual({ '["search","apiKey"]': "s" });
  });

  it("connectors: tokens, headers and environment values", () => {
    const servers = [
      { id: "c1", name: "GitHub", enabled: true, transport: "stdio", command: "npx", env: { GITHUB_TOKEN: "ghp_x", DEBUG: "1" }, disabledTools: [] },
      { id: "c2", name: "Remote", enabled: true, transport: "http", url: "https://mcp", token: "tok-2", headers: { "x-api-key": "hk" }, disabledTools: [] },
    ] as ConnectorConfig[];
    const { value, secrets } = connectorSecretsCodec.split(servers);
    expect(JSON.stringify(value)).not.toMatch(/ghp_x|tok-2|hk"/);
    expect(value[0].env).toEqual({ GITHUB_TOKEN: "", DEBUG: "" });
    expect(Object.keys(secrets)).toHaveLength(4);
    expect(connectorSecretsCodec.join(value, secrets)).toEqual(servers);
  });

  it("rooms: PINs", () => {
    const codecRooms = roomSecretsCodec<{ configs: { id: string; pin: string }[]; selectedId: string | null }>();
    const rooms = { configs: [{ id: "r1", pin: "123456" }], selectedId: "r1" };
    const { value, secrets } = codecRooms.split(rooms);
    expect(value.configs[0].pin).toBe("");
    expect(codecRooms.join(value, secrets)).toEqual(rooms);
  });
});

describe("SecretKeeper", () => {
  const codec = appSecretsCodec<App>();

  it("moves plain keys from older versions into the keychain, then stores the state without them", async () => {
    const vault = fakeVault();
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    const rewrite = vi.fn();
    const loaded = await keeper.load(app(), rewrite);
    expect(keeper.mode).toBe("vault");
    expect(loaded).toEqual(app());
    expect(Object.values(vault.stores.app)).toContain("sk-1");
    expect(rewrite).toHaveBeenCalledTimes(1);
    const rewritten = JSON.stringify(rewrite.mock.calls[0][0]);
    for (const secret of SECRETS) expect(rewritten).not.toContain(secret);
  });

  it("reads keys back on the next launch without rewriting anything", async () => {
    const vault = fakeVault();
    await new SecretKeeper("app", codec, vault.bridge).load(app(), () => undefined);
    const blanked = codec.split(app()).value;
    const rewrite = vi.fn();
    const next = new SecretKeeper("app", codec, vault.bridge);
    expect(await next.load(blanked, rewrite)).toEqual(app());
    expect(rewrite).not.toHaveBeenCalled();
    expect(vault.writes()).toHaveLength(1);
  });

  it("writes to disk without keys, and to the keychain only when keys change", async () => {
    const vault = fakeVault();
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    await keeper.load(codec.split(app()).value, () => undefined);
    const disk = keeper.forDisk(app());
    for (const secret of SECRETS) expect(JSON.stringify(disk)).not.toContain(secret);
    await Promise.resolve();
    const before = vault.writes().length;
    keeper.forDisk({ ...app(), bots: [{ id: "b" }, { id: "c" }] });
    keeper.forDisk(app());
    await new Promise((r) => setTimeout(r, 0));
    expect(vault.writes()).toHaveLength(before);
    const changed = app();
    changed.providers[0] = { ...changed.providers[0], apiKey: "sk-new" };
    keeper.forDisk(changed);
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.values(vault.stores.app)).toContain("sk-new");
    expect(Object.values(vault.stores.app)).not.toContain("sk-1");
  });

  it("removing a key removes it from the keychain", async () => {
    const vault = fakeVault();
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    await keeper.load(app(), () => undefined);
    const cleared = app();
    cleared.providers = [];
    keeper.forDisk(cleared);
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.values(vault.stores.app)).not.toContain("sk-1");
  });

  it("without a keyring (Linux), keeps working as before and says so", async () => {
    const vault = fakeVault({ available: false });
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    const rewrite = vi.fn();
    expect(await keeper.load(app(), rewrite)).toEqual(app());
    expect(keeper.mode).toBe("plain");
    expect(keeper.forDisk(app())).toEqual(app());
    expect(rewrite).not.toHaveBeenCalled();
    expect(vault.writes()).toHaveLength(0);
  });

  it("never overwrites keys it can't unlock", async () => {
    const vault = fakeVault({ locked: ["app"] });
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    const blanked = codec.split(app()).value;
    expect(await keeper.load(blanked, () => undefined)).toEqual(blanked);
    expect(keeper.mode).toBe("locked");
    // A key typed meanwhile is kept (in the app's storage) rather than lost.
    const typed = { ...blanked, providers: [provider("p1", "sk-typed")] };
    expect(keeper.forDisk(typed)).toEqual(typed);
    expect(vault.writes()).toHaveLength(0);
  });

  it("falls back to saving keys in place when the keychain stops taking them", async () => {
    const vault = fakeVault();
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    await keeper.load(codec.split(app()).value, () => undefined);
    const fallback = vi.fn();
    keeper.onFallback = fallback;
    vault.bridge.set = async () => ({ ok: false, error: "unavailable" });
    const changed = { ...app(), providers: [provider("p1", "sk-later")] };
    keeper.forDisk(changed);
    await new Promise((r) => setTimeout(r, 0));
    expect(keeper.mode).toBe("failed");
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(keeper.forDisk(changed)).toEqual(changed);
  });

  it("does nothing special on web and mobile", async () => {
    const keeper = new SecretKeeper("app", codec, null);
    expect(await keeper.load(app(), () => undefined)).toEqual(app());
    expect(keeper.mode).toBe("none");
    expect(keeper.forDisk(app())).toEqual(app());
  });

  it("a failed migration leaves the plain copy alone", async () => {
    const vault = fakeVault({ failWrites: true });
    const keeper = new SecretKeeper("app", codec, vault.bridge);
    const rewrite = vi.fn();
    expect(await keeper.load(app(), rewrite)).toEqual(app());
    expect(rewrite).not.toHaveBeenCalled();
    expect(keeper.mode).toBe("failed");
  });
});

describe("key storage status", () => {
  it("summarizes every store", () => {
    expect(summarizeKeyStorage({})).toBe("pending");
    expect(summarizeKeyStorage({ app: "vault", rooms: "vault" })).toBe("keychain");
    expect(summarizeKeyStorage({ app: "vault", rooms: "pending" })).toBe("pending");
    expect(summarizeKeyStorage({ app: "plain" })).toBe("unencrypted");
    expect(summarizeKeyStorage({ app: "vault", connectors: "failed" })).toBe("unencrypted");
    expect(summarizeKeyStorage({ app: "locked", rooms: "plain" })).toBe("locked");
    expect(summarizeKeyStorage({ app: "none", rooms: "none" })).toBe("device");
    expect(keyStorageText("unencrypted")).toMatch(/GNOME Keyring or KWallet/);
    expect(keyStorageText("pending")).toBe("");
  });
});
