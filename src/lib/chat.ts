import { generateImage, resolveImageModel } from "./imagine";
import "./agent/features";
import { runToolLoop } from "./agent/loop";
import { toolsFor } from "./agent/tools";
import { complete, type StreamEvent, streamChat, supportsNativeSearch } from "./llm";
import { detectEnv } from "./transport";
import { findUrls, readPage, sourcesPrompt, webSearch } from "./search";
import { addMemory, flushStorage, newConversation, uid, updateConversation, useStore } from "./store";
import type { Attachment, Bot, Message, Source } from "./types";
import { knowledgeContext } from "./knowledge";
import { speak } from "./voice";

export type SendOptions = {
  search?: boolean;
  think?: boolean;
  imagine?: boolean;
  /** Spoken conversation: short answers, lighter reasoning, optional faster voice model. */
  voice?: boolean;
  /** Routines and bot-to-bot work: runs alongside the visible chat (no stop button, no read-aloud). */
  background?: boolean;
  /** Cancels a background run. */
  signal?: AbortSignal;
};

const VOICE_STYLE =
  "This is a live voice conversation: your reply is read aloud. Answer like a person talking: lead with the answer in one " +
  "or two short sentences, then stop unless asked for more. No Markdown, lists, tables, emojis, URLs or code blocks; " +
  "spell out symbols and numbers naturally.";

let controller: AbortController | null = null;

/** Voice mode speaks replies itself, so auto read-aloud steps aside while it's open. */
let voiceModeActive = false;
export function setVoiceModeActive(active: boolean) {
  voiceModeActive = active;
}

// Also accepts the malformed `<remember fact>` small local models sometimes write.
const REMEMBER_TAG = /<remember(?:>([\s\S]*?)(?:<\/remember>|$)|\s+([^>]*)>)/g;

/** Hide memory tags from the visible reply (including one still being streamed). */
export function stripMemoryTags(text: string): string {
  return text.replace(REMEMBER_TAG, "").trimEnd();
}

type PromptExtras = { userName?: string; about?: string; customInstructions?: string; knowledge?: string; voice?: boolean };

export function buildSystemPrompt(bot: Bot, extras: PromptExtras = {}): string {
  const { userName = "", about = "", customInstructions = "", knowledge = "", voice = false } = extras;
  const parts = [bot.systemPrompt.trim()];
  if (bot.nickname?.trim() && bot.nickname.trim().toLowerCase() !== bot.name.toLowerCase()) {
    parts.push(`Your name is ${bot.name}; the user also calls you "${bot.nickname.trim()}".`);
  }
  if (userName.trim()) parts.push(`The user's name is ${userName.trim()}. Use it naturally now and then, not in every reply.`);
  if (about.trim()) parts.push(`About the user, their organisation and what you're here for:\n${about.trim()}`);
  parts.push(`Current date: ${new Date().toLocaleDateString(undefined, { dateStyle: "full" })}.`);
  if (customInstructions.trim()) {
    parts.push(`About the user and how they want answers (follow this):\n${customInstructions.trim()}`);
  }
  if (bot.memory.length) {
    parts.push(`Things you remember about the user from earlier conversations:\n${bot.memory.map((m) => `- ${m}`).join("\n")}`);
  }
  if (bot.autoMemory) {
    parts.push(
      "If the user tells you a lasting fact about themselves (such as their name or job), " +
        "end your reply with <remember>that fact</remember>.",
    );
  }
  if (knowledge) parts.push(knowledge);
  if (voice) parts.push(VOICE_STYLE);
  return parts.filter(Boolean).join("\n\n");
}

/** Slash commands: /remember, /imagine (or /image), /search. */
function parseCommand(text: string): { command?: "remember" | "imagine" | "search"; rest: string } {
  const match = /^\/(remember|imagine|image|search)\b\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return { rest: text.trim() };
  const name = match[1].toLowerCase();
  return { command: name === "image" ? "imagine" : (name as "remember" | "imagine" | "search"), rest: match[2].trim() };
}

export async function sendMessage(text: string, attachments: Attachment[] = [], options: SendOptions = {}) {
  const state = useStore.getState();
  const bot = state.bots.find((b) => b.id === state.activeBotId);
  if (!bot || state.streamingId) return;

  const { command, rest } = parseCommand(text);
  if (command === "remember") {
    if (rest) addMemory(bot.id, [rest]);
    return;
  }
  const opts: SendOptions = {
    ...options,
    search: options.search || command === "search",
    imagine: options.imagine || command === "imagine",
  };

  const conversationId = state.activeConversationId ?? newConversation(bot.id).id;
  const userMessage: Message = {
    id: uid(),
    role: "user",
    content: rest,
    attachments: attachments.length ? attachments : undefined,
    createdAt: Date.now(),
  };
  updateConversation(conversationId, (c) => ({
    ...c,
    title: c.messages.length ? c.title : titleFrom(rest || attachments[0]?.name || "New chat"),
    messages: [...c.messages, userMessage],
    updatedAt: Date.now(),
  }));
  await runAssistant(conversationId, bot.id, opts);
}

/** Drop everything after `messageId` (optionally replacing its text) and ask again. */
export async function resendFrom(conversationId: string, messageId: string, newText?: string) {
  const state = useStore.getState();
  const conversation = state.conversations[conversationId];
  if (!conversation || state.streamingId) return;

  let index = conversation.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return;
  const replaced = conversation.messages[index];
  // Regenerating an assistant reply means resending the user turn before it.
  if (replaced.role === "assistant") index -= 1;
  if (index < 0) return;
  const wasImage = replaced.role === "assistant" && replaced.attachments?.some((a) => a.kind === "image");
  const wasSearch = replaced.role === "assistant" && Boolean(replaced.sources?.length);

  updateConversation(conversationId, (c) => {
    const messages = c.messages.slice(0, index + 1);
    if (newText !== undefined) messages[index] = { ...messages[index], content: newText };
    return { ...c, messages, updatedAt: Date.now() };
  });
  const modes = state.settings.modes;
  await runAssistant(conversationId, conversation.botId, {
    imagine: wasImage,
    search: wasSearch || modes.search,
    think: modes.think,
  });
}

/**
 * Sends `text` to a conversation's bot without touching the chat on screen and waits for the reply
 * (routines, bots asking other bots). Same flow as a normal message: the bot's model, prompt,
 * knowledge and tools.
 */
export async function sendInBackground(conversationId: string, text: string, options: { signal?: AbortSignal } = {}): Promise<Message | undefined> {
  const conversation = useStore.getState().conversations[conversationId];
  if (!conversation) throw new Error("That conversation no longer exists.");
  const userMessage: Message = { id: uid(), role: "user", content: text, createdAt: Date.now() };
  updateConversation(conversationId, (c) => ({ ...c, messages: [...c.messages, userMessage], updatedAt: Date.now() }));
  await runAssistant(conversationId, conversation.botId, { background: true, signal: options.signal });
  const messages = useStore.getState().conversations[conversationId]?.messages ?? [];
  return messages.slice(messages.findIndex((m) => m.id === userMessage.id) + 1).find((m) => m.role === "assistant");
}

export function stopStreaming() {
  controller?.abort();
}

async function runAssistant(conversationId: string, botId: string, opts: SendOptions) {
  const state = useStore.getState();
  const bot = state.bots.find((b) => b.id === botId)!;
  const { settings, providers } = state;
  // Voice conversations can use a separate, faster model.
  const voiceOverride = opts.voice && settings.voice.voiceModel && providers.find((p) => p.id === settings.voice.voiceProviderId);
  const provider = voiceOverride || providers.find((p) => p.id === bot.providerId);
  const model = voiceOverride ? settings.voice.voiceModel : bot.model;
  const history = state.conversations[conversationId].messages;
  const temporary = Boolean(state.conversations[conversationId].temporary);
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const started = performance.now();

  const reply: Message = { id: uid(), role: "assistant", content: "", model, createdAt: Date.now() };
  updateConversation(conversationId, (c) => ({ ...c, messages: [...c.messages, reply] }));
  // updatedAt only moves at the start and end of a reply, so the chat list doesn't re-sort per token.
  const patchReply = (patch: Partial<Message>) =>
    updateConversation(conversationId, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === reply.id ? { ...m, ...patch } : m)),
    }));

  const own = new AbortController();
  if (opts.signal?.aborted) own.abort();
  opts.signal?.addEventListener("abort", () => own.abort(), { once: true });
  const signal = own.signal;
  if (!opts.background) {
    controller = own;
    useStore.setState({ streamingId: conversationId });
  }

  try {
    if (opts.imagine) {
      await runImagine(lastUser?.content ?? "", patchReply, signal);
      return;
    }
    if (!provider || !model) {
      patchReply({ error: "This bot has no provider or model yet. Open the bot settings (top right) and pick one." });
      return;
    }

    // Context: pages the user linked, then live web results.
    const urls = findUrls(lastUser?.content ?? "");
    const pages: { url: string; text: string }[] = [];
    if (urls.length) {
      patchReply({ status: urls.length === 1 ? "Reading the link…" : `Reading ${urls.length} links…` });
      const texts = await Promise.all(urls.map((url) => readPage(url, settings.useProxy, signal)));
      texts.forEach((text, i) => text && pages.push({ url: urls[i], text }));
    }

    const thinking = opts.think ? (bot.thinking === "off" ? "high" : bot.thinking) : bot.thinking;
    const knowledge = await knowledgeContext([...settings.knowledge, ...(bot.knowledge ?? [])], recentQuestion(history));
    if (knowledge.used.length) patchReply({ knowledge: knowledge.used });
    const basePrompt = buildSystemPrompt(bot, {
      userName: settings.userName,
      about: settings.about,
      customInstructions: settings.customInstructions,
      knowledge: knowledge.prompt,
      voice: opts.voice && settings.voice.concise,
    });
    let content = "";
    let reasoning = "";
    let sources: Source[] = [];
    let firstMs: number | undefined;
    let note: string | undefined;

    /** Our own search: query → engine → page reading, results handed to the model as context. */
    const appSearch = async () => {
      patchReply({ status: "Searching the web…" });
      const query = await searchQuery(lastUser?.content ?? "", history, bot, signal);
      try {
        sources = await webSearch(query, settings.search, settings.useProxy, signal);
        if (!sources.length) note = "Web search found nothing for this question.";
      } catch (error) {
        if (signal.aborted) throw error;
        note = `Web search unavailable: ${(error as Error).message}`;
      }
      return query;
    };

    // Tools the bot may use for this answer (voice mode: only ones that never need approval).
    const platform = (await detectEnv()).platform;
    let agentTools = toolsFor({ settings, providers, platform, bot });
    if (opts.voice) agentTools = agentTools.filter((t) => t.risk === "read" && !t.riskFor);

    const stream = async (nativeSearch: boolean, query: string) => {
      const context = pages.length || sources.length ? sourcesPrompt(query, sources, pages) : "";
      const system = [basePrompt, context].filter(Boolean).join("\n\n");
      let lastPaint = 0;
      // A search problem stays visible under the answer; otherwise the progress line goes away.
      patchReply({ status: nativeSearch ? "Searching the web…" : note, sources: sources.length ? sources : undefined });
      const handle = (event: StreamEvent) => {
        if (event.type === "tool_calls") return;
        if (event.type === "sources") {
          sources = event.sources;
          patchReply({ sources });
          return;
        }
        if (event.type === "status") {
          patchReply({ status: event.text });
          return;
        }
        firstMs ??= performance.now() - started;
        if (event.type === "text") content += event.text;
        else reasoning += event.text;
        // Repaint at most ~20 times a second; the store work per paint stays small.
        const now = performance.now();
        if (now - lastPaint > 50) {
          lastPaint = now;
          patchReply({ content, reasoning: reasoning || undefined, status: undefined });
        }
      };
      const request = {
        provider,
        model,
        system,
        messages: history,
        temperature: bot.temperature,
        thinking,
        useProxy: settings.useProxy,
        // Gemini can't combine Google Search with function calling; the web_search tool covers it.
        nativeSearch: nativeSearch && !(agentTools.length && provider.kind === "gemini"),
        fast: opts.voice,
        signal,
      };
      if (agentTools.length) {
        await runToolLoop({
          request,
          tools: agentTools,
          context: { bot, conversationId, settings, providers, platform, signal, progress: () => undefined },
          mode: settings.agent.mode,
          maxSteps: settings.agent.maxSteps,
          callbacks: { onEvent: handle, onCalls: (toolCalls) => patchReply({ toolCalls, status: undefined }) },
        });
      } else {
        for await (const event of streamChat(request)) handle(event);
      }
      patchReply({ content, reasoning: reasoning || undefined });
    };

    // Prefer the provider's own search (more reliable, no scraping); fall back to ours if it errors.
    const native = Boolean(opts.search && settings.search.native && supportsNativeSearch(provider));
    try {
      if (native) {
        try {
          await stream(true, "");
        } catch (error) {
          if ((error as Error).name === "AbortError" || content) throw error;
          const query = await appSearch();
          note ??= "Used ADT Bot's web search (the provider's built-in search wasn't available).";
          await stream(false, query);
        }
      } else {
        await stream(false, opts.search ? await appSearch() : "");
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        patchReply({ content: stripMemoryTags(content), reasoning: reasoning || undefined, error: (error as Error).message, status: undefined });
        return;
      }
    }

    const remembered = [...content.matchAll(REMEMBER_TAG)].map((m) => (m[1] ?? m[2] ?? "").trim());
    if (remembered.length && !temporary) addMemory(bot.id, remembered);
    const finalText = stripMemoryTags(content);
    patchReply({
      content: finalText,
      reasoning: reasoning || undefined,
      status: note,
      sources: sources.length ? sources : undefined,
      stats: { ms: Math.round(performance.now() - started), firstMs: firstMs && Math.round(firstMs) },
    });
    if (settings.autoSpeak && finalText && !signal.aborted && !voiceModeActive && !opts.background) {
      speak(finalText, { voice: settings.voice, providers, useProxy: settings.useProxy });
    }
    if (!signal.aborted) void autoTitle(conversationId);
  } catch (error) {
    if ((error as Error).name !== "AbortError") patchReply({ error: (error as Error).message, status: undefined });
    else patchReply({ status: undefined });
  } finally {
    updateConversation(conversationId, (c) => ({ ...c, updatedAt: Date.now() }));
    if (!opts.background) {
      controller = null;
      useStore.setState({ streamingId: null });
    }
    flushStorage();
  }
}

async function runImagine(prompt: string, patchReply: (patch: Partial<Message>) => void, signal: AbortSignal) {
  const { providers, settings } = useStore.getState();
  const target = resolveImageModel(providers, settings.image);
  if (!target) {
    patchReply({
      error:
        "No image model is set up. Connect OpenRouter, OpenAI, xAI or Google Gemini, or choose one in Settings → Images.",
    });
    return;
  }
  if (!prompt.trim()) {
    patchReply({ error: "Describe the image you want, e.g. /imagine a fox astronaut, watercolor." });
    return;
  }
  const started = performance.now();
  patchReply({ status: `Creating image with ${target.model}…`, model: target.model });
  const { images, text } = await generateImage(target.provider, target.model, prompt, settings.useProxy, signal);
  if (!images.length) {
    patchReply({ status: undefined, error: text || "The model returned no image. Try another image model in Settings → Images." });
    return;
  }
  patchReply({
    status: undefined,
    content: text,
    attachments: images.map((dataUrl, i) => ({ kind: "image", dataUrl, name: `image-${i + 1}.png` })),
    stats: { ms: Math.round(performance.now() - started) },
  });
}

/** For follow-ups ("and tomorrow?") ask the model for a standalone query; first messages are used as-is. */
async function searchQuery(text: string, history: Message[], bot: Bot, signal: AbortSignal): Promise<string> {
  const plain = text.replace(/https?:\/\/\S+/g, "").trim().slice(0, 300);
  const earlier = history.slice(0, -1).filter((m) => m.content);
  const { providers, settings } = useStore.getState();
  const provider = providers.find((p) => p.id === bot.providerId);
  if (!earlier.length || !provider) return plain || text.slice(0, 300);
  const transcript = [...earlier.slice(-4), { role: "user", content: plain }]
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 500)}`)
    .join("\n");
  try {
    const query = await complete({
      provider,
      model: bot.model,
      system: "You turn the last message of a conversation into one concise web search query. Reply with the query only.",
      messages: [{ id: "q", role: "user", content: `${transcript}\n\nSearch query:`, createdAt: 0 }],
      useProxy: settings.useProxy,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    const clean = query.split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").trim();
    return clean.length > 2 && clean.length < 200 ? clean : plain;
  } catch {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return plain;
  }
}

/** Names a chat from its first exchange, like "Lisbon trip budget". */
async function autoTitle(conversationId: string) {
  const { conversations, settings, bots, providers } = useStore.getState();
  const conversation = conversations[conversationId];
  if (!settings.smartTitles || !conversation || conversation.titled || conversation.temporary) return;
  const [first, answer] = conversation.messages;
  if (!first || !answer?.content) return;
  const bot = bots.find((b) => b.id === conversation.botId);
  const provider = providers.find((p) => p.id === bot?.providerId);
  if (!bot || !provider) return;
  updateConversation(conversationId, (c) => ({ ...c, titled: true }));
  try {
    const title = await complete({
      provider,
      model: bot.model,
      system: "You write very short chat titles. Reply with the title only: 2 to 6 words, no quotes, no period.",
      messages: [
        {
          id: "t",
          role: "user",
          content: `User: ${first.content.slice(0, 600)}\nAssistant: ${answer.content.slice(0, 600)}\n\nTitle:`,
          createdAt: 0,
        },
      ],
      useProxy: settings.useProxy,
      signal: AbortSignal.timeout(45000),
    });
    const clean = title.split("\n")[0].replace(/^["'#*\s]+|["'.*\s]+$/g, "").slice(0, 60);
    if (clean.length > 1) updateConversation(conversationId, (c) => ({ ...c, title: clean }));
  } catch {
    // Keep the first-line title.
  }
}

/** The question to match knowledge against: the latest message plus a little earlier context. */
function recentQuestion(history: Message[]): string {
  return history
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join(" ");
}

function titleFrom(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}
