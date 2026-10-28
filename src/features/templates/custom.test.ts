// @vitest-environment node
// "Create your own bot": the user's model writes a draft from a few words (only known tools, a safe
// picture), and the checked draft is added like any template.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, useStore } from "../../lib/store";
import type { Bot, ProviderConfig } from "../../lib/types";
import { useRoutines } from "../automation/routines-store";
import { cleanAppPassword } from "../apps/api";

const complete = vi.hoisted(() => vi.fn());
vi.mock("../../lib/llm", async (importOriginal) => ({ ...(await importOriginal<object>()), complete }));

const { canWriteDraft, draftTemplate, EMPTY_DRAFT, parseDraft, writeDraft } = await import("./custom");
const { installTemplate } = await import("./template");
await import("../../lib/agent/builtin");
const { allToolGroups } = await import("../../lib/agent/tools");

const provider: ProviderConfig = { id: "p1", presetId: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "", apiKey: "k", models: [] };
const bot: Bot = { id: "b1", name: "Assistant", avatar: "✦", description: "", systemPrompt: "", providerId: "p1", model: "claude-opus-5-5", temperature: null, thinking: "off", memory: [], autoMemory: true, createdAt: 0 };

beforeEach(() => {
  complete.mockReset();
  useStore.setState({ providers: [provider], bots: [{ ...bot }], activeBotId: "b1", skills: [], conversations: {}, settings: defaultSettings, hydrated: true });
  useRoutines.setState({ routines: [], loaded: true, running: [] });
});

describe("writing a bot from a description", () => {
  it("asks the bot in use, with the tool list, and keeps only known tools", async () => {
    const ids = allToolGroups().map((g) => g.id);
    expect(ids.length).toBeGreaterThan(1);
    complete.mockResolvedValue(
      "Here you go:\n```json\n" +
        JSON.stringify({ name: "Study Coach", emoji: "🎓", description: "Quizzes you on your notes", instructions: "You are a study coach…", tools: [ids[0], "made_up", ids[0]] }) +
        "\n```",
    );
    const draft = await writeDraft("A study coach that quizzes me");
    expect(draft).toEqual({ name: "Study Coach", avatar: "🎓", description: "Quizzes you on your notes", systemPrompt: "You are a study coach…", toolGroups: [ids[0]] });
    const request = complete.mock.calls[0][0];
    expect(request).toMatchObject({ provider: { id: "p1" }, model: "claude-opus-5-5" });
    expect(request.messages[0].content).toContain(`- ${ids[0]}: `);
    expect(request.messages[0].content).toMatch(/The bot I want:\nA study coach that quizzes me$/);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to all tools, refuses a picture from the web, and says when the answer can't be used", () => {
    expect(parseDraft('{"name":"Chef","emoji":"https://evil.example/x.png","instructions":"Cook.","tools":[]}', ["web"])).toMatchObject({ avatar: "✦", toolGroups: "all" });
    expect(() => parseDraft("Sorry, I can't help with that.", ["web"])).toThrow(/couldn't be read/);
    expect(() => parseDraft('{"name":"","instructions":"x"}', ["web"])).toThrow(/no name or instructions/);
  });

  it("needs a provider to write it (filling it in yourself always works)", async () => {
    expect(canWriteDraft()).toBe(true);
    useStore.setState({ providers: [] });
    expect(canWriteDraft()).toBe(false);
    await expect(writeDraft("anything")).rejects.toThrow(/Add an AI provider/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("adds the checked draft as a new bot with the user's model", async () => {
    const { bot: made } = await installTemplate(
      draftTemplate({ ...EMPTY_DRAFT, name: "  Meal Planner ", avatar: "🥗", description: "Dinners and a shopping list", systemPrompt: "You plan dinners.\n", toolGroups: ["web"] }),
      true,
    );
    expect(made).toMatchObject({ name: "Meal Planner", avatar: "🥗", description: "Dinners and a shopping list", systemPrompt: "You plan dinners.", toolGroups: ["web"], providerId: "p1", model: "claude-opus-5-5", autoMemory: true });
    expect(useStore.getState().bots.map((b) => b.name)).toEqual(["Assistant", "Meal Planner"]);
    // A blank name still makes a bot with a name.
    expect((await installTemplate(draftTemplate(EMPTY_DRAFT), true)).bot.name).toBe("My bot");
  });
});

describe("app passwords", () => {
  it("drops the spaces Google shows in an app password, and nothing else", () => {
    expect(cleanAppPassword("gmail", "abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(cleanAppPassword("gmail", "my real pass word")).toBe("my real pass word");
    expect(cleanAppPassword("other", "abcd efgh ijkl mnop")).toBe("abcd efgh ijkl mnop");
  });
});
