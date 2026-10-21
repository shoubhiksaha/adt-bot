// @vitest-environment node
// Sync: newest change wins per record, deletions stick, API keys stay on their device, big pictures
// stay home, the server only sees ciphertext, and two devices end up with the same bots and chats.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Conversation, ProviderConfig } from "./types";

vi.mock("./transport", () => ({ providerFetch: (url: string, init: RequestInit) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));

const { mergeRecords, mergeSnapshots, mergeTombstones, newSyncCode, normaliseCode, seal, slimConversation, syncCodeProblem, syncKeys, unseal } = await import("./sync");
const { defaultSettings, deleteConversation, updateBot, useStore } = await import("./store");
const { syncNow, resetSync, useSyncStatus } = await import("../features/sync/engine");

const bot = (id: string, name: string, updatedAt = 1): Bot => ({ id, name, avatar: "", description: "", systemPrompt: "", providerId: "p", model: "m", temperature: null, thinking: "off", memory: [], autoMemory: false, createdAt: 0, updatedAt });
const chat = (id: string, text: string, rev = 1): Conversation => ({ id, botId: "a", title: text, messages: [{ id: `${id}-m`, role: "user", content: text, createdAt: 0 }], updatedAt: 0, rev });
const empty = { v: 1 as const, at: 0, device: "x", providers: [], bots: [], conversations: [], skills: [], profile: { userName: "", about: "", customInstructions: "", sharedMemory: [], updatedAt: 0 }, tombstones: {} };

describe("merging", () => {
  it("keeps the newest version of each record and drops what was deleted after its last change", () => {
    expect(mergeRecords([bot("a", "old", 1), bot("b", "B", 1)], [bot("a", "new", 5), bot("c", "C", 1)], {}).map((b) => b.name)).toEqual(["new", "B", "C"]);
    // Deleted at 3, last changed at 1: gone. Changed again at 9 (after the deletion): back.
    expect(mergeRecords([bot("a", "A", 1)], [], { a: 3 })).toEqual([]);
    expect(mergeRecords([bot("a", "A", 9)], [], { a: 3 }).map((b) => b.name)).toEqual(["A"]);
    const now = Date.UTC(2026, 9, 21);
    expect(mergeTombstones({ a: now - 1000, old: now - 100 * 86_400_000 }, { a: now - 5000, b: now }, now)).toEqual({ a: now - 1000, b: now });
  });

  it("keeps this device's API keys and takes the newer profile", () => {
    const mine: ProviderConfig = { id: "p", presetId: "openai", name: "OpenAI", kind: "openai", baseUrl: "", apiKey: "sk-mine", models: [], updatedAt: 1 };
    const merged = mergeSnapshots(
      { ...empty, providers: [mine], profile: { ...empty.profile, userName: "Old", updatedAt: 1 } },
      { ...empty, providers: [{ ...mine, apiKey: "", name: "OpenAI (renamed)", updatedAt: 9 }], profile: { ...empty.profile, userName: "Shoubhik", updatedAt: 5 } },
    );
    expect(merged.providers[0]).toMatchObject({ name: "OpenAI (renamed)", apiKey: "sk-mine" });
    expect(merged.profile.userName).toBe("Shoubhik");
  });

  it("leaves big pictures on their device", () => {
    const big = `data:image/png;base64,${"A".repeat(700_000)}`;
    const c: Conversation = { ...chat("c", "pic"), messages: [{ id: "m", role: "user", content: "look", createdAt: 0, attachments: [{ kind: "image", dataUrl: big, name: "big.png" }, { kind: "image", dataUrl: "data:image/png;base64,AAAA", name: "small.png" }] }] };
    const slim = slimConversation(c);
    expect(slim.messages[0].attachments).toEqual([{ kind: "file", name: "big.png", text: "(A large picture: it's on the device it was added on.)", size: 0 }, c.messages[0].attachments![1]]);
    expect(slimConversation(chat("d", "x"))).toEqual(chat("d", "x"));
  });
});

describe("codes and encryption", () => {
  it("makes long codes and reads them however they're typed", () => {
    const code = newSyncCode();
    expect(code).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    expect(normaliseCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(code.replace(/-/g, ""));
    expect(syncCodeProblem("short")).toMatch(/too short/);
    expect(syncCodeProblem(code)).toBe("");
  });

  it("derives the same vault from the same code, and the server sees only ciphertext", async () => {
    const [a, b, other] = await Promise.all([syncKeys("ABCDE-FGHJK-LMNPQ-RSTUV", 1000), syncKeys("abcde fghjk lmnpq rstuv", 1000), syncKeys("ZZZZZ-FGHJK-LMNPQ-RSTUV", 1000)]);
    expect(a.vault).toBe(b.vault);
    expect(a.token).toBe(b.token);
    expect(other.vault).not.toBe(a.vault);
    expect(a.vault).toMatch(/^[0-9a-f]{32}$/);
    const snapshot = { ...empty, bots: [bot("a", "Secret Agent")] };
    const body = await seal(snapshot, a);
    expect(body).not.toMatch(/Secret Agent/);
    expect((await unseal(body, b)).bots[0].name).toBe("Secret Agent");
    await expect(unseal(body, other)).rejects.toThrow(/can't be opened with this code/);
  });
});

describe("two devices", () => {
  let server: Server;
  let base = "";
  const vaults = new Map<string, { body: string; etag: string; token: string }>();
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const vault = req.url!.split("/").pop()!;
        const token = String(req.headers["x-adtbot-sync-token"] ?? "");
        const saved = vaults.get(vault);
        if (saved && saved.token !== token) return res.writeHead(403).end('{"error":"wrong token"}');
        if (req.method === "GET") {
          if (!saved) return res.writeHead(404).end("{}");
          if (req.headers["if-none-match"] === saved.etag) return res.writeHead(304).end();
          return res.writeHead(200, { etag: saved.etag }).end(saved.body);
        }
        const ifMatch = String(req.headers["if-match"] ?? "");
        if ((saved && ifMatch !== saved.etag) || (!saved && ifMatch !== "none")) return res.writeHead(412).end("{}");
        const etag = `"${Date.now()}-${Math.random()}"`;
        vaults.set(vault, { body: raw, etag, token });
        res.writeHead(200, { etag }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const device = (name: string, bots: Bot[], conversations: Conversation[], apiKey: string) => ({
    providers: [{ id: "p", presetId: "openai", name: "OpenAI", kind: "openai" as const, baseUrl: "", apiKey, models: [], updatedAt: 1 }],
    bots,
    conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
    skills: [],
    tombstones: {},
    profileUpdatedAt: 0,
    streamingId: null,
    activeConversationId: null,
    activeBotId: bots[0]?.id ?? null,
    settings: { ...defaultSettings, useProxy: false, sync: { enabled: true, server: base, code: "ABCDEFGHJKLMNPQRSTUV", keys: false, device: name } },
  });
  let mac: ReturnType<typeof device>;
  let phone: ReturnType<typeof device>;
  const use = async (state: ReturnType<typeof device>) => {
    useStore.setState(state);
    resetSync();
  };
  const save = () => {
    const s = useStore.getState();
    return { ...device("", [], [], ""), providers: s.providers, bots: s.bots, conversations: s.conversations, skills: s.skills, tombstones: s.tombstones, profileUpdatedAt: s.profileUpdatedAt, settings: s.settings, activeBotId: s.activeBotId };
  };
  beforeEach(() => {
    vaults.clear();
    mac = device("Mac", [bot("a", "ADT"), bot("w", "Writer")], [chat("c1", "Trip plan"), chat("c2", "Old chat")], "sk-mac");
    phone = device("Phone", [bot("a", "ADT")], [chat("c3", "Phone question")], "");
  });

  it("ends with the same bots and chats on both, keys staying home, deletions sticking", async () => {
    await use(mac);
    await syncNow();
    expect(useSyncStatus.getState()).toMatchObject({ state: "ok" });
    expect(vaults.size).toBe(1);
    expect([...vaults.values()][0].body).not.toMatch(/Trip plan|sk-mac/);
    mac = save();

    await use(phone);
    await syncNow();
    let s = useStore.getState();
    expect(s.bots.map((b) => b.name).sort()).toEqual(["ADT", "Writer"]);
    expect(Object.keys(s.conversations).sort()).toEqual(["c1", "c2", "c3"]);
    expect(s.providers[0].apiKey).toBe("");
    // The phone renames a bot and deletes a chat.
    updateBot("w", { name: "Writing Coach" });
    deleteConversation("c2");
    await syncNow();
    phone = save();

    await use(mac);
    await syncNow();
    s = useStore.getState();
    expect(s.bots.find((b) => b.id === "w")?.name).toBe("Writing Coach");
    expect(Object.keys(s.conversations).sort()).toEqual(["c1", "c3"]);
    expect(s.providers[0].apiKey).toBe("sk-mac");
    // Nothing new: no upload.
    const before = [...vaults.values()][0].etag;
    await syncNow();
    expect([...vaults.values()][0].etag).toBe(before);
  });

  it("rejects a different code for the same vault", async () => {
    await use(mac);
    await syncNow();
    const [vault] = vaults.keys();
    vaults.get(vault)!.token = "someone-else";
    await syncNow().catch(() => undefined);
    resetSync();
    await syncNow();
    expect(useSyncStatus.getState()).toMatchObject({ state: "error", error: expect.stringMatching(/403/) });
  });
});
