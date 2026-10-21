import { Download, Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { Dialog } from "../../components/Dialog";
import { pickFiles, saveTextFile } from "../../lib/files";
import { selectBot, useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { loadRoutines, useRoutines } from "../automation/routines-store";
import { describeSchedule } from "../automation/schedule";
import { openView } from "../registry";
import { skillsFor } from "../skills/skills";
import { gallery } from "./gallery";
import { type BotTemplate, buildTemplate, installTemplate, parseTemplate, type TemplateChoice, templateFileName } from "./template";
import "./templates.css";

/** Everything a template would add, shown in full before adding it. */
function TemplatePreview({ template, trusted, onClose }: { template: BotTemplate; trusted: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ bot: Bot; notes: string[] } | null>(null);
  const [error, setError] = useState("");
  const add = async () => {
    setBusy(true);
    try {
      setDone(await installTemplate(template, trusted));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const { bot } = template;
  return (
    <Dialog title={done ? `${bot.name} is ready` : `Add ${bot.name}`} onClose={onClose}>
      {done ? (
        <div className="template-preview">
          <p>{done.bot.name} was added to your bots.</p>
          {done.notes.length > 0 && (
            <ul className="small muted">
              {done.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <div className="btn-row">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                selectBot(done.bot.id);
                openView(null);
                onClose();
              }}
            >
              Chat with {done.bot.name}
            </button>
          </div>
        </div>
      ) : (
        <div className="template-preview">
          <div className="template-who">
            <Avatar value={bot.avatar} size="lg" />
            <div>
              <strong>{bot.name}</strong>
              <p className="small muted">{bot.description}</p>
            </div>
          </div>
          {!trusted && (
            <p className="notice small">
              Only add templates from people you trust. Read its instructions and routines below: the bot will follow them. Its routines arrive
              switched off, and its skills are marked "not checked" until you've read them.
            </p>
          )}
          <h3>Instructions</h3>
          <pre className="template-text">{bot.systemPrompt || "(none)"}</pre>
          {template.memory.length > 0 && (
            <>
              <h3>Memories ({template.memory.length})</h3>
              <ul className="small">
                {template.memory.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          {template.skills.length > 0 && (
            <>
              <h3>Skills ({template.skills.length})</h3>
              {template.skills.map((s) => (
                <details key={s.name} className="small">
                  <summary>
                    <code>/{s.name}</code> {s.description}
                  </summary>
                  <pre className="template-text">{s.instructions}</pre>
                </details>
              ))}
            </>
          )}
          {template.routines.length > 0 && (
            <>
              <h3>Routines ({template.routines.length}, off until you switch them on)</h3>
              <ul className="small">
                {template.routines.map((r) => (
                  <li key={r.name}>
                    <strong>{r.name}</strong> ({describeSchedule(r.schedule)}): <code>{r.instruction.slice(0, 300)}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {template.knowledge.length > 0 && (
            <>
              <h3>Knowledge files ({template.knowledge.length})</h3>
              <ul className="small">
                {template.knowledge.map((k) => (
                  <li key={k.name}>
                    {k.name} ({Math.round(k.text.length / 1000)}k characters)
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="small muted">
            Tools: {bot.toolGroups === "all" || !bot.toolGroups ? "all" : bot.toolGroups.join(", ") || "none"}
            {bot.model ? ` · made for ${bot.model.model}` : ""}
          </p>
          {error && <p className="error-text small">{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void add()}>
              <Plus size={15} /> Add bot
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** "Share as template": pick what goes in, then save the file. Chats, keys and logins never do. */
export function TemplateExportDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const skills = useStore((s) => skillsFor(bot, s.skills));
  const routines = useRoutines((s) => s.routines.filter((r) => r.botId === bot.id));
  useEffect(() => void loadRoutines(), []);
  const [choice, setChoice] = useState<TemplateChoice>({
    memory: [],
    skillIds: skills.filter((s) => s.bots !== "all").map((s) => s.id),
    routineIds: [],
    knowledgeIds: [],
    model: true,
  });
  const toggle = (key: "memory" | "skillIds" | "routineIds" | "knowledgeIds", id: string, on: boolean) =>
    setChoice((c) => ({ ...c, [key]: on ? [...c[key], id] : c[key].filter((x) => x !== id) }));
  const save = async () => {
    const template = await buildTemplate(bot, choice);
    await saveTextFile(templateFileName(bot), JSON.stringify(template, null, 2), "application/json");
    onClose();
  };
  const section = (title: string, key: "memory" | "skillIds" | "routineIds" | "knowledgeIds", items: { id: string; label: string }[]) =>
    items.length > 0 && (
      <div className="field">
        <label>{title}</label>
        {items.map((item) => (
          <label key={item.id} className="toggle compact">
            <input type="checkbox" checked={choice[key].includes(item.id)} onChange={(e) => toggle(key, item.id, e.target.checked)} />
            <span className="small">{item.label}</span>
          </label>
        ))}
      </div>
    );
  return (
    <Dialog title={`Share ${bot.name} as a template`} onClose={onClose}>
      <div className="template-preview">
        <p className="small muted">
          The file holds {bot.name}'s name, picture, instructions and settings, plus what you tick below. Chats, API keys, logins and other
          bots never go in.
        </p>
        {section(
          "Memories (personal: off unless you tick them)",
          "memory",
          bot.memory.map((m) => ({ id: m, label: m })),
        )}
        {section(
          "Skills",
          "skillIds",
          skills.map((s) => ({ id: s.id, label: `/${s.name}: ${s.description}` })),
        )}
        {section(
          "Routines",
          "routineIds",
          routines.map((r) => ({ id: r.id, label: `${r.name} (${describeSchedule(r.schedule)})` })),
        )}
        {section(
          "Knowledge files",
          "knowledgeIds",
          (bot.knowledge ?? []).map((k) => ({ id: k.id, label: k.name })),
        )}
        <label className="toggle compact">
          <input type="checkbox" checked={choice.model} onChange={(e) => setChoice((c) => ({ ...c, model: e.target.checked }))} />
          <span className="small">Say which model it uses ({bot.model || "none"})</span>
        </label>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
            <Download size={15} /> Save template
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default function TemplatesView() {
  const [preview, setPreview] = useState<{ template: BotTemplate; trusted: boolean } | null>(null);
  const [error, setError] = useState("");
  const entries = gallery();
  const importFile = async () => {
    setError("");
    const [file] = await pickFiles(".json,application/json");
    if (!file) return;
    try {
      if (file.size > 25_000_000) throw new Error("That file is too large for a bot template.");
      setPreview({ template: parseTemplate(await file.text()), trusted: false });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="templates-view">
      <div className="templates-head">
        <p className="muted small grow">
          Ready-made bots with a job, the skills for it and routines (off until you switch them on). Add one, then change anything in its
          settings. Share your own bots from their settings ("Share as template").
        </p>
        <button type="button" className="btn" onClick={() => void importFile()}>
          <Upload size={15} /> Import a template
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
      <ul className="template-grid">
        {entries.map(({ id, template }) => (
          <li key={id} className="template-card">
            <div className="template-who">
              <Avatar value={template.bot.avatar} size="lg" />
              <div>
                <strong>{template.bot.name}</strong>
                <p className="small muted">{template.bot.description}</p>
              </div>
            </div>
            <p className="small muted template-includes">
              {[...template.skills.map((s) => `/${s.name}`), ...template.routines.map((r) => `${r.name} (${describeSchedule(r.schedule)})`)].join(" · ")}
            </p>
            <button type="button" className="btn" onClick={() => setPreview({ template, trusted: true })}>
              <Plus size={15} /> Add
            </button>
          </li>
        ))}
      </ul>
      {preview && <TemplatePreview template={preview.template} trusted={preview.trusted} onClose={() => setPreview(null)} />}
    </div>
  );
}
