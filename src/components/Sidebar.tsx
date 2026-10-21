import { Check, Pencil, Plus, Search, Settings, SquarePen, Trash2, Users, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { MOD } from "../lib/keys";
import { createBot, deleteConversation, openConversation, renameConversation, selectBot, startNewChat, useStore } from "../lib/store";
import type { Conversation } from "../lib/types";
import { openView, useFeatureRegistry, useNav } from "../features/registry";
import { detectEnv, type Platform } from "../lib/transport";
import { Avatar, BotAvatar } from "./Avatar";

const DAY = 24 * 60 * 60 * 1000;

function groupOf(time: number): string {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (time >= startOfToday) return "Today";
  if (time >= startOfToday - DAY) return "Yesterday";
  if (time >= startOfToday - 7 * DAY) return "Previous 7 days";
  if (time >= startOfToday - 30 * DAY) return "Previous 30 days";
  return "Older";
}

/**
 * Stable summary of the chat list. During streaming the conversations object changes on every
 * paint, but titles and order don't, so the sidebar skips those renders.
 */
function chatListKey(conversations: Record<string, Conversation>): string {
  // Runs on every store change (each streamed token): reuse the last key unless a chat was added,
  // removed, renamed, moved or emptied, which is a cheap pointer-and-field check.
  if (listCache && sameListing(listCache.conversations, conversations)) {
    listCache.conversations = conversations;
    return listCache.key;
  }
  const key = Object.values(conversations)
    .filter(listed)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => `${c.id}\u0001${c.botId}\u0001${c.updatedAt}\u0001${c.title}`)
    .join("\u0002");
  listCache = { conversations, key };
  return key;
}

let listCache: { conversations: Record<string, Conversation>; key: string } | null = null;
const listed = (c: Conversation) => c.messages.length > 0 && !c.temporary;

function sameListing(before: Record<string, Conversation>, after: Record<string, Conversation>): boolean {
  if (before === after) return true;
  let count = 0;
  for (const id in after) {
    count++;
    const a = after[id];
    const b = before[id];
    if (a === b) continue;
    if (!b || listed(a) !== listed(b) || a.updatedAt !== b.updatedAt || a.title !== b.title || a.botId !== b.botId) return false;
  }
  return count === Object.keys(before).length;
}

export function Sidebar({
  open,
  onClose,
  onOpenSettings,
  onEditBot,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onEditBot: (id: string) => void;
}) {
  const bots = useStore((s) => s.bots);
  const activeBotId = useStore((s) => s.activeBotId);
  const brandName = useStore((s) => s.settings.brand.name);
  const brandLogo = useStore((s) => s.settings.brand.logo);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const listKey = useStore((s) => chatListKey(s.conversations));
  const [query, setQuery] = useState("");
  const views = useFeatureRegistry((s) => s.views);
  const activeView = useNav((s) => s.view);
  const [platform, setPlatform] = useState<Platform | null>(null);
  useEffect(() => {
    void detectEnv().then((env) => setPlatform(env.platform));
  }, []);
  const visibleViews = views.filter((v) => !v.platforms || (platform && v.platforms.includes(platform)));
  const [renaming, setRenaming] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);

  const logoAvatar = useStore((s) => (s.settings.brand.logoAsAvatar && s.settings.brand.logo) || "");
  const avatars = useMemo(
    () => Object.fromEntries(bots.map((b, i) => [b.id, i === 0 && logoAvatar ? logoAvatar : b.avatar])),
    [bots, logoAvatar],
  );

  const groups = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const { conversations } = useStore.getState();
    const rows = listKey
      ? listKey.split("\u0002").map((row) => {
          const [id, botId, updatedAt, title] = row.split("\u0001");
          return { id, botId, updatedAt: Number(updatedAt), title };
        })
      : [];
    const matches = q
      ? rows.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            conversations[r.id]?.messages.some((m) => m.content.toLowerCase().includes(q)),
        )
      : rows;
    const out: { label: string; chats: typeof rows }[] = [];
    for (const chat of matches) {
      const label = groupOf(chat.updatedAt);
      if (out.at(-1)?.label !== label) out.push({ label, chats: [] });
      out.at(-1)!.chats.push(chat);
    }
    return out;
  }, [listKey, deferredQuery]);

  const activeBot = bots.find((b) => b.id === activeBotId);

  return (
    <>
      <div className={`scrim${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Bots and chats">
        <div className="sidebar-head">
          <img src={brandLogo || "./icon.svg"} alt="" />
          <strong>{brandName || "ADT Bot"}</strong>
        </div>
        <div className="sidebar-actions">
          <button
            type="button"
            className="btn new-chat"
            onClick={() => {
              if (activeBot) startNewChat(activeBot.id);
              openView(null);
              onClose();
            }}
          >
            <SquarePen size={16} /> New chat
            <kbd className="hide-touch">{MOD === "⌘" ? "⇧⌘O" : "Ctrl+Shift+O"}</kbd>
          </button>
          <label className="search-box">
            <Search size={15} className="muted" />
            <input
              id="chat-search"
              placeholder="Search chats"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            />
            {query ? (
              <button type="button" className="row-action" style={{ opacity: 1 }} aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            ) : (
              <kbd className="hide-touch">{MOD}K</kbd>
            )}
          </label>
        </div>
        <div className="sidebar-scroll">
          {!query && visibleViews.length > 0 && (
            <>
              <div className="section-label">Workspace</div>
              {visibleViews.map((view) => {
                const Icon = view.icon;
                return (
                  <button
                    key={view.id}
                    type="button"
                    className={`nav-item${activeView === view.id ? " active" : ""}`}
                    onClick={() => {
                      openView(view.id);
                      onClose();
                    }}
                  >
                    <span className="nav-icon">
                      <Icon size={16} />
                    </span>
                    <span className="label">{view.label}</span>
                  </button>
                );
              })}
            </>
          )}
          {!query && (
            <>
              <div className="section-label">
                Bots
                <button
                  type="button"
                  className="row-action"
                  style={{ opacity: 1, marginLeft: "auto" }}
                  title="New group chat: bots talk it through together"
                  aria-label="New group chat"
                  onClick={() => {
                    window.dispatchEvent(new Event("adt:new-group"));
                    onClose();
                  }}
                >
                  <Users size={15} />
                </button>
                <button
                  type="button"
                  className="row-action"
                  style={{ opacity: 1 }}
                  title="New bot"
                  onClick={() => {
                    const bot = createBot();
                    onEditBot(bot.id);
                    onClose();
                  }}
                >
                  <Plus size={15} />
                </button>
              </div>
              {bots.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  className={`nav-item${bot.id === activeBotId && !activeConversationId && !activeView ? " active" : ""}`}
                  onClick={() => {
                    selectBot(bot.id);
                    openView(null);
                    onClose();
                  }}
                >
                  <BotAvatar bot={bot} />
                  <span className="label">{bot.name}</span>
                  {bot.id === activeBotId && <span className="dot" aria-label="Current bot" />}
                </button>
              ))}
            </>
          )}

          {groups.length === 0 && (
            <div className="small muted" style={{ padding: "14px 8px" }}>
              {query ? "No chats match your search." : "Your chats will appear here."}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="section-label">{group.label}</div>
              {group.chats.map((c) =>
                renaming === c.id ? (
                  <form
                    key={c.id}
                    className="nav-item rename-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      renameConversation(c.id, new FormData(e.currentTarget).get("title") as string);
                      setRenaming(null);
                    }}
                  >
                    <input
                      name="title"
                      className="input"
                      autoFocus
                      defaultValue={c.title}
                      onBlur={(e) => {
                        renameConversation(c.id, e.target.value);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    />
                    <button type="submit" className="row-action" style={{ opacity: 1 }} aria-label="Save name">
                      <Check size={14} />
                    </button>
                  </form>
                ) : (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    className={`nav-item${c.id === activeConversationId && !activeView ? " active" : ""}`}
                    onClick={() => {
                      openConversation(c.id);
                      openView(null);
                      onClose();
                    }}
                    onKeyDown={(e) => e.key === "Enter" && openConversation(c.id)}
                    onDoubleClick={() => setRenaming(c.id)}
                  >
                    <Avatar value={avatars[c.botId] ?? "•"} size="mini" />
                    <span className="label">{c.title}</span>
                    <button
                      type="button"
                      className="row-action"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenaming(c.id);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="row-action"
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${c.title}"?`)) deleteConversation(c.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
          >
            <Settings size={17} />
            <span className="label">Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}
