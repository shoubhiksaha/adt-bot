// @vitest-environment node
// The app store on desktop: plain keys from older versions move to the keychain on first launch, saved
// state never holds them again, and backups never contain them in plain text.
import { describe, expect, it, vi } from "vitest";
import { backupPasswordProblem } from "./backup-crypto";

const idb = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (key: string) => structuredClone(idb.get(key)),
  set: async (key: string, value: unknown) => void idb.set(key, structuredClone(value)),
  del: async (key: string) => void idb.delete(key),
  keys: async () => [...idb.keys()],
  createStore: () => ({}),
}));
vi.mock("./transport", () => ({ providerFetch: fetch, detectEnv: async () => ({ platform: "desktop", proxy: true }) }));

// The desktop bridge, with the keychain store (adt:secrets:*) kept in memory.
const vault: Record<string, Record<string, string>> = {};
const invoke = vi.fn(async (channel: string, payload: { namespace: string; value?: Record<string, string> }) => {
  if (channel === "adt:secrets:get") return { available: true, value: vault[payload.namespace] ?? null };
  if (channel === "adt:secrets:set") {
    vault[payload.namespace] = { ...payload.value };
    return { ok: true };
  }
  if (channel === "adt:secrets:clear") {
    delete vault[payload.namespace];
    return { ok: true };
  }
  throw new Error(`unexpected ${channel}`);
});
vi.stubGlobal("window", { adtbotDesktop: { invoke, on: () => () => undefined }, addEventListener: () => undefined });
vi.stubGlobal("document", { addEventListener: () => undefined, visibilityState: "visible" });

// What version 1.1.0 left behind: keys in plain text, under the old storage name, as a JSON string.
idb.set(
  "grokbot-state",
  JSON.stringify({
    version: 4,
    state: {
      providers: [
        { id: "p1", presetId: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-legacy", models: [], headers: { "CF-Access-Client-Secret": "cf-legacy" } },
      ],
      bots: [],
      conversations: {},
      activeBotId: null,
      activeConversationId: null,
      settings: { search: { engine: "brave", apiKey: "brave-legacy" }, voice: { elevenKey: "el-legacy", cloudTts: { fish: { key: "fish-legacy" } } } },
    },
  }),
);
const LEGACY = ["sk-legacy", "cf-legacy", "brave-legacy", "el-legacy", "fish-legacy"];

const store = await import("./store");
const settle = () => new Promise((r) => setTimeout(r, 5));
for (let i = 0; i < 200 && !store.useStore.getState().hydrated; i++) await settle();

const saved = () => JSON.stringify(idb.get("adtbot-state") ?? null);

describe("keys in the keychain (desktop)", () => {
  it("migrates plain keys on first launch and removes the plain copies", () => {
    const { providers, settings } = store.useStore.getState();
    expect(providers[0].apiKey).toBe("sk-legacy");
    expect(providers[0].headers).toEqual({ "CF-Access-Client-Secret": "cf-legacy" });
    expect(settings.search.apiKey).toBe("brave-legacy");
    expect(settings.voice.elevenKey).toBe("el-legacy");
    expect(settings.voice.cloudTts.fish.key).toBe("fish-legacy");
    expect(Object.values(vault.app).sort()).toEqual([...LEGACY].sort());
    expect(idb.has("grokbot-state")).toBe(false);
    for (const secret of LEGACY) expect(saved()).not.toContain(secret);
    expect(saved()).toContain("CF-Access-Client-Secret");
  });

  it("saves new keys to the keychain only", async () => {
    store.updateProvider("p1", { apiKey: "sk-new" });
    store.flushStorage();
    await settle();
    expect(Object.values(vault.app)).toContain("sk-new");
    expect(Object.values(vault.app)).not.toContain("sk-legacy");
    expect(saved()).not.toContain("sk-new");
  });
});

describe("backups", () => {
  it("an export without keys has none", () => {
    const json = store.exportData();
    for (const secret of ["sk-new", ...LEGACY]) expect(json).not.toContain(secret);
    expect(store.backupHasSealedKeys(json)).toBe(false);
  });

  it("an export with keys seals them with a password", async () => {
    const json = await store.exportDataWithKeys("correct horse battery");
    for (const secret of ["sk-new", ...LEGACY]) expect(json).not.toContain(secret);
    expect(store.backupHasSealedKeys(json)).toBe(true);
    await expect(store.unlockBackup(json, "wrong password")).rejects.toThrow(/Wrong password/);

    store.updateProvider("p1", { apiKey: "" });
    store.importData(await store.unlockBackup(json, "correct horse battery"));
    const { providers, settings } = store.useStore.getState();
    expect(providers[0].apiKey).toBe("sk-new");
    expect(providers[0].headers).toEqual({ "CF-Access-Client-Secret": "cf-legacy" });
    expect(settings.voice.cloudTts.fish.key).toBe("fish-legacy");
  });

  it("a changed file doesn't open", async () => {
    const data = JSON.parse(await store.exportDataWithKeys("correct horse battery"));
    data.secrets.data = data.secrets.data.replace(/^./, (c: string) => (c === "A" ? "B" : "A"));
    await expect(store.unlockBackup(JSON.stringify(data), "correct horse battery")).rejects.toThrow(/Wrong password/);
  });

  it("asks for a usable password", () => {
    expect(backupPasswordProblem("", "")).toMatch(/Choose/);
    expect(backupPasswordProblem("short", "short")).toMatch(/8 characters/);
    expect(backupPasswordProblem("long enough", "long enougH")).toMatch(/don't match/);
    expect(backupPasswordProblem("long enough", "long enough")).toBe("");
  });

  it("erasing all data forgets the keys too", async () => {
    await store.eraseAllData();
    await settle();
    expect(vault.app).toBeUndefined();
    expect(idb.has("adtbot-state")).toBe(false);
  });
});
