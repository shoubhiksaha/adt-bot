import { Circle, Loader2, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useStore } from "../../lib/store";
import { addSkill, skillName } from "../skills/skills";
import { mac } from "./api";
import { saveRecipe, validateRecipe } from "./recipes";
import { type Draft, draftRecipe, type RecordedStep, stepsInWords } from "./teach";

/**
 * Teach a task: do it once while ADT Bot watches (clicks, typing, keys, app switches; never what you
 * type in password fields, never ADT Bot itself), then review it as a recipe bots replay and a skill.
 */
export function TeachTask() {
  const [state, setState] = useState<"idle" | "recording" | "review">("idle");
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(async () => {
      const status = await mac<{ recording: boolean; steps: number }>("recordStatus").catch(() => null);
      if (!status) return;
      setCount(status.steps);
      // It stopped by itself (the 10-minute limit): show what was recorded.
      if (!status.recording) void stop();
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const start = async () => {
    setError("");
    try {
      await mac("recordStart", { seconds: 600 });
      setCount(0);
      setState("recording");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (/Input Monitoring/.test(message)) void mac("openSettings", { pane: "input-monitoring" }).catch(() => undefined);
    }
  };
  const stop = async () => {
    try {
      const { steps } = await mac<{ steps: RecordedStep[] }>("recordStop");
      const next = draftRecipe(steps ?? []);
      setDraft(next);
      setState(next.steps.length ? "review" : "idle");
      if (!next.steps.length) setError(next.skipped[0] ?? "Nothing was recorded. Start again, then do the task in the app.");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };

  return (
    <div className="teach-task">
      {state === "recording" ? (
        <div className="teach-recording" role="status">
          <Circle size={12} className="rec-dot" fill="currentColor" /> Recording what you do: {count} step{count === 1 ? "" : "s"}. Do the task now in its app, then come back and stop.
          <button type="button" className="btn primary" onClick={() => void stop()}>
            <Square size={13} fill="currentColor" /> Stop
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => void start()}>
          <Circle size={13} className="rec-dot" fill="currentColor" /> Teach a task
        </button>
      )}
      <p className="small muted">
        Do something once (send a message, file a form, export a report) while ADT Bot records your clicks, typing and keys, then save it as a recipe bots repeat on request. Password
        fields and ADT Bot itself are never recorded; it stops after 10 minutes. The first time, macOS asks to allow Input Monitoring.
      </p>
      {error && <p className="small error-text">{error}</p>}
      {state === "review" && draft && <ReviewDraft draft={draft} onClose={() => setState("idle")} />}
    </div>
  );
}

function ReviewDraft({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const apps = [...new Set(draft.steps.flatMap((s) => (typeof s.args.app === "string" ? [s.args.app] : [])))];
  const [name, setName] = useState(apps.length ? `${apps[0].toLowerCase()} task` : "my task");
  const [description, setDescription] = useState("");
  const [asSkill, setAsSkill] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = () => {
    setError("");
    setBusy(true);
    try {
      const recipe = validateRecipe({ name, description: description || `Recorded in ${apps.join(", ")}`, params: draft.params, steps: draft.steps });
      const { replaced } = saveRecipe(recipe);
      if (asSkill) {
        let skill = skillName(name);
        for (let n = 2; skillNameTaken(skill); n++) skill = `${skillName(name)}-${n}`;
        addSkill({
          name: skill,
          description: description || `Doing "${name}" in ${apps.join(", ")}`,
          instructions: [
            // What the user typed while recording stays out of the skill (it's stored and sent to the model).
            `Use the recipe "${recipe.name}" (mac_recipe_run)${draft.params.length ? ` with ${draft.params.join(", ")}` : ""}. If it fails, do the same by hand:`,
            "",
            stepsInWords(recipe.steps),
            ...(draft.skipped.length ? ["", "Not recorded (ask the user, or work it out):", ...draft.skipped.map((s) => `- ${s}`)] : []),
          ].join("\n"),
          source: "recorded",
        });
      }
      void replaced;
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Save what you did" onClose={onClose}>
      <div className="teach-review">
        <div className="field">
          <label htmlFor="teach-name">Name</label>
          <input id="teach-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="teach-desc">What it does (bots read this)</label>
          <input id="teach-desc" className="input" placeholder="Sends a WhatsApp message to a contact" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label>Steps</label>
          <pre className="template-text">{stepsInWords(draft.steps)}</pre>
          {draft.params.length > 0 && (
            <span className="small muted">
              Filled in each time: {draft.params.map((p) => `${p} (you typed “${draft.examples[p].slice(0, 40)}”)`).join(", ")}.
            </span>
          )}
        </div>
        {draft.skipped.length > 0 && (
          <ul className="small muted">
            {draft.skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        <label className="toggle compact">
          <input type="checkbox" checked={asSkill} onChange={(e) => setAsSkill(e.target.checked)} />
          <span className="small">Also save it as a skill (so bots know when to use it, and can follow it in words)</span>
        </label>
        {error && <p className="small error-text">{error}</p>}
        <div className="btn-row dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Discard
          </button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            {busy && <Loader2 size={14} className="spin" />} Save recipe
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function skillNameTaken(name: string): boolean {
  return useStore.getState().skills.some((s) => s.name === name);
}
