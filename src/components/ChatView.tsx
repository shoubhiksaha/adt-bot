import { ArrowDown, ChevronDown, Download, EyeOff, Menu, MoreHorizontal, SlidersHorizontal, SquarePen } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { conversationMarkdown, newConversation, renameConversation, startNewChat, useStore } from "../lib/store";
import type { Bot, Conversation } from "../lib/types";
import { Composer } from "./Composer";
import { CopyButton } from "./CopyButton";
import { MessageItem } from "./MessageItem";
import { ModelMenu } from "./ModelMenu";
import { BotAvatar, useBotAvatar } from "./Avatar";

const SUGGESTIONS: Record<string, string[]> = {
  ADT: [
    "What's happening in AI this week? Use search",
    "Roast my morning routine: coffee, doomscroll, regret",
    "Explain quantum entanglement like I'm a sarcastic 12-year-old",
    "/imagine a neon fox astronaut, cinematic lighting",
  ],
  Coder: [
    "Review this function for bugs: (paste code)",
    "Write a Python script that renames photos by date taken",
    "Explain async/await vs threads with examples",
    "Set up a TypeScript + Vite project from scratch",
  ],
  default: [
    "Plan a 3-day trip to Lisbon on a budget",
    "Explain how transformers work, simply",
    "Summarize a PDF: attach it with the paperclip",
    "Help me write a polite follow-up email",
  ],
};

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

async function download(name: string, text: string) {
  const file = new File([text], name, { type: "text/markdown" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file] }).catch(() => undefined);
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const GROUP_MODE: Record<NonNullable<Conversation["group"]>["mode"], string> = { discuss: "Discussion", debate: "Debate", panel: "Panel" };

/** What happens when you write in a group chat, in a sentence. */
function groupIntro(members: Bot[], group: Conversation["group"], bots: Bot[]): string {
  const names = members.map((m) => m.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const rounds = group?.rounds ?? 1;
  const how =
    group?.mode === "debate"
      ? `debate it, taking turns for and against`
      : group?.mode === "panel"
        ? "each answer on their own first"
        : "discuss it, each building on the others";
  const summary = group?.summarizer ? ` Then ${bots.find((b) => b.id === group.summarizer)?.name ?? "a bot"} sums up.` : "";
  return `Write a question or a task: ${list} ${how}, ${rounds} round${rounds === 1 ? "" : "s"}.${summary}`;
}

export function ChatView({ bot, onOpenSidebar, onEditBot }: { bot: Bot; onOpenSidebar: () => void; onEditBot: () => void }) {
  const conversation = useStore((s) => (s.activeConversationId ? s.conversations[s.activeConversationId] : undefined));
  const streamingId = useStore((s) => s.streamingId);
  const provider = useStore((s) => s.providers.find((p) => p.id === bot.providerId));
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; n: number }>();
  const [atBottom, setAtBottom] = useState(true);
  const avatar = useBotAvatar(bot);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const messages = conversation?.messages ?? [];
  const busy = streamingId !== null && streamingId === conversation?.id;
  const last = messages.at(-1);
  const temporary = Boolean(conversation?.temporary);

  // Follow the reply as it streams, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content.length, last?.status, conversation?.id]);

  useEffect(() => {
    stickRef.current = true;
    setAtBottom(true);
    setEditingTitle(false);
  }, [conversation?.id]);

  // Stay pinned when content changes size without new text: errors, images, code highlighting, rotation.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMessages, conversation?.id]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const suggestions = SUGGESTIONS[bot.name] ?? SUGGESTIONS.default;
  // A group chat: its bots, in speaking order.
  const allBots = useStore((s) => s.bots);
  const members = (conversation?.members ?? []).map((id) => allBots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));
  const isGroup = members.length > 0;
  const title = conversation && (messages.length || isGroup) ? conversation.title : bot.name;

  return (
    <main className="main">
      <header className="topbar">
        <button type="button" className="icon-btn mobile-only" aria-label="Open sidebar" onClick={onOpenSidebar}>
          <Menu size={19} />
        </button>
        <div className="title">
          {isGroup ? (
            <span className="group-avatars" title={members.map((m) => m.name).join(", ")}>
              {members.slice(0, 4).map((m) => (
                <BotAvatar key={m.id} bot={m} size="mini" />
              ))}
            </span>
          ) : (
            <BotAvatar bot={bot} />
          )}
          {editingTitle && conversation ? (
            <input
              className="input title-input"
              autoFocus
              defaultValue={conversation.title}
              onBlur={(e) => {
                renameConversation(conversation.id, e.target.value);
                setEditingTitle(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditingTitle(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="title-text"
              title={conversation && messages.length ? "Rename chat" : undefined}
              onClick={() => conversation && messages.length && setEditingTitle(true)}
            >
              {title}
            </button>
          )}
          {temporary && (
            <span className="badge private-badge">
              <EyeOff size={12} /> Private
            </span>
          )}
        </div>
        {isGroup ? (
          <span className="chip group-chip" title="Each bot answers with its own model">
            {GROUP_MODE[conversation?.group?.mode ?? "discuss"]} · {conversation?.group?.rounds ?? 1} round{(conversation?.group?.rounds ?? 1) === 1 ? "" : "s"}
          </span>
        ) : (
          <button type="button" className="chip" onClick={() => setMenuOpen((v) => !v)} title="Switch model">
            <span>{bot.model || "Choose model"}</span>
            <ChevronDown size={14} />
          </button>
        )}
        <button
          type="button"
          className={`icon-btn hide-narrow${temporary ? " active-toggle" : ""}`}
          title={temporary ? "Private chat: not saved" : "New private chat (not saved)"}
          onClick={() => (temporary ? startNewChat(bot.id) : newConversation(bot.id, true))}
        >
          <EyeOff size={18} />
        </button>
        <button type="button" className="icon-btn" title="New chat (Ctrl/⌘+Shift+O)" onClick={() => startNewChat(bot.id)}>
          <SquarePen size={18} />
        </button>
        <div className="menu-anchor">
          <button type="button" className="icon-btn" title="More" onClick={() => setMoreOpen((v) => !v)}>
            <MoreHorizontal size={18} />
          </button>
          {moreOpen && (
            <div className="popover" onMouseLeave={() => setMoreOpen(false)}>
              <button type="button" className="nav-item" onClick={() => (setMoreOpen(false), onEditBot())}>
                <SlidersHorizontal size={15} /> <span className="label">Bot settings</span>
              </button>
              <button
                type="button"
                className="nav-item show-narrow"
                onClick={() => {
                  setMoreOpen(false);
                  temporary ? startNewChat(bot.id) : newConversation(bot.id, true);
                }}
              >
                <EyeOff size={15} /> <span className="label">{temporary ? "Leave private chat" : "Private chat"}</span>
              </button>
              {conversation && messages.length > 0 && (
                <>
                  <span className="nav-item">
                    <CopyButton text={conversationMarkdown(conversation.id)} label="Copy chat as Markdown" className="inline-btn" />
                  </span>
                  <button
                    type="button"
                    className="nav-item"
                    onClick={() => {
                      setMoreOpen(false);
                      void download(`${conversation.title.replace(/[^\w\- ]+/g, "").trim() || "chat"}.md`, conversationMarkdown(conversation.id));
                    }}
                  >
                    <Download size={15} /> <span className="label">Download chat</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {menuOpen && <ModelMenu bot={bot} onClose={() => setMenuOpen(false)} />}
      </header>

      {messages.length === 0 && isGroup ? (
        <div className="empty">
          <span className="group-avatars lg">
            {members.map((m) => (
              <BotAvatar key={m.id} bot={m} size="lg" />
            ))}
          </span>
          <h1>{conversation!.title}</h1>
          <div className="muted">{groupIntro(members, conversation!.group, allBots)}</div>
        </div>
      ) : messages.length === 0 ? (
        <div className="empty">
          <BotAvatar bot={bot} size="lg" />
          <h1>{temporary ? "Private chat" : `${greeting()}`}</h1>
          <div className="muted">
            {temporary ? "This chat isn't saved and won't add to memory. It disappears when you leave." : `${bot.name} · ${bot.description}`}
          </div>
          {!provider && (
            <button type="button" className="btn" onClick={onEditBot}>
              Choose a provider for this bot
            </button>
          )}
          <div className="suggestions">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => setPrefill({ text: s.replace(/\. Use search$/, ""), n: Date.now() })}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="messages-wrap">
          <div
            className="messages"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              stickRef.current = bottom;
              if (bottom !== atBottom) setAtBottom(bottom);
            }}
          >
            <div className="messages-inner">
              {messages.map((m, i) => (
                // One message with data the app can't show (an imported chat, a service's odd
                // answer) shows a note instead of taking the whole chat down.
                <ErrorBoundary key={m.id} fallback={() => <div className="msg-broken small muted">This message can't be shown.</div>}>
                  <MessageItem
                    message={m}
                    avatar={isGroup && m.role === "assistant" ? (allBots.find((b) => b.id === (m.botId ?? conversation!.botId))?.avatar ?? avatar) : avatar}
                    speaker={isGroup && m.role === "assistant" ? (allBots.find((b) => b.id === (m.botId ?? conversation!.botId))?.name ?? "A deleted bot") : undefined}
                    conversationId={conversation!.id}
                    busy={busy}
                    live={busy && i === messages.length - 1}
                  />
                </ErrorBoundary>
              ))}
            </div>
          </div>
          {!atBottom && (
            <button type="button" className="to-bottom" aria-label="Jump to latest" onClick={scrollToBottom}>
              <ArrowDown size={16} />
            </button>
          )}
        </div>
      )}

      <Composer botName={isGroup ? "the group" : bot.nickname?.trim() || bot.name} prefill={prefill} onVoiceMode={() => window.dispatchEvent(new Event("adt:voice-mode"))} />
    </main>
  );
}
