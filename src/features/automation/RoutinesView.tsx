import { Bell, ChevronRight, History, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BotAvatar } from "../../components/Avatar";
import { Dialog } from "../../components/Dialog";
import { isDesktop } from "../../lib/desktop";
import { useStore } from "../../lib/store";
import { showConversation } from "./conversations";
import { syncKeepAlive } from "./keep-alive";
import { notificationsSupported } from "./notify";
import {
  createRoutine,
  deleteRoutine,
  emptySchedule,
  loadRoutines,
  type Routine,
  type RoutineInput,
  setKeepAlive,
  updateRoutine,
  useRoutines,
} from "./routines-store";
import { runRoutineNow } from "./runner";
import {
  describeSchedule,
  formatWhen,
  localTimezone,
  MINIMUM_INTERVAL_MINUTES,
  nextRunAfter,
  type RoutineRun,
  type Schedule,
  validateSchedule,
  WEEKDAYS,
} from "./schedule";
import "./routines.css";

const STATUS_LABEL: Record<RoutineRun["status"], string> = {
  running: "Running",
  ok: "Done",
  quiet: "Nothing new",
  error: "Failed",
  skipped: "Skipped",
  interrupted: "Interrupted",
};

export default function RoutinesView() {
  const { routines, loaded, keepAlive, running } = useRoutines();
  const bots = useStore((s) => s.bots);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : "denied"));
  const [, setClock] = useState(0);
  useEffect(() => {
    void loadRoutines();
    const t = setInterval(() => setClock((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const desktop = isDesktop();

  return (
    <div className="routines">
      <div className="routines-head">
        <div className="grow">
          <p className="muted small">
            Bots carry out these tasks on a schedule while {desktop ? "the app is running" : "the app is open"}. Each run goes to a
            "Routine: …" chat. A run that finds nothing new stays quiet.
          </p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing("new")} disabled={!bots.length}>
          <Plus size={16} /> New routine
        </button>
      </div>

      <div className="routines-options">
        {desktop ? (
          <label className="toggle">
            <input
              type="checkbox"
              checked={keepAlive}
              onChange={(e) => {
                void setKeepAlive(e.target.checked).then(syncKeepAlive);
              }}
            />
            <span>
              <strong>Keep running in the background for routines</strong>
              <br />
              <span className="small muted">Closing the window keeps ADT Bot in the menu bar / system tray so routines still run.</span>
            </span>
          </label>
        ) : (
          notificationsSupported() &&
          permission !== "granted" && (
            <button
              type="button"
              className="btn"
              disabled={permission === "denied"}
              onClick={() => void Notification.requestPermission().then(setPermission)}
            >
              <Bell size={15} /> {permission === "denied" ? "Notifications are blocked in this browser" : "Notify me when routines finish"}
            </button>
          )
        )}
      </div>

      {!loaded ? (
        <div className="muted small">Loading…</div>
      ) : routines.length === 0 ? (
        <div className="routines-empty">
          <h2>No routines yet</h2>
          <p className="muted">
            Try "Every weekday at 8:00, summarise the AI news and save it to a file", or ask a bot in chat to set one up for you.
          </p>
        </div>
      ) : (
        <ul className="routine-list">
          {routines.map((r) => (
            <RoutineCard key={r.id} routine={r} running={running.includes(r.id)} onEdit={() => setEditing(r)} />
          ))}
        </ul>
      )}

      {editing && <RoutineEditor routine={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoutineCard({ routine: r, running, onEdit }: { routine: Routine; running: boolean; onEdit: () => void }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === r.botId));
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState("");
  const last = r.history.find((h) => h.status !== "running");

  const toggle = async (enabled: boolean) => {
    setError("");
    try {
      await updateRoutine(r.id, { enabled });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <li className={`routine-card${r.enabled ? "" : " off"}`}>
      <div className="routine-top">
        {bot ? <BotAvatar bot={bot} /> : <span className="avatar" aria-hidden />}
        <div className="grow routine-main">
          <div className="routine-name">
            <strong>{r.name}</strong>
            {running && (
              <span className="routine-chip running">
                <Loader2 size={12} className="spin" /> Running
              </span>
            )}
            {!running && last && <span className={`routine-chip ${last.status}`}>{STATUS_LABEL[last.status]}</span>}
          </div>
          <div className="small muted">
            {bot?.name ?? "Bot deleted"} · {describeSchedule(r.schedule)}
            {" · "}
            {r.enabled && r.nextRun ? `Next: ${formatWhen(r.nextRun)}` : r.schedule.type === "once" && r.lastRun ? "Done" : "Off"}
          </div>
          <div className="routine-instruction small">{r.instruction}</div>
          {r.disabledReason && <div className="small routine-warn">{r.disabledReason}</div>}
          {error && <div className="small error-text">{error}</div>}
        </div>
        <label className="routine-switch" title={r.enabled ? "Switch off" : "Switch on"}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => void toggle(e.target.checked)} aria-label={`${r.name} on`} />
          <span />
        </label>
      </div>
      <div className="btn-row routine-actions">
        <button
          type="button"
          className="btn"
          disabled={running}
          onClick={() => {
            setError("");
            runRoutineNow(r.id).catch((e) => setError((e as Error).message));
          }}
        >
          <Play size={14} /> Run now
        </button>
        <button type="button" className="btn" onClick={onEdit}>
          <Pencil size={14} /> Edit
        </button>
        <button type="button" className="btn" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} disabled={!r.history.length}>
          <History size={14} /> History ({r.history.length})
          <ChevronRight size={13} className={`chev${showHistory ? " open" : ""}`} />
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (confirm(`Delete the routine "${r.name}"? Its chats stay.`)) void deleteRoutine(r.id);
          }}
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>
      {showHistory && (
        <ol className="routine-history">
          {r.history.map((h) => (
            <li key={h.id}>
              <span className={`routine-chip ${h.status}`}>{STATUS_LABEL[h.status]}</span>
              <span className="small">{new Date(h.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
              {h.trigger === "manual" && <span className="small muted">run now</span>}
              {h.finishedAt && h.status !== "skipped" && <span className="small muted">{Math.max(1, Math.round((h.finishedAt - h.startedAt) / 1000))} s</span>}
              <span className="small muted grow ellipsis" title={h.summary}>
                {h.summary}
              </span>
              {h.conversationId && (
                <button type="button" className="inline-btn small" onClick={() => showConversation(h.conversationId!)}>
                  Open chat
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

type Draft = { name: string; instruction: string; botId: string; schedule: Schedule; missedRunPolicy: Routine["missedRunPolicy"] };

const timezones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

function switchType(schedule: Schedule, type: Schedule["type"]): Schedule {
  const timezone = schedule.timezone;
  const time = "time" in schedule ? schedule.time : "08:00";
  switch (type) {
    case "once": {
      const tomorrow = new Date(Date.now() + 86400_000);
      const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
      return { type, date, time, timezone };
    }
    case "daily":
      return { type, time, timezone };
    case "weekly":
      return { type, time, days: [1, 2, 3, 4, 5], timezone };
    case "interval":
      return { type, everyMinutes: 60, anchor: Date.now(), timezone };
    case "cron":
      return { type, cron: "0 8 * * 1-5", timezone };
  }
}

function RoutineEditor({ routine, onClose }: { routine: Routine | null; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const activeBotId = useStore((s) => s.activeBotId);
  const [draft, setDraft] = useState<Draft>(() =>
    routine
      ? { name: routine.name, instruction: routine.instruction, botId: routine.botId, schedule: routine.schedule, missedRunPolicy: routine.missedRunPolicy }
      : { name: "", instruction: "", botId: activeBotId ?? bots[0]?.id ?? "", schedule: emptySchedule(), missedRunPolicy: "run-once" },
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const s = draft.schedule;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setSchedule = (patch: Partial<Schedule>) => setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } as Schedule }));

  const scheduleError = validateSchedule(s);
  const preview = useMemo(() => {
    if (scheduleError) return "";
    const probe = s.type === "interval" ? { ...s, anchor: Date.now() } : s;
    const next = nextRunAfter(probe, Date.now());
    return next ? `Next: ${formatWhen(next)}` : s.type === "once" ? "That time has passed." : "This schedule never runs.";
  }, [s, scheduleError]);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const input: RoutineInput = { ...draft };
      if (routine) await updateRoutine(routine.id, input);
      else await createRoutine(input);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={routine ? "Edit routine" : "New routine"} onClose={onClose}>
      <div className="routine-form">
        <div className="field">
          <label htmlFor="routine-name">Name</label>
          <input id="routine-name" className="input" value={draft.name} placeholder="Morning AI news" onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="routine-bot">Bot</label>
          <select id="routine-bot" className="select" value={draft.botId} onChange={(e) => set({ botId: e.target.value })}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="routine-instruction">What should it do each time?</label>
          <textarea
            id="routine-instruction"
            className="textarea"
            value={draft.instruction}
            placeholder="Summarise today's most important AI news in 5 bullet points with links, and save it to news/ai-<date>.md"
            onChange={(e) => set({ instruction: e.target.value })}
          />
        </div>

        <div className="field">
          <span className="field-label">When</span>
          <div className="routine-types" role="radiogroup" aria-label="Schedule type">
            {(["daily", "weekly", "interval", "once", "cron"] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={s.type === type}
                className={`pill${s.type === type ? " on" : ""}`}
                onClick={() => s.type !== type && set({ schedule: switchType(s, type) })}
              >
                {{ daily: "Every day", weekly: "Some days", interval: "Every…", once: "Once", cron: "Cron" }[type]}
              </button>
            ))}
          </div>
        </div>

        {s.type === "weekly" && (
          <div className="routine-days" role="group" aria-label="Days">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const on = s.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  className={`pill${on ? " on" : ""}`}
                  onClick={() => setSchedule({ days: on ? s.days.filter((x) => x !== d) : [...s.days, d].sort() })}
                >
                  {WEEKDAYS[d]}
                </button>
              );
            })}
          </div>
        )}

        <div className="routine-when">
          {s.type === "once" && (
            <div className="field">
              <label htmlFor="routine-date">Date</label>
              <input id="routine-date" type="date" className="input" value={s.date} onChange={(e) => setSchedule({ date: e.target.value })} />
            </div>
          )}
          {(s.type === "once" || s.type === "daily" || s.type === "weekly") && (
            <div className="field">
              <label htmlFor="routine-time">Time</label>
              <input id="routine-time" type="time" className="input" value={s.time} onChange={(e) => setSchedule({ time: e.target.value })} />
            </div>
          )}
          {s.type === "interval" && (
            <div className="field">
              <label htmlFor="routine-every">Every (minutes, at least {MINIMUM_INTERVAL_MINUTES})</label>
              <input
                id="routine-every"
                type="number"
                min={MINIMUM_INTERVAL_MINUTES}
                step={5}
                className="input"
                value={s.everyMinutes}
                onChange={(e) => setSchedule({ everyMinutes: Number(e.target.value) })}
              />
            </div>
          )}
          {s.type === "cron" && (
            <div className="field">
              <label htmlFor="routine-cron">Cron (minute hour day month weekday)</label>
              <input id="routine-cron" className="input routine-mono" value={s.cron} onChange={(e) => setSchedule({ cron: e.target.value })} />
            </div>
          )}
          {s.type !== "interval" && (
            <div className="field">
              <label htmlFor="routine-tz">Timezone</label>
              <input
                id="routine-tz"
                className="input"
                list="routine-tz-list"
                value={s.timezone}
                onChange={(e) => setSchedule({ timezone: e.target.value })}
                placeholder={localTimezone()}
              />
              <datalist id="routine-tz-list">
                {timezones.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </div>
          )}
        </div>

        <div className={`small ${scheduleError ? "error-text" : "muted"}`}>
          {scheduleError ?? `${describeSchedule(s)} · ${preview}`}
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="routine-missed">If the app was closed at run time</label>
          <select
            id="routine-missed"
            className="select"
            value={draft.missedRunPolicy}
            onChange={(e) => set({ missedRunPolicy: e.target.value as Draft["missedRunPolicy"] })}
          >
            <option value="run-once">Run once when the app opens</option>
            <option value="skip">Skip it</option>
          </select>
        </div>

        {error && <div className="small error-text">{error}</div>}
        <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || Boolean(scheduleError)}>
            {saving && <Loader2 size={14} className="spin" />} {routine ? "Save" : "Create routine"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
