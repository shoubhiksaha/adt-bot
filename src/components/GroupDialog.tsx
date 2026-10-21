import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { openView } from "../features/registry";
import { groupTitle, MAX_MEMBERS, MAX_ROUNDS, validateGroup } from "../lib/group";
import { newGroupConversation, useStore } from "../lib/store";
import type { GroupSettings } from "../lib/types";
import { BotAvatar } from "./Avatar";
import { Dialog } from "./Dialog";

const MODES: { id: GroupSettings["mode"]; label: string; hint: string }[] = [
  { id: "discuss", label: "Discussion", hint: "They answer in turn, each building on or correcting the others." },
  { id: "debate", label: "Debate", hint: "They take sides (for, against, for…) and challenge each other's arguments." },
  { id: "panel", label: "Panel", hint: "Each answers on its own first; in later rounds they react to each other." },
];

/** Starts a group chat: two to six bots, how they take turns, how many rounds, and who sums up. */
export default function GroupDialog({ onClose }: { onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const [members, setMembers] = useState<string[]>(bots.slice(0, 2).map((b) => b.id));
  const [mode, setMode] = useState<GroupSettings["mode"]>("discuss");
  const [rounds, setRounds] = useState(2);
  const [summarizer, setSummarizer] = useState("");
  const [error, setError] = useState("");

  const toggle = (id: string, on: boolean) => {
    setError("");
    setMembers((m) => (on ? (m.length >= MAX_MEMBERS ? m : [...m, id]) : m.filter((x) => x !== id)));
  };
  const move = (index: number, by: number) =>
    setMembers((m) => {
      const next = [...m];
      const [item] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
      return next;
    });
  const start = () => {
    const group: GroupSettings = { mode, rounds, ...(summarizer ? { summarizer } : {}) };
    const problem = validateGroup(members, group);
    if (problem) return setError(problem);
    newGroupConversation(members, group, groupTitle(members.map((id) => bots.find((b) => b.id === id)!)));
    openView(null);
    onClose();
  };

  return (
    <Dialog title="New group chat" onClose={onClose}>
      <div className="group-form">
        <p className="small muted">
          Your bots talk it through together, each with its own model, instructions and tools. Pick 2 to {MAX_MEMBERS}.
        </p>
        <div className="field">
          <label>Bots</label>
          <div className="tool-groups">
            {bots.map((b) => (
              <label key={b.id} className="toggle compact">
                <input type="checkbox" checked={members.includes(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} />
                <span>
                  <BotAvatar bot={b} size="mini" /> {b.name}
                </span>
              </label>
            ))}
          </div>
        </div>
        {members.length > 1 && (
          <div className="field">
            <label>Speaking order</label>
            <ol className="group-order">
              {members.map((id, i) => (
                <li key={id}>
                  <span className="grow">
                    {bots.find((b) => b.id === id)?.name}
                    {mode === "debate" && <span className="muted small"> · {i % 2 === 0 ? "for" : "against"}</span>}
                  </span>
                  <button type="button" className="icon-btn" aria-label="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Later" disabled={i === members.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="field">
          <label>How they take turns</label>
          {MODES.map((m) => (
            <label key={m.id} className="toggle compact">
              <input type="radio" name="group-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <span>
                <strong>{m.label}</strong> <span className="small muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor="group-rounds">Rounds per message</label>
          <select id="group-rounds" className="input" value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
            {Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "round (each bot speaks once)" : "rounds"}
              </option>
            ))}
          </select>
          <span className="small muted">A round where nobody has anything new to add ends it early.</span>
        </div>
        <div className="field">
          <label htmlFor="group-summary">Sum up at the end</label>
          <select id="group-summary" className="input" value={summarizer} onChange={(e) => setSummarizer(e.target.value)}>
            <option value="">No summary</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} sums up
              </option>
            ))}
          </select>
        </div>
        {error && <p className="error-text small">{error}</p>}
        <div className="btn-row dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={start}>
            Start group chat
          </button>
        </div>
      </div>
    </Dialog>
  );
}
