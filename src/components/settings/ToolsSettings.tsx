import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ACCESS_MODES, type ComputerAccess } from "../../lib/agent/access";
import { type ActivityEntry, clearActivity, listActivity } from "../../lib/agent/activity";
import { allToolGroups, allTools } from "../../lib/agent/tools";
import { isDesktop } from "../../lib/desktop";
import { updateSettings, useStore } from "../../lib/store";
import { Section, Toggle } from "./controls";

export function ToolsSettings() {
  const agent = useStore((s) => s.settings.agent);
  const set = (patch: Partial<typeof agent>) => updateSettings({ agent: { ...agent, ...patch } });
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const [confirmFull, setConfirmFull] = useState(false);
  const access = agent.access ?? "restricted";
  const chooseAccess = (mode: ComputerAccess) => {
    setConfirmFull(false);
    if (mode === "full" && access !== "full") setConfirmFull(true);
    else set({ access: mode });
  };
  useEffect(() => {
    void listActivity().then(setLog);
  }, []);
  const groups = allToolGroups();
  const tools = allTools();

  return (
    <div>
      <Toggle
        checked={agent.enabled}
        onChange={(enabled) => set({ enabled })}
        title="Let bots use tools"
        hint="Search, read pages and files, run approved commands, use computers and connectors. Choose which tools each bot gets in its settings."
      />

      {isDesktop() && (
        <Section title="Computer access" hint="How much of this computer bots can reach with commands, files, apps and screen control.">
          <div className="radio-cards access-cards">
            {(Object.keys(ACCESS_MODES) as ComputerAccess[]).map((mode) => (
              <label key={mode} className={`radio-card access-${mode}${access === mode ? " active" : ""}`}>
                <input type="radio" name="computer-access" checked={access === mode} onChange={() => chooseAccess(mode)} />
                <span>
                  <strong>{ACCESS_MODES[mode].label}</strong>
                  <br />
                  <span className="small muted">{ACCESS_MODES[mode].hint}</span>
                </span>
              </label>
            ))}
          </div>
          {confirmFull && (
            <div className="access-warning" role="alert">
              <p className="small">
                <strong>Give bots full control of this computer?</strong> They'll run commands, change and delete files, and use your apps, mouse and keyboard
                without asking. A web page or file a bot reads could try to trick it into doing something harmful. Turn this on only while you're watching,
                and keep "Still ask before destructive actions" on.
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    set({ access: "full" });
                    setConfirmFull(false);
                  }}
                >
                  Give full access
                </button>
                <button type="button" className="btn" onClick={() => setConfirmFull(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {access === "full" && (
            <Toggle
              checked={agent.confirmDestructive}
              onChange={(confirmDestructive) => set({ confirmDestructive })}
              title="Still ask before destructive actions"
              hint="Deleting files, sudo, disk and system commands, AppleScript and quitting apps wait for your OK, even with full access. Voice mode can't ask, so it skips them."
            />
          )}
          {access === "sandbox" && (
            <p className="small muted">
              Commands and files are limited to the “ADT Bot Workspace” folder in your home folder, and files are shown in their folder rather than opened.
              Sandboxed commands can still use the internet on macOS; on Linux they need bubblewrap and run offline; on Windows they're not available yet.
              Connectors (MCP servers) you added aren't sandboxed.
            </p>
          )}
        </Section>
      )}

      <Section
        title="Approvals"
        hint="Reading and searching never asks. Anything that changes things, costs money or reaches outside asks according to this policy; destructive actions always ask. With Full access, computer actions skip it."
      >
        <div className="field">
          <select
            id="approval-policy"
            className="select"
            value={agent.approvalPolicy}
            onChange={(e) => set({ approvalPolicy: e.target.value as typeof agent.approvalPolicy })}
          >
            <option value="ask-first-time">Ask the first time for each action (recommended)</option>
            <option value="ask-every-time">Ask every time</option>
            <option value="allowlist">Only allow what's on my allow list (ask for the rest)</option>
            <option value="auto-run">Run without asking (except destructive actions and the deny list)</option>
          </select>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="allowlist">Always allow</label>
            <textarea
              id="allowlist"
              className="textarea"
              style={{ minHeight: 90 }}
              spellCheck={false}
              placeholder={"git status\nnpm test\ntool:create_image"}
              defaultValue={agent.allowlist.join("\n")}
              onBlur={(e) => set({ allowlist: lines(e.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="denylist">Never allow</label>
            <textarea
              id="denylist"
              className="textarea"
              style={{ minHeight: 90 }}
              spellCheck={false}
              placeholder={"sudo *\n~/.ssh\n/re/i"}
              defaultValue={agent.denylist.join("\n")}
              onBlur={(e) => set({ denylist: lines(e.target.value) })}
            />
          </div>
        </div>
        <span className="small muted">
          One rule per line: exact text, a command prefix (“git”), a glob (“npm run *”), “tool:name”, or /regex/. The deny list is checked against
          every argument and wins over everything.
        </span>
      </Section>

      <Section title="Advanced">
        <div className="field-row">
          <div className="field">
            <label htmlFor="tool-mode">Tool calling</label>
            <select id="tool-mode" className="select" value={agent.mode} onChange={(e) => set({ mode: e.target.value as typeof agent.mode })}>
              <option value="auto">Automatic</option>
              <option value="native">Native (the provider's tool calling)</option>
              <option value="prompted">Text protocol (for models without tool calling)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="max-steps">
              Max tool steps per answer <span className="muted small">{agent.maxSteps}</span>
            </label>
            <input id="max-steps" type="range" min={1} max={40} value={agent.maxSteps} onChange={(e) => set({ maxSteps: Number(e.target.value) })} />
          </div>
        </div>
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            {tools.length} tools in {groups.length} groups available
          </summary>
          <ul className="small muted" style={{ columns: 2 }}>
            {tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code> ({t.risk})
              </li>
            ))}
          </ul>
        </details>
      </Section>

      <Section title="Activity log" hint="Everything bots did with tools, newest first. Stored on this device.">
        {log.length ? (
          <div className="activity-log">
            {log.slice(0, 150).map((entry) => (
              <div key={entry.id} className={`activity-row ${entry.outcome}`}>
                <span className="small muted">{new Date(entry.at).toLocaleString()}</span>
                <span className="grow ellipsis">
                  <strong>{entry.bot}</strong> · {entry.summary || entry.tool}
                </span>
                <span className={`badge outcome-${entry.outcome}`}>{entry.outcome}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted">Nothing yet.</p>
        )}
        {log.length > 0 && (
          <button type="button" className="btn" onClick={() => void clearActivity().then(() => setLog([]))}>
            <Trash2 size={14} /> Clear log
          </button>
        )}
      </Section>
    </div>
  );
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
