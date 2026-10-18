// @vitest-environment node
import { describe, expect, it } from "vitest";
import { botsToAnswer, mentionedBots, type RoomMessage, transcriptFor } from "./logic";

const bots = [
  { id: "a", name: "Ada" },
  { id: "j", name: "Jarvis Prime", nickname: "JP" },
];

const msg = (over: Partial<RoomMessage>): RoomMessage => ({ id: Math.random().toString(36), seq: 0, kind: "guest", author: "Bob", text: "", ts: 0, ...over });

describe("room mentions", () => {
  it("finds @mentions by name or nickname, in order, on word boundaries", () => {
    expect(mentionedBots("hey @jp and @ada?", bots).map((b) => b.id)).toEqual(["j", "a"]);
    expect(mentionedBots("@Jarvis Prime what's up", bots).map((b) => b.id)).toEqual(["j"]);
    expect(mentionedBots("mail me at bob@ada.com or @adam", bots)).toEqual([]);
    expect(mentionedBots("@all hello", bots)).toHaveLength(2);
  });

  it("decides who answers", () => {
    expect(botsToAnswer({ kind: "guest", text: "hi all" }, bots, "mention")).toEqual([]);
    expect(botsToAnswer({ kind: "guest", text: "hi all" }, bots, "all").map((b) => b.id)).toEqual(["a"]);
    expect(botsToAnswer({ kind: "host", text: "@jp go" }, bots, "all").map((b) => b.id)).toEqual(["j"]);
    // Bots never trigger bots.
    expect(botsToAnswer({ kind: "bot", text: "@ada" }, bots, "all")).toEqual([]);
  });

  it("turns the room transcript into alternating turns with speaker names", () => {
    const out = transcriptFor(
      [
        msg({ kind: "bot", author: "Ada", authorId: "a", text: "earlier" }),
        msg({ author: "Bob", text: "hi" }),
        msg({ kind: "host", author: "Dom", text: "welcome" }),
        msg({ kind: "bot", author: "Ada", authorId: "a", text: "Hello both" }),
        msg({ kind: "bot", author: "Jarvis Prime", authorId: "j", text: "me too" }),
        msg({ author: "Eve", text: "@ada <b>question</b>" }),
        msg({ kind: "bot", author: "Ada", authorId: "a", text: "", pending: true }),
      ],
      "a",
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[0].content).toBe("Bob: hi\n\nDom (host): welcome");
    expect(out[1].content).toBe("Hello both");
    expect(out[2].content).toBe("Jarvis Prime (bot): me too\n\nEve: @ada <b>question</b>");
  });
});
