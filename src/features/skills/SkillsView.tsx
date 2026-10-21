import { Download, Pencil, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { confirmThen } from "../../components/Confirm";
import { Dialog } from "../../components/Dialog";
import { pickFiles, saveTextFile } from "../../lib/files";
import { useStore } from "../../lib/store";
import type { Skill } from "../../lib/types";
import { addSkill, deleteSkill, parseSkillMarkdown, skillMarkdown, skillName, updateSkill, validateSkill } from "./skills";
import "./skills.css";

const SOURCE: Record<Skill["source"], string> = { user: "", bot: "saved by a bot", imported: "imported", recorded: "recorded" };

const EXAMPLE = `When to use: …

1. …
2. …

Check: …
Return: …
Ask the user first before: sending, paying, deleting.`;

function SkillEditor({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const [draft, setDraft] = useState({
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    instructions: skill?.instructions ?? "",
    bots: skill?.bots ?? ("all" as Skill["bots"]),
  });
  const [error, setError] = useState("");
  const set = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError("");
  };
  const save = () => {
    const input = { ...draft, name: skillName(draft.name) };
    const problem = validateSkill(input, useStore.getState().skills, skill?.id);
    if (problem) return setError(problem);
    try {
      if (skill) updateSkill(skill.id, input);
      else addSkill({ ...input, source: "user" });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const chosen = draft.bots === "all" ? bots.map((b) => b.id) : draft.bots;
  return (
    <Dialog title={skill ? `Edit /${skill.name}` : "New skill"} onClose={onClose}>
      <div className="skill-form">
        <div className="field">
          <label htmlFor="skill-name">Name</label>
          <input
            id="skill-name"
            className="input"
            value={draft.name}
            placeholder="weekly-report"
            onChange={(e) => set({ name: e.target.value })}
            onBlur={() => set({ name: skillName(draft.name) })}
          />
          <span className="small muted">Type /{skillName(draft.name) || "name"} in a message to use it.</span>
        </div>
        <div className="field">
          <label htmlFor="skill-description">When to use it</label>
          <input
            id="skill-description"
            className="input"
            value={draft.description}
            placeholder="Writing the Friday status report from this week's tasks and emails"
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="skill-instructions">How to do it</label>
          <textarea
            id="skill-instructions"
            className="textarea mono"
            rows={12}
            value={draft.instructions}
            placeholder={EXAMPLE}
            onChange={(e) => set({ instructions: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Bots that can use it</label>
          <div className="tool-groups">
            <label className="toggle compact">
              <input type="checkbox" checked={draft.bots === "all"} onChange={(e) => set({ bots: e.target.checked ? "all" : bots.map((b) => b.id) })} />
              <span>All bots</span>
            </label>
            {draft.bots !== "all" &&
              bots.map((b) => (
                <label key={b.id} className="toggle compact">
                  <input
                    type="checkbox"
                    checked={chosen.includes(b.id)}
                    onChange={(e) => set({ bots: e.target.checked ? [...chosen, b.id] : chosen.filter((id) => id !== b.id) })}
                  />
                  <span>{b.name}</span>
                </label>
              ))}
          </div>
        </div>
        {error && <p className="error-text small">{error}</p>}
        <div className="btn-row dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default function SkillsView() {
  const skills = useStore((s) => s.skills);
  const bots = useStore((s) => s.bots);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [notice, setNotice] = useState("");

  const importFiles = async () => {
    const files = await pickFiles(".md,.markdown,.txt,text/markdown,text/plain", true);
    const added: string[] = [];
    const problems: string[] = [];
    for (const file of files) {
      try {
        if (file.size > 200_000) throw new Error("too large");
        const input = parseSkillMarkdown(await file.text(), file.name);
        // A name that's taken gets a number, rather than replacing your skill.
        let name = input.name;
        for (let n = 2; useStore.getState().skills.some((s) => s.name === name); n++) name = `${input.name}-${n}`;
        addSkill({ ...input, name, source: "imported", outside: true });
        added.push(`/${name}`);
      } catch (error) {
        problems.push(`${file.name}: ${(error as Error).message}`);
      }
    }
    setNotice(
      [added.length ? `Imported ${added.join(", ")}. Check the steps, then mark them as checked.` : "", problems.join(" ")].filter(Boolean).join(" "),
    );
  };

  const botNames = (skill: Skill) => (skill.bots === "all" ? "All bots" : skill.bots.map((id) => bots.find((b) => b.id === id)?.name).filter(Boolean).join(", ") || "No bots");

  return (
    <div className="skills-view">
      <div className="skills-head">
        <p className="muted small grow">
          Skills are how-tos your bots reuse: the steps for a weekly report, how you like trips planned, how to file an expense. Bots pick
          the right one for a task, or type <code>/name</code> to hand one over. Ask a bot to "save this as a skill" after a task goes well.
          Skills use the SKILL.md format, so you can bring them from other AI agents.
        </p>
        <button type="button" className="btn" onClick={() => void importFiles()}>
          <Upload size={15} /> Import
        </button>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> New skill
        </button>
      </div>
      {notice && <p className="small muted">{notice}</p>}
      {skills.length === 0 ? (
        <div className="skills-empty">
          <h2>No skills yet</h2>
          <p className="muted small">Write one, import a SKILL.md file, or ask a bot to save a task it just did as a skill.</p>
        </div>
      ) : (
        <ul className="skill-list">
          {[...skills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((skill) => (
              <li key={skill.id} className="skill-card">
                <div className="skill-main">
                  <div className="skill-title">
                    <code>/{skill.name}</code>
                    {SOURCE[skill.source] && <span className="badge">{SOURCE[skill.source]}</span>}
                    {skill.outside && (
                      <span className="badge warn" title="Its steps came from a file or from a chat that read outside content, so bots treat them as information and ask before commands.">
                        not checked
                      </span>
                    )}
                  </div>
                  <p className="small">{skill.description}</p>
                  <p className="small muted">{botNames(skill)}</p>
                </div>
                <div className="skill-actions">
                  {skill.outside && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="I've read the steps: treat them as my own"
                      aria-label="Mark as checked"
                      onClick={() => updateSkill(skill.id, { outside: false })}
                    >
                      <ShieldCheck size={16} />
                    </button>
                  )}
                  <button type="button" className="icon-btn" aria-label="Edit" onClick={() => setEditing(skill)}>
                    <Pencil size={16} />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Export as SKILL.md" title="Export as SKILL.md" onClick={() => void saveTextFile(`${skill.name}.md`, skillMarkdown(skill), "text/markdown")}>
                    <Download size={16} />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Delete" onClick={() => confirmThen({ message: `Delete the skill /${skill.name}?`, confirm: "Delete", danger: true }, () => deleteSkill(skill.id))}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
        </ul>
      )}
      {editing && <SkillEditor skill={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
