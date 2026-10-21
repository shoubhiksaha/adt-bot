import { Check, Download, Pencil, Share2, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { BotAvatar } from "../../components/Avatar";
import { pickFiles, saveTextFile } from "../../lib/files";
import { updateBot, updateSettings, useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { matches, memoryMarkdown, parseMemoryText } from "./memory";
import "./memory.css";

/** One remembered fact: shown, edited in place, deleted, or shared with every bot. */
function Fact({ text, onSave, onDelete, onShare }: { text: string; onSave: (text: string) => void; onDelete: () => void; onShare?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const save = () => {
      const clean = draft.trim();
      if (clean && clean !== text) onSave(clean);
      setDraft(null);
    };
    return (
      <li className="fact editing">
        <input
          className="input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setDraft(null);
          }}
        />
        <button type="button" className="icon-btn" aria-label="Save" onClick={save}>
          <Check size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => setDraft(null)}>
          <X size={15} />
        </button>
      </li>
    );
  }
  return (
    <li className="fact">
      <span>{text}</span>
      {onShare && (
        <button type="button" className="icon-btn" title="Every bot should know this" aria-label="Share with every bot" onClick={onShare}>
          <Share2 size={14} />
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Edit" onClick={() => setDraft(text)}>
        <Pencil size={14} />
      </button>
      <button type="button" className="icon-btn" aria-label="Forget" onClick={onDelete}>
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function AddFact({ placeholder, onAdd }: { placeholder: string; onAdd: (fact: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="input-group"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd(text.trim());
        setText("");
      }}
    >
      <input className="input" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn" type="submit">
        Add
      </button>
    </form>
  );
}

const replaceAt = (list: string[], i: number, text: string) => list.map((f, j) => (j === i ? text : f));

export default function MemoryView() {
  const bots = useStore((s) => s.bots);
  const shared = useStore((s) => s.settings.sharedMemory ?? []);
  const [query, setQuery] = useState("");
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const [importTarget, setImportTarget] = useState("shared");
  const [notice, setNotice] = useState("");

  const setShared = (sharedMemory: string[]) => updateSettings({ sharedMemory });
  const total = shared.length + bots.reduce((n, b) => n + b.memory.length, 0);
  const notes = bots.reduce((n, b) => n + (b.journal?.length ?? 0), 0);
  const visible = useMemo(() => (facts: string[]) => facts.map((text, i) => ({ text, i })).filter((f) => matches(f.text, query)), [query]);

  const importFile = async () => {
    const [file] = await pickFiles(".md,.txt,.markdown,text/plain,text/markdown");
    if (!file) return;
    const facts = parseMemoryText(await file.text());
    if (!facts.length) return setNotice(`No facts found in ${file.name}.`);
    if (importTarget === "shared") setShared([...shared, ...facts.filter((f) => !shared.includes(f))]);
    else {
      const bot = bots.find((b) => b.id === importTarget);
      if (bot) updateBot(bot.id, { memory: [...bot.memory, ...facts.filter((f) => !bot.memory.includes(f))] });
    }
    setNotice(`Added ${facts.length} fact${facts.length === 1 ? "" : "s"} from ${file.name}.`);
  };

  const botSection = (bot: Bot) => {
    const facts = visible(bot.memory);
    const journal = (bot.journal ?? []).filter((n) => matches(`${n.title} ${n.summary}`, query));
    if (query && !facts.length && !journal.length) return null;
    return (
      <section key={bot.id} className="memory-section">
        <header>
          <BotAvatar bot={bot} size="mini" />
          <h2>{bot.name}</h2>
          <span className="muted small">
            {bot.memory.length} fact{bot.memory.length === 1 ? "" : "s"}
            {bot.journal?.length ? `, ${bot.journal.length} note${bot.journal.length === 1 ? "" : "s"}` : ""}
          </span>
          <label className="toggle compact learn-toggle" title="Save lasting facts and notes on finished chats">
            <input type="checkbox" checked={bot.autoMemory} onChange={(e) => updateBot(bot.id, { autoMemory: e.target.checked })} />
            <span className="small">Learns from chats</span>
          </label>
        </header>
        <ul className="fact-list">
          {facts.map(({ text, i }) => (
            <Fact
              key={`${i}-${text}`}
              text={text}
              onSave={(t) => updateBot(bot.id, { memory: replaceAt(bot.memory, i, t) })}
              onDelete={() => updateBot(bot.id, { memory: bot.memory.filter((_, j) => j !== i) })}
              onShare={() => {
                if (!shared.includes(text)) setShared([...shared, text]);
                updateBot(bot.id, { memory: bot.memory.filter((_, j) => j !== i) });
              }}
            />
          ))}
          {!bot.memory.length && <li className="muted small">Nothing yet.</li>}
        </ul>
        {!query && <AddFact placeholder={`Something ${bot.name} should remember`} onAdd={(f) => updateBot(bot.id, { memory: [...bot.memory, f] })} />}
        {journal.length > 0 && (
          <div className="notes">
            <button type="button" className="link-btn" onClick={() => setOpenNotes((o) => ({ ...o, [bot.id]: !o[bot.id] }))}>
              {openNotes[bot.id] || query ? "Hide" : "Show"} notes on past chats ({journal.length})
            </button>
            {(openNotes[bot.id] || query) && (
              <ul className="fact-list">
                {[...journal].reverse().map((n) => (
                  <li key={n.conversationId} className="fact note">
                    <span>
                      <strong>{n.title}</strong> <span className="muted small">{new Date(n.at).toLocaleDateString()}</span>
                      <br />
                      <span className="small">{n.summary}</span>
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Forget this note"
                      onClick={() => updateBot(bot.id, { journal: (bot.journal ?? []).filter((e) => e.conversationId !== n.conversationId) })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    );
  };

  const sharedFacts = visible(shared);
  return (
    <div className="memory-view">
      <p className="muted small">
        What your bots know about you: {total} fact{total === 1 ? "" : "s"} and {notes} note{notes === 1 ? "" : "s"} on past chats, all kept on this device.
        Bots learn these as you talk (when "Learns from chats" is on); edit or delete anything here.
      </p>
      <div className="memory-tools">
        <input className="input" type="search" placeholder="Search memories and notes" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn" onClick={() => void saveTextFile(`adt-bot-memory-${new Date().toISOString().slice(0, 10)}.md`, memoryMarkdown(bots, shared), "text/markdown")}>
          <Download size={15} /> Export
        </button>
        <select className="input import-target" value={importTarget} onChange={(e) => setImportTarget(e.target.value)} aria-label="Import into">
          <option value="shared">Import into: every bot</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              Import into: {b.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void importFile()}>
          <Upload size={15} /> Import
        </button>
      </div>
      {notice && <p className="small muted">{notice}</p>}

      {(!query || sharedFacts.length > 0) && (
        <section className="memory-section shared">
          <header>
            <h2>Every bot</h2>
            <span className="muted small">Facts all your bots know (your name, family, where you live, what you do)</span>
          </header>
          <ul className="fact-list">
            {sharedFacts.map(({ text, i }) => (
              <Fact
                key={`${i}-${text}`}
                text={text}
                onSave={(t) => setShared(replaceAt(shared, i, t))}
                onDelete={() => setShared(shared.filter((_, j) => j !== i))}
              />
            ))}
            {!shared.length && <li className="muted small">Nothing yet. Bots add facts here when every bot should know them.</li>}
          </ul>
          {!query && <AddFact placeholder="e.g. I live in Kolkata and work as a designer" onAdd={(f) => !shared.includes(f) && setShared([...shared, f])} />}
        </section>
      )}
      {bots.map(botSection)}
    </div>
  );
}
