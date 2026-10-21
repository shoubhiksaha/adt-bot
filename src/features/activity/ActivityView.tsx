import { ChevronRight, Download, MessageSquare, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type ActivityEntry, clearActivity, listActivity, onActivity } from "../../lib/agent/activity";
import { saveTextFile } from "../../lib/files";
import { useStore } from "../../lib/store";
import { showConversation } from "../automation/conversations";
import { ALL, type ActivityFilter, activityCsv, activityStats, filterActivity, wasAsked } from "./log";
import "./activity.css";

const OUTCOME: Record<ActivityEntry["outcome"], string> = { done: "ran", error: "failed", denied: "refused", approved: "approved", auto: "ran" };
const PAGE = 200;

function Row({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const exists = useStore((s) => Boolean(entry.conversationId && s.conversations[entry.conversationId]));
  return (
    <li className={`log-row log-${entry.outcome}${open ? " open" : ""}`}>
      <button type="button" className="log-line" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={14} className="chev" />
        <span className="log-time small muted">{new Date(entry.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}</span>
        <span className="log-what">
          <strong>{entry.bot}</strong> <code>{entry.tool}</code> <span className="log-summary">{entry.summary}</span>
        </span>
        {wasAsked(entry) && <span className="badge">asked you</span>}
        <span className={`badge outcome-${entry.outcome}`}>{OUTCOME[entry.outcome]}</span>
      </button>
      {open && (
        <dl className="log-detail small">
          {entry.decision && (
            <>
              <dt>Why</dt>
              <dd>{entry.decision}</dd>
            </>
          )}
          {entry.taint && (
            <>
              <dt>Had read</dt>
              <dd>{entry.taint}</dd>
            </>
          )}
          {entry.args && (
            <>
              <dt>Given</dt>
              <dd>
                <code>{entry.args}</code>
              </dd>
            </>
          )}
          {entry.result && (
            <>
              <dt>Result</dt>
              <dd>{entry.result}</dd>
            </>
          )}
          {entry.ms !== undefined && (
            <>
              <dt>Took</dt>
              <dd>{entry.ms < 1000 ? `${entry.ms} ms` : `${(entry.ms / 1000).toFixed(1)} s`}</dd>
            </>
          )}
          {exists && (
            <>
              <dt>Chat</dt>
              <dd>
                <button type="button" className="link-btn" onClick={() => showConversation(entry.conversationId!)}>
                  <MessageSquare size={13} /> Open the chat
                </button>
              </dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}

export default function ActivityView() {
  const bots = useStore((s) => s.bots);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>(ALL);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    const refresh = () => void listActivity().then((list) => setEntries([...list]));
    refresh();
    return onActivity(refresh);
  }, []);
  const visible = useMemo(() => filterActivity(entries, filter), [entries, filter]);
  const stats = activityStats(visible);
  const set = (patch: Partial<ActivityFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setShown(PAGE);
  };
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <div className="activity-view">
      <p className="muted small">
        Every action your bots took or were refused, with why it was allowed, what it was given and what came back. Kept on this device
        (the latest 5,000); secrets in arguments are hidden.
      </p>
      <div className="log-filters">
        <input className="input" type="search" placeholder="Search actions" value={filter.query} onChange={(e) => set({ query: e.target.value })} />
        <select className="input" value={filter.botId} onChange={(e) => set({ botId: e.target.value })} aria-label="Bot">
          <option value="">All bots</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select className="input" value={filter.outcome} onChange={(e) => set({ outcome: e.target.value as ActivityFilter["outcome"] })} aria-label="Outcome">
          <option value="all">Everything</option>
          <option value="ran">Ran</option>
          <option value="asked">Asked you first</option>
          <option value="refused">Refused or declined</option>
          <option value="failed">Failed</option>
        </select>
        <select className="input" value={filter.hours} onChange={(e) => set({ hours: Number(e.target.value) })} aria-label="Period">
          <option value={0}>All time</option>
          <option value={24}>Last 24 hours</option>
          <option value={168}>Last 7 days</option>
          <option value={720}>Last 30 days</option>
        </select>
      </div>
      <div className="log-bar small">
        <span className="muted grow">
          {stats.total} action{stats.total === 1 ? "" : "s"} · {stats.asked} asked you · {stats.refused} refused · {stats.failed} failed
        </span>
        <button type="button" className="btn" disabled={!visible.length} onClick={() => void saveTextFile(`adt-bot-agent-log-${stamp}.csv`, activityCsv(visible), "text/csv")}>
          <Download size={14} /> CSV
        </button>
        <button type="button" className="btn" disabled={!visible.length} onClick={() => void saveTextFile(`adt-bot-agent-log-${stamp}.json`, JSON.stringify(visible, null, 2), "application/json")}>
          <Download size={14} /> JSON
        </button>
        <button type="button" className="btn" disabled={!entries.length} onClick={() => confirm("Clear the whole agent log?") && void clearActivity()}>
          <Trash2 size={14} /> Clear
        </button>
      </div>
      {visible.length ? (
        <ul className="log-list">
          {visible.slice(0, shown).map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="muted small log-empty">{entries.length ? "No actions match." : "Nothing yet. Actions appear here as bots use tools."}</p>
      )}
      {visible.length > shown && (
        <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </button>
      )}
    </div>
  );
}
