import { FileUp, ImagePlus, Share, Trash2, X } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { allToolGroups } from "../lib/agent/tools";
import { fileText } from "../lib/images";
import { presetById } from "../lib/providers";
import { deleteBot, updateBot, useStore } from "../lib/store";
import type { Bot, ThinkingLevel } from "../lib/types";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialog";
import { KNOWLEDGE_ACCEPT, KnowledgeFiles } from "./KnowledgeFiles";
import { ModelField } from "./ModelField";

const TemplateExportDialog = lazy(() => import("../features/templates/TemplatesView").then((m) => ({ default: m.TemplateExportDialog })));
const BotEmailField = lazy(() => import("../features/apps/BotEmailField"));

export default function BotDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === botId));
  const providers = useStore((s) => s.providers);
  const [newMemory, setNewMemory] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const pictureInput = useRef<HTMLInputElement>(null);
  if (!bot) return null;

  const provider = providers.find((p) => p.id === bot.providerId);
  const set = (patch: Partial<Bot>) => updateBot(bot.id, patch);

  return (
    <Dialog title={`${bot.name} settings`} onClose={onClose}>
      <div className="field-row">
        <div className="field" style={{ flex: "0 0 112px" }}>
          <label htmlFor="bot-avatar">Picture</label>
          <div className="input-group" style={{ alignItems: "center" }}>
            <button type="button" className="avatar-pick" title="Upload a picture" onClick={() => pictureInput.current?.click()}>
              <Avatar value={bot.avatar} />
              <ImagePlus size={12} className="avatar-pick-icon" />
            </button>
            {!bot.avatar.startsWith("data:") && (
              <input id="bot-avatar" className="input" style={{ width: 52 }} maxLength={4} value={bot.avatar} onChange={(e) => set({ avatar: e.target.value })} aria-label="Emoji or letters" />
            )}
            {bot.avatar.startsWith("data:") && (
              <button type="button" className="icon-btn" aria-label="Remove picture" onClick={() => set({ avatar: "✦" })}>
                <X size={14} />
              </button>
            )}
          </div>
          <input
            ref={pictureInput}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) set({ avatar: await squareImage(file, 96) });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="bot-name">Name</label>
          <input id="bot-name" className="input" value={bot.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="bot-nickname">Nickname / wake word</label>
          <input
            id="bot-nickname"
            className="input"
            placeholder={`e.g. Jarvis`}
            value={bot.nickname ?? ""}
            onChange={(e) => set({ nickname: e.target.value })}
          />
        </div>
      </div>
      <p className="small muted" style={{ marginTop: -6 }}>
        Say “Hey {bot.nickname?.trim() || bot.name}” for hands-free voice, or “switch to {bot.nickname?.trim() || bot.name}” in voice mode.
      </p>
      <div className="field">
        <label>Description</label>
        <input className="input" value={bot.description} onChange={(e) => set({ description: e.target.value })} />
      </div>

      <div className="field">
        <label>Provider</label>
        <select
          className="select"
          value={bot.providerId}
          onChange={(e) => {
            const next = providers.find((p) => p.id === e.target.value);
            set({
              providerId: e.target.value,
              model: presetById(next?.presetId ?? "")?.defaultModel || next?.models[0]?.id || "",
            });
          }}
        >
          {!provider && <option value="">Choose a provider…</option>}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <ModelField provider={provider} value={bot.model} onChange={(model) => set({ model })} />

      <div className="field-row">
        <div className="field">
          <label>Thinking / reasoning</label>
          <select
            className="select"
            value={bot.thinking}
            onChange={(e) => set({ thinking: e.target.value as ThinkingLevel })}
          >
            <option value="off">Model default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div className="field">
          <label>
            Temperature{" "}
            <span className="muted small">{bot.temperature === null ? "(model default)" : bot.temperature.toFixed(1)}</span>
          </label>
          <div className="input-group" style={{ alignItems: "center" }}>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              style={{ flex: 1 }}
              value={bot.temperature ?? 1}
              onChange={(e) => set({ temperature: Number(e.target.value) })}
            />
            <button type="button" className="btn" onClick={() => set({ temperature: null })}>
              Default
            </button>
          </div>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: -6 }}>
        Only set reasoning for models that support it. Some providers reject temperature for reasoning models.
      </p>

      <label className="toggle">
        <input type="checkbox" checked={bot.autoMemory} onChange={(e) => set({ autoMemory: e.target.checked })} />
        <span>
          <strong>Learn from our chats</strong>
          <br />
          <span className="small muted">
            Saves lasting facts and preferences you mention and, once a chat goes quiet, a short note on what it was about, so later chats
            can pick it up. Uses one short request to this bot's model per chat. Private chats are never learned from; everything below can
            be deleted.
          </span>
        </span>
      </label>
      <div className="field">
        <label htmlFor="bot-prompt">Personality & instructions</label>
        <textarea
          id="bot-prompt"
          className="textarea"
          rows={7}
          value={bot.systemPrompt}
          onChange={(e) => set({ systemPrompt: e.target.value })}
        />
        <label className="link-btn" style={{ marginBottom: 0 }}>
          <FileUp size={14} /> Load instructions from a file (what this bot is for, its rules, tone…)
          <input
            type="file"
            hidden
            accept={KNOWLEDGE_ACCEPT}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const text = (await fileText(file)).trim();
                if (text.length > 8000) {
                  setNotice(`${file.name} is long, so it was added below as knowledge instead of instructions.`);
                  const { saveKnowledgeText } = await import("../lib/knowledge");
                  const ref = await saveKnowledgeText(file.name, text, file.size);
                  set({ knowledge: [...(bot.knowledge ?? []), ref] });
                } else {
                  set({ systemPrompt: `${bot.systemPrompt.trim()}\n\n${text}`.trim() });
                  setNotice(`Added the instructions from ${file.name}.`);
                }
              } catch (error) {
                setNotice((error as Error).message);
              }
            }}
          />
        </label>
        {notice && <span className="small muted">{notice}</span>}
      </div>

      <div className="field">
        <label>Tools this bot can use</label>
        <div className="tool-groups">
          {allToolGroups().map((group) => {
            const groupsOn = bot.toolGroups ?? "all";
            const on = groupsOn === "all" || groupsOn.includes(group.id);
            return (
              <label key={group.id} className="toggle compact" title={group.description}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const current = groupsOn === "all" ? allToolGroups().map((g) => g.id) : groupsOn;
                    const next = e.target.checked ? [...new Set([...current, group.id])] : current.filter((id) => id !== group.id);
                    set({ toolGroups: next.length === allToolGroups().length ? "all" : next });
                  }}
                />
                <span>
                  {group.label}
                  {group.platforms?.includes("desktop") && group.platforms.length === 1 && <span className="badge">desktop</span>}
                </span>
              </label>
            );
          })}
        </div>
        <span className="small muted">Actions that change things ask for approval first (Settings → Tools & safety).</span>
      </div>

      <Suspense fallback={null}>
        <BotEmailField bot={bot} />
      </Suspense>

      <div className="field">
        <label>Knowledge for this bot ({bot.knowledge?.length ?? 0})</label>
        <KnowledgeFiles
          refs={bot.knowledge ?? []}
          onChange={(knowledge) => set({ knowledge })}
          hint="Files only this bot uses, on top of the shared knowledge in Settings → Workspace."
        />
      </div>

      <div className="field">
        <label>Memory ({bot.memory.length})</label>
        {bot.memory.length > 0 ? (
          <ul className="memory-list">
            {bot.memory.map((m, i) => (
              <li key={`${i}-${m}`}>
                <span>{m}</span>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 26, height: 26 }}
                  aria-label="Forget"
                  onClick={() => set({ memory: bot.memory.filter((_, j) => j !== i) })}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="small muted">
            Nothing yet. Type <code>/remember …</code> in chat or add a fact here.
          </span>
        )}
        <form
          className="input-group"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newMemory.trim()) return;
            set({ memory: [...bot.memory, newMemory.trim()] });
            setNewMemory("");
          }}
        >
          <input
            className="input"
            placeholder="e.g. I prefer metric units"
            value={newMemory}
            onChange={(e) => setNewMemory(e.target.value)}
          />
          <button className="btn" type="submit">
            Add
          </button>
        </form>
      </div>

      {(bot.journal?.length ?? 0) > 0 && (
        <div className="field">
          <label>Notes on past chats ({bot.journal!.length})</label>
          <ul className="memory-list journal-list">
            {[...bot.journal!].reverse().map((entry) => (
              <li key={entry.conversationId}>
                <span>
                  <strong>{entry.title}</strong> <span className="small muted">{new Date(entry.at).toLocaleDateString()}</span>
                  <br />
                  <span className="small">{entry.summary}</span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 26, height: 26 }}
                  aria-label="Forget this note"
                  onClick={() => set({ journal: bot.journal!.filter((e) => e.conversationId !== entry.conversationId) })}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" onClick={() => confirm(`Forget all of ${bot.name}'s notes on past chats?`) && set({ journal: [] })}>
            Forget all notes
          </button>
        </div>
      )}

      <div className="btn-row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (confirm(`Delete ${bot.name} and all of its chats?`)) {
              deleteBot(bot.id);
              onClose();
            }
          }}
        >
          <Trash2 size={14} /> Delete bot
        </button>
        <button type="button" className="btn" onClick={() => setSharing(true)} title="Save this bot's setup as a file others can add">
          <Share size={14} /> Share as template
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
      {sharing && (
        <Suspense fallback={null}>
          <TemplateExportDialog bot={bot} onClose={() => setSharing(false)} />
        </Suspense>
      )}
    </Dialog>
  );
}

/** Center-cropped square picture as a small data URL. */
async function squareImage(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL("image/png");
}
