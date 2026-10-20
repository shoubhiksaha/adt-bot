// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "./chat";
import { fuse, getSemantic, hybridRank, type Semantic, setSemantic } from "./hybrid";
import { chunk, knowledgeContext, knowledgeSource, rank, saveKnowledgeText, tokenize } from "./knowledge";
import { memoryContext, memoryIsLarge, memorySource, searchMemory, splitMemory } from "./memory-recall";
import { createSemantic, indexSources, syncIndex } from "./semantic";
import type { Bot } from "./types";
import { type Embedder, memoryVectorStore, textHash, VectorIndex } from "./vector-index";

/**
 * A stand-in for the embedding model: words map to "concepts" (so "sister" and "sibling" mean the
 * same thing, in any language listed), and a text's vector is its bag of concepts, unit length.
 * Words it doesn't know carry no meaning.
 */
const CONCEPTS: Record<string, string> = {
  sister: "sibling",
  sibling: "sibling",
  brother: "sibling",
  बहन: "sibling",
  coffee: "drink",
  tea: "drink",
  allergic: "allergy",
  allergies: "allergy",
  peanuts: "peanut",
  refunded: "money-back",
  "money back": "money-back",
};
const DIMS = 16;

function conceptEmbedder(model = "mock-1"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const vector = (text: string) => {
    const v = new Float32Array(DIMS);
    const lower = text.toLowerCase();
    const words = [...(lower.match(/[\p{L}\p{M}]+/gu) ?? []), ...Object.keys(CONCEPTS).filter((k) => k.includes(" ") && lower.includes(k))];
    for (const w of words) if (CONCEPTS[w]) v[Number.parseInt(textHash(CONCEPTS[w]), 36) % DIMS] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return {
    model,
    dims: DIMS,
    calls,
    async embed(texts, kind) {
      if (kind === "passage") calls.push(texts);
      return texts.map(vector);
    },
  };
}

afterEach(() => setSemantic(null));

describe("fusion (weighted reciprocal rank fusion)", () => {
  it("keeps the model's best match first over a passage that only shares a word", () => {
    // "sister company" shares words with "what's my sister's name"; the model ranks it 5th.
    const vector = ["riya", "a", "b", "c", "sister-company"];
    const keyword = ["sister-company"];
    expect(fuse(vector, keyword)[0]).toBe("riya");
  });

  it("lifts an exact keyword match into the top three even when the model ranks it low", () => {
    const vector = ["a", "b", "c", "d", "e", "f", "g", "satay-note"];
    expect(fuse(vector, ["satay-note"]).indexOf("satay-note")).toBeLessThan(3);
  });

  it("ranks an item found by both above items found by one", () => {
    expect(fuse(["a", "both", "c"], ["both", "d"])[0]).toBe("both");
  });

  it("includes keyword-only and vector-only items, and nothing else", () => {
    const fused = fuse(["v1", "v2"], ["k1"]);
    expect(new Set(fused)).toEqual(new Set(["v1", "v2", "k1"]));
  });

  it("only looks at the top of each list", () => {
    const long = Array.from({ length: 50 }, (_, i) => `v${i}`);
    expect(fuse(long, [])).toHaveLength(20);
  });
});

describe("keyword search in more languages", () => {
  it("keeps Hindi and Bengali words whole (vowel signs are part of the word)", () => {
    expect(tokenize("मेरे बेटे का स्कूल अंधेरी में है।")).toContain(tokenize("अंधेरी")[0]);
    expect(tokenize("अंधेरी")).toHaveLength(1);
    expect(tokenize("আমি মাছ খেতে ভালোবাসি, বিশেষ করে ইলিশ।")).toContain(tokenize("ইলিশ")[0]);
    const notes = [{ text: "मेरे बेटे का स्कूल अंधेरी में है।" }, { text: "Riya is my sibling." }];
    expect(rank(notes, "अंधेरी")[0]).toBe(notes[0]);
  });

  it("ignores accents on Latin letters", () => {
    expect(tokenize("clínica")).toEqual(tokenize("clinica"));
    expect(rank([{ text: "Mi médico es la doctora Morales, en la clínica San Rafael." }], "clinica medico")).toHaveLength(1);
  });

  it("matches Chinese and Japanese text on character pairs", () => {
    expect(tokenize("在宅勤務")).toEqual(["在宅", "宅勤", "勤務"]);
    const notes = [{ text: "毎週水曜日は在宅勤務です。" }, { text: "私の息子はサッカーチームに入っています。" }];
    expect(rank(notes, "在宅勤務")[0]).toBe(notes[0]);
  });

  it("still stems and drops stopwords in English", () => {
    expect(tokenize("What are the refunds?")).toEqual(["refund"]);
  });
});

describe("chunking", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} talks about topic ${i}. ${"More words here. ".repeat(10)}`).join("\n\n");

  it("covers the whole text in passages near the target size", () => {
    const parts = chunk(text);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1200 + 400);
    for (let i = 0; i < 30; i++) expect(parts.some((p) => p.includes(`Paragraph ${i} `))).toBe(true);
  });

  it("carries the end of a passage into the next, so answers on a boundary still match", () => {
    const parts = chunk(text);
    const tail = parts[0].slice(-60).trim().split(/\s+/).slice(-3).join(" ");
    expect(parts[1]).toContain(tail);
  });

  it("is deterministic, so unchanged files map to the same stored vectors", () => {
    expect(chunk(text).map(textHash)).toEqual(chunk(text).map(textHash));
  });
});

describe("vector index", () => {
  it("embeds only new or changed texts", async () => {
    const store = memoryVectorStore();
    const embedder = conceptEmbedder();
    const index = new VectorIndex(store, embedder);
    expect(await index.add("memory:b", ["Riya is my sibling.", "I take my coffee black."])).toBe(2);
    expect(await index.add("memory:b", ["Riya is my sibling.", "I take my coffee black."])).toBe(0);
    expect(await index.add("memory:b", ["Riya is my sibling.", "I take my coffee black.", "Bruno is my golden retriever."])).toBe(1);
    expect(embedder.calls.flat()).toEqual(["Riya is my sibling.", "I take my coffee black.", "Bruno is my golden retriever."]);
    expect(store.records.get("memory:b")?.hashes).toHaveLength(3);
  });

  it("reuses stored vectors after a restart", async () => {
    const store = memoryVectorStore();
    await new VectorIndex(store, conceptEmbedder()).add("file:x", ["one passage", "another passage"]);
    const embedder = conceptEmbedder();
    expect(await new VectorIndex(store, embedder).missing("file:x", ["one passage", "another passage", "a new one"])).toBe(1);
  });

  it("starts over when the model changes", async () => {
    const store = memoryVectorStore();
    await new VectorIndex(store, conceptEmbedder("old-model")).add("file:x", ["one passage"]);
    const index = new VectorIndex(store, conceptEmbedder("new-model"));
    expect(await index.missing("file:x", ["one passage"])).toBe(1);
    expect(await index.add("file:x", ["one passage"])).toBe(1);
    expect(store.records.get("file:x")?.model).toBe("new-model");
  });

  it("drops forgotten memories and deleted sources without embedding anything", async () => {
    const store = memoryVectorStore();
    const embedder = conceptEmbedder();
    const index = new VectorIndex(store, embedder);
    await index.add("memory:b", ["keep me", "forget me"]);
    await index.add("file:gone", ["old file"]);
    expect(await index.retain("memory:b", ["keep me"])).toBe(1);
    expect(store.records.get("memory:b")?.hashes).toEqual([textHash("keep me")]);
    expect(await index.prune((source) => source !== "file:gone")).toEqual(["file:gone"]);
    expect(store.records.has("file:gone")).toBe(false);
    expect(embedder.calls.flat()).toHaveLength(3);
  });

  it("scores texts by cosine similarity, NaN until they're indexed", async () => {
    const embedder = conceptEmbedder();
    const index = new VectorIndex(memoryVectorStore(), embedder);
    await index.add("memory:b", ["Riya is my sibling.", "I take my coffee black."]);
    const [q] = await embedder.embed(["what's my sister's name"], "query");
    const scores = await index.scores("memory:b", ["Riya is my sibling.", "I take my coffee black.", "not indexed"], q);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(Number.isNaN(scores[2])).toBe(true);
  });

  it("saves progress on big files and stops when asked", async () => {
    const store = memoryVectorStore();
    const controller = new AbortController();
    const embedder = conceptEmbedder();
    const slow: Embedder = {
      ...embedder,
      async embed(texts, kind) {
        if (embedder.calls.length === 9) controller.abort();
        return embedder.embed(texts, kind);
      },
    };
    const texts = Array.from({ length: 200 }, (_, i) => `passage ${i}`);
    const done = await new VectorIndex(store, slow).add("file:big", texts, { signal: controller.signal });
    expect(done).toBe(80);
    expect(store.records.get("file:big")?.hashes).toHaveLength(80);
    expect(await new VectorIndex(store, conceptEmbedder()).missing("file:big", texts)).toBe(120);
  });
});

describe("hybrid ranking", () => {
  const items = [
    { source: "memory:b", text: "Our sister company handles payments." },
    { source: "memory:b", text: "Riya is my sibling." },
    { source: "memory:b", text: "I take my coffee black." },
  ];

  it("is keyword-only (as before) when smarter search is off", async () => {
    expect(getSemantic()).toBeNull();
    const keyword = rank(items, "what's my sister's name");
    const result = await hybridRank(items, "what's my sister's name", keyword);
    expect(result).toEqual({ items: keyword, semantic: false });
  });

  it("falls back to keywords when the model fails", async () => {
    setSemantic({ window: 1, scores: () => Promise.reject(new Error("model missing")) });
    const keyword = rank(items, "coffee");
    expect((await hybridRank(items, "coffee", keyword)).items).toEqual(keyword);
  });

  it("falls back to keywords when the model takes too long", async () => {
    vi.useFakeTimers();
    try {
      setSemantic({ window: 1, scores: () => new Promise(() => undefined) });
      const keyword = rank(items, "coffee");
      const pending = hybridRank(items, "coffee", keyword);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await pending).items).toEqual(keyword);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds by meaning what keywords miss", async () => {
    const index = new VectorIndex(memoryVectorStore(), conceptEmbedder());
    setSemantic(createSemantic(index, conceptEmbedder(), () => undefined));
    const query = "what's my sister's name";
    expect(rank(items, query).map((i) => i.text)).toEqual(["Our sister company handles payments."]);
    const result = await hybridRank(items, query, rank(items, query));
    expect(result.semantic).toBe(true);
    expect(result.items.map((i) => i.text)).toContain("Riya is my sibling.");
  });

  it("finds knowledge passages by meaning once the file is indexed, keywords until then", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Section ${i}: general policy text about scheduling. ${"Details. ".repeat(40)}`).join("\n\n");
    const text = `${filler}\n\nAnnual plans are refunded pro rata within 60 days.\n\n${filler}`;
    const ref = await saveKnowledgeText("handbook.md", text);
    const question = "can I get my money back";
    // No shared words: keyword search alone finds nothing (as before).
    expect((await knowledgeContext([ref], question)).prompt).toBe("");
    expect((await knowledgeContext([ref], "refund policy for yearly plans")).prompt).toContain("refunded pro rata");

    const embedder = conceptEmbedder();
    const index = new VectorIndex(memoryVectorStore(), embedder);
    const backlog = vi.fn();
    setSemantic(createSemantic(index, embedder, backlog));
    // A big file isn't embedded while the user waits: the background pass does it.
    expect((await knowledgeContext([ref], question)).prompt).toBe("");
    expect(backlog).toHaveBeenCalled();
    expect(embedder.calls).toHaveLength(0);

    await index.add(knowledgeSource(ref.id), chunk(text));
    expect((await knowledgeContext([ref], question)).prompt).toContain("refunded pro rata");
  });
});

describe("background indexing", () => {
  it("indexes memories and files once, then only what changed, and forgets what's gone", async () => {
    const store = memoryVectorStore();
    const embedder = conceptEmbedder();
    const index = new VectorIndex(store, embedder);
    const file = await saveKnowledgeText("faq.md", "Annual plans are refunded pro rata within 60 days.");
    let bots = [
      { id: "a", memory: ["Riya is my sibling.", "I take my coffee black."], knowledge: [file] },
      { id: "b", memory: ["I'm allergic to peanuts."], knowledge: [] },
    ];
    const complete = new Set<string>();
    const statuses: string[] = [];
    await syncIndex(index, indexSources(bots, []), { complete, onStatus: (s) => s && statuses.push(`${s.done}/${s.total}`) });
    expect(embedder.calls.flat()).toHaveLength(4);
    expect(statuses.at(-1)).toBe("4/4");
    // Memories go first: they're small and every chat uses them.
    expect(embedder.calls[0]).toEqual(["Riya is my sibling.", "I take my coffee black."]);
    expect(complete.has(knowledgeSource(file.id))).toBe(true);

    // Nothing changed: nothing is embedded.
    await syncIndex(index, indexSources(bots, []), { complete });
    expect(embedder.calls.flat()).toHaveLength(4);

    // One memory forgotten, one added, bot "b" deleted.
    bots = [{ id: "a", memory: ["Riya is my sibling.", "Bruno is my golden retriever."], knowledge: [file] }];
    await syncIndex(index, indexSources(bots, []), { complete });
    expect(embedder.calls.flat()).toHaveLength(5);
    expect(embedder.calls.at(-1)).toEqual(["Bruno is my golden retriever."]);
    expect(store.records.get(memorySource("a"))?.hashes).toEqual([textHash("Riya is my sibling."), textHash("Bruno is my golden retriever.")]);
    expect(store.records.has(memorySource("b"))).toBe(false);

    // The file is removed from the bot: its vectors go too.
    bots = [{ id: "a", memory: bots[0].memory, knowledge: [] }];
    await syncIndex(index, indexSources(bots, []), { complete });
    expect(store.records.has(knowledgeSource(file.id))).toBe(false);
  });
});

describe("smarter search on questions", () => {
  it("embeds a few new memories right away and leaves big backlogs to the background", async () => {
    const embedder = conceptEmbedder();
    const index = new VectorIndex(memoryVectorStore(), embedder);
    const backlog = vi.fn();
    const semantic: Semantic = createSemantic(index, embedder, backlog);
    const memories = ["Riya is my sibling.", "I take my coffee black."];
    const bigFile = Array.from({ length: 40 }, (_, i) => `passage ${i}`);
    const [memoryScores, fileScores] = await semantic.scores("sister", [
      { source: "memory:b", texts: memories },
      { source: "file:big", texts: bigFile },
    ]);
    expect(Number.isFinite(memoryScores[0])).toBe(true);
    expect(fileScores.every(Number.isNaN)).toBe(true);
    expect(backlog).toHaveBeenCalled();
    expect(embedder.calls.flat()).toEqual(memories);
  });
});

describe("memory recall", () => {
  const bot = (memory: string[]): Pick<Bot, "id" | "memory"> => ({ id: "b", memory });
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `Fact number ${i}: the user mentioned detail ${i} about their week, their plans and errands.`);

  it("puts every memory in the prompt while there are few (unchanged)", async () => {
    const memory = ["Riya is my sibling.", "I take my coffee black."];
    expect(memoryIsLarge(memory)).toBe(false);
    expect(await memoryContext(bot(memory), "what's my sister's name")).toEqual({ pinned: memory, recalled: [] });
  });

  it("keeps the newest memories in the prompt and recalls older ones by relevance", async () => {
    const memory = ["Riya is my sibling.", "I'm allergic to peanuts.", ...filler(90)];
    const { pinned, rest } = splitMemory(memory);
    expect(pinned.at(-1)).toBe(memory.at(-1));
    expect(pinned.join("\n").length).toBeLessThanOrEqual(3000);
    expect(rest).toContain("Riya is my sibling.");

    // Keywords alone: "allergies" vs "allergic" don't match, and nothing says "sister".
    expect((await memoryContext(bot(memory), "what's my sister's name")).recalled).not.toContain("Riya is my sibling.");

    // Smarter search on, memories indexed by the background pass.
    const index = new VectorIndex(memoryVectorStore(), conceptEmbedder());
    await index.add(memorySource("b"), memory);
    setSemantic(createSemantic(index, conceptEmbedder(), () => undefined));
    const recalled = (await memoryContext(bot(memory), "what's my sister's name")).recalled;
    expect(recalled).toContain("Riya is my sibling.");
    expect(recalled.length).toBeLessThanOrEqual(10);
    expect(await searchMemory({ id: "b" }, memory, "do I have any allergies?", 3)).toContain("I'm allergic to peanuts.");
  });

  it("tells the bot when only the newest memories are in the prompt", () => {
    const full: Bot = {
      id: "b",
      name: "ADT",
      avatar: "",
      description: "",
      systemPrompt: "You are ADT.",
      providerId: "p",
      model: "m",
      temperature: null,
      thinking: "off",
      memory: ["a fact", "another fact"],
      autoMemory: false,
      createdAt: 0,
    };
    expect(buildSystemPrompt(full)).toContain("earlier conversations:\n- a fact\n- another fact");
    expect(buildSystemPrompt(full, { memory: ["another fact"] })).toContain(
      "(the most recent; older ones that matter come with each message):\n- another fact",
    );
  });
});
