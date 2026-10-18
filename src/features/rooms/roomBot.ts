import { runToolLoop } from "../../lib/agent/loop";
import { toolsFor } from "../../lib/agent/tools";
import { buildSystemPrompt, stripMemoryTags } from "../../lib/chat";
import { desktopInvoke } from "../../lib/desktop";
import { type StreamEvent, streamChat } from "../../lib/llm";
import { useStore } from "../../lib/store";
import type { Bot, ToolCallRecord } from "../../lib/types";
import { GUEST_SAFE_TOOLS, type RoomMessage, roomPrompt, type RoomTools, transcriptFor } from "./logic";

type Options = {
  roomId: string;
  roomName: string;
  hostName: string;
  bot: Bot;
  transcript: RoomMessage[];
  tools: RoomTools;
  signal: AbortSignal;
  onCalls: (calls: ToolCallRecord[]) => void;
  onError: (text: string) => void;
};

/**
 * Runs one bot reply for a room on this computer (the host's providers and keys never leave it)
 * and streams the text into the room. The bot's private memory, the host's profile and knowledge
 * files are left out, because everyone in the room reads the answers.
 */
export async function runRoomBot(o: Options) {
  const { settings, providers } = useStore.getState();
  const provider = providers.find((p) => p.id === o.bot.providerId);
  const messages = transcriptFor(o.transcript, o.bot.id);
  if (!messages.length) return;
  const reply = await desktopInvoke<RoomMessage>("adt:rooms:send", { id: o.roomId, kind: "bot", author: o.bot.name, botId: o.bot.id, pending: true });
  const update = (text: string, done = false) => desktopInvoke("adt:rooms:update", { id: o.roomId, messageId: reply.id, text, done }).catch(() => undefined);

  if (!provider || !o.bot.model) {
    o.onError("this bot has no provider or model yet (Bot settings).");
    await update("I'm not set up yet. Ask the host to pick a model for me.", true);
    return;
  }

  const bot: Bot = { ...o.bot, memory: [], autoMemory: false };
  const system = [buildSystemPrompt(bot), roomPrompt(bot.name, o.roomName, o.hostName)].join("\n\n");
  const all = o.tools === "none" ? [] : toolsFor({ settings, providers, platform: "desktop", bot });
  const tools = o.tools === "full" ? all : all.filter((t) => GUEST_SAFE_TOOLS.has(t.name) && t.risk === "read" && !t.riskFor);

  let content = "";
  let lastSent = 0;
  const handle = (event: StreamEvent) => {
    if (event.type !== "text") return;
    content += event.text;
    const now = performance.now();
    if (now - lastSent > 160) {
      lastSent = now;
      void update(stripMemoryTags(content));
    }
  };
  const request = {
    provider,
    model: o.bot.model,
    system,
    messages,
    temperature: o.bot.temperature,
    thinking: o.bot.thinking,
    useProxy: settings.useProxy,
    signal: o.signal,
  };
  try {
    if (tools.length) {
      await runToolLoop({
        request,
        tools,
        context: { bot, conversationId: `room:${o.roomId}`, settings, providers, platform: "desktop", signal: o.signal, progress: () => undefined },
        mode: settings.agent.mode,
        maxSteps: Math.min(settings.agent.maxSteps, 6),
        callbacks: { onEvent: handle, onCalls: o.onCalls },
      });
    } else {
      for await (const event of streamChat(request)) handle(event);
    }
    const text = stripMemoryTags(content).trim();
    await update(text || "(no answer)", true);
  } catch (error) {
    const aborted = (error as Error).name === "AbortError" || o.signal.aborted;
    // The details (which may name the provider or server) stay with the host.
    if (!aborted) o.onError((error as Error).message);
    const text = stripMemoryTags(content).trim();
    await update(aborted ? `${text}${text ? " " : ""}(stopped)` : text ? `${text}\n\n(Reply cut off.)` : "Sorry, I couldn't answer just now.", true);
  }
}
