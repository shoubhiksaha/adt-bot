import { Loader2, Settings2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { Dialog } from "../../components/Dialog";
import { allToolGroups } from "../../lib/agent/tools";
import { selectBot, useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { openView } from "../registry";
import { type BotDraft, canWriteDraft, draftTemplate, EMPTY_DRAFT, writeDraft } from "./custom";
import { installTemplate } from "./template";

const IDEAS = [
  "A study coach: quizzes me on my notes and explains what I get wrong, simply",
  "Answers customer emails politely in my shop's voice, and asks me before sending",
  "Plans healthy vegetarian dinners for a family of four, with a shopping list",
];

/** "Create your own bot": describe it (the user's model writes it) or fill it in, check it, add it. */
export function CustomBotDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<"describe" | "edit" | "done">("describe");
  const [idea, setIdea] = useState("");
  const [draft, setDraft] = useState<BotDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState<Bot | null>(null);
  // Re-read when providers change (one may be added while this is open).
  const canWrite = useStore((s) => s.providers.length > 0 && canWriteDraft());
  const writing = useRef<AbortController | null>(null);
  useEffect(() => () => writing.current?.abort(), []);

  const write = async () => {
    setBusy(true);
    setError("");
    const controller = new AbortController();
    writing.current = controller;
    try {
      setDraft(await writeDraft(idea, controller.signal));
      setStep("edit");
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setMade((await installTemplate(draftTemplate(draft), true)).bot);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<BotDraft>) => setDraft((d) => ({ ...d, ...patch }));

  if (step === "done" && made) {
    return (
      <Dialog title={`${made.name} is ready`} onClose={onClose}>
        <div className="template-preview">
          <div className="template-who">
            <Avatar value={made.avatar} size="lg" />
            <p>{made.name} is in your bots. Its settings have more: its model, voice and wake phrase, knowledge files and its own email address.</p>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("adt:edit-bot", { detail: made.id }));
                onClose();
              }}
            >
              <Settings2 size={15} /> More settings
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                selectBot(made.id);
                openView(null);
                onClose();
              }}
            >
              Chat with {made.name}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (step === "edit") {
    const groupsOn = draft.toolGroups;
    const groups = allToolGroups();
    return (
      <Dialog title="Create your own bot" onClose={onClose}>
        <div className="template-preview custom-bot">
          <div className="field-row">
            <div className="field" style={{ flex: "0 0 72px" }}>
              <label htmlFor="custom-bot-emoji">Picture</label>
              <input id="custom-bot-emoji" className="input" maxLength={16} value={draft.avatar} onChange={(e) => set({ avatar: e.target.value })} aria-label="Emoji" />
            </div>
            <div className="field">
              <label htmlFor="custom-bot-name">Name</label>
              <input id="custom-bot-name" className="input" placeholder="e.g. Study Coach" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="custom-bot-description">What it's for (one line)</label>
            <input id="custom-bot-description" className="input" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="custom-bot-instructions">Instructions</label>
            <textarea
              id="custom-bot-instructions"
              className="textarea"
              rows={9}
              placeholder="You are… Your job is… When something is missing, ask… Keep answers…"
              value={draft.systemPrompt}
              onChange={(e) => set({ systemPrompt: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Tools it can use</label>
            <div className="tool-groups">
              {groups.map((group) => {
                const on = groupsOn === "all" || groupsOn.includes(group.id);
                return (
                  <label key={group.id} className="toggle compact" title={group.description}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const current = groupsOn === "all" ? groups.map((g) => g.id) : groupsOn;
                        const next = e.target.checked ? [...new Set([...current, group.id])] : current.filter((id) => id !== group.id);
                        set({ toolGroups: next.length === groups.length ? "all" : next });
                      }}
                    />
                    <span>{group.label}</span>
                  </label>
                );
              })}
            </div>
            <span className="small muted">Actions that change things ask you first (Settings → Tools &amp; safety).</span>
          </div>
          {error && <p className="error-text small">{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setStep("describe")}>
              Back
            </button>
            <button type="button" className="btn primary" disabled={busy || !draft.name.trim()} onClick={() => void create()}>
              Create bot
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Create your own bot" onClose={onClose}>
      <div className="template-preview custom-bot">
        <p className="small muted">Say what your bot is for: its job, who it helps, how it should talk. ADT Bot writes its name and instructions, and you can change everything before it's made.</p>
        <textarea
          className="textarea"
          rows={5}
          aria-label="What should your bot do?"
          placeholder="What should your bot do?"
          value={idea}
          disabled={busy}
          onChange={(e) => setIdea(e.target.value)}
        />
        <div className="custom-bot-ideas">
          {IDEAS.map((text) => (
            <button key={text} type="button" className="chip" disabled={busy} onClick={() => setIdea(text)}>
              {text}
            </button>
          ))}
        </div>
        {!canWrite && <p className="small muted">To have it written for you, add an AI provider in Settings → Providers. You can still fill it in yourself.</p>}
        {error && <p className="error-text small">{error}</p>}
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              set({ ...EMPTY_DRAFT, systemPrompt: idea.trim() });
              setError("");
              setStep("edit");
            }}
          >
            Fill it in myself
          </button>
          <button type="button" className="btn primary" disabled={busy || !idea.trim() || !canWrite} onClick={() => void write()}>
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {busy ? "Writing…" : "Write it for me"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
