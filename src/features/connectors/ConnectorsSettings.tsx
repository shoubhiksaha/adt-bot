import { ChevronDown, ChevronRight, Loader2, Pencil, Plug, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { Section } from "../../components/settings/controls";
import { isDesktop } from "../../lib/desktop";
import { type ConnectorConfig, type ConnectorStatus, connectionKey, launchApproved } from "../../lib/mcp/connectors";
import { agentToolName, claimsReadOnly, riskFromAnnotations } from "../../lib/mcp/protocol";
import { cleanTool, launchKey, type ToolReview, toolsToReview, toolsWithHidden } from "../../lib/mcp/security";
import {
  addServer,
  approveLaunch,
  approveToolChanges,
  connectorManager,
  getServer,
  removeServer,
  setServerEnabled,
  testServer,
  updateServer,
  useConnectors,
} from "../../lib/mcp/store";
import { COMPUTER_PRESETS, configFromDraft, type Draft, draftFrom, emptyDraft, launchConfirmText, PRESETS } from "./form";
import "./connectors.css";

/** Asks before a local server's command runs for the first time (or after it changed). */
function ensureLaunchApproved(server: ConnectorConfig): boolean {
  if (launchApproved(server)) return true;
  if (!confirm(launchConfirmText(server))) return false;
  approveLaunch(server.id);
  return true;
}

export function ConnectorsSettings() {
  const servers = useConnectors((s) => s.servers);
  const status = useConnectors((s) => s.status);
  const loaded = useConnectors((s) => s.loaded);
  const desktop = isDesktop();
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <div className="connectors">
      <p className="small muted">
        Connectors give your bots tools from <strong>MCP servers</strong> (Model Context Protocol): GitHub, Notion, Linear, your files, databases and
        more. Read-only tools run freely; anything else asks you first, according to your approval settings in Tools. Results from connectors are
        treated as outside content, never as instructions. Choose which bots may use connectors in each bot's settings (Tools → “Connectors”).
      </p>

      <Section title="Your connectors">
        {!loaded && <p className="small muted">Loading…</p>}
        {loaded && !servers.length && editing !== "new" && <p className="small muted">None yet. Add one below.</p>}
        {servers.map((server) =>
          editing === server.id ? (
            <ConnectorForm key={server.id} initial={draftFrom(server)} desktop={desktop} onDone={() => setEditing(null)} existing={server} />
          ) : (
            <ConnectorCard key={server.id} server={server} status={status[server.id]} desktop={desktop} onEdit={() => setEditing(server.id)} />
          ),
        )}
        {editing === "new" ? (
          <ConnectorForm initial={emptyDraft()} desktop={desktop} onDone={() => setEditing(null)} />
        ) : (
          <button className="btn" onClick={() => setEditing("new")}>
            <Plus size={15} /> Add connector
          </button>
        )}
      </Section>
    </div>
  );
}

function statusLine(server: ConnectorConfig, status: ConnectorStatus | undefined, desktop: boolean): { text: string; tone: "ok" | "err" | "muted" | "busy" } {
  if (server.transport === "stdio" && !desktop) return { text: "Local servers only run in the desktop app", tone: "muted" };
  if (!server.enabled) return { text: "Off", tone: "muted" };
  if (!status || status.state === "idle") return { text: server.tools?.length ? "Not connected (connects when used)" : "Not connected", tone: "muted" };
  if (status.state === "connecting") return { text: "Connecting…", tone: "busy" };
  if (status.state === "error") return { text: "Error", tone: "err" };
  const name = status.server?.title || status.server?.name;
  const version = status.protocolVersion ? ` · MCP ${status.protocolVersion}` : "";
  return { text: `Connected${name ? ` to ${name}${status.server?.version ? ` ${status.server.version}` : ""}` : ""} · ${status.transport ?? ""}${version}`, tone: "ok" };
}

function ConnectorCard({ server, status, desktop, onEdit }: { server: ConnectorConfig; status?: ConnectorStatus; desktop: boolean; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const line = statusLine(server, status, desktop);
  const tools = server.tools ?? [];
  const canRun = server.transport === "http" || desktop;
  const enabledCount = tools.filter((t) => !server.disabledTools.includes(t.name)).length;
  const hiddenTools = toolsWithHidden(tools);
  const review = toolsToReview(tools, server.approvedTools);
  const toReview = new Set(review.map((r) => r.name));
  const unconfirmed = !launchApproved(server);

  const test = async () => {
    if (!ensureLaunchApproved(server)) return;
    setBusy(true);
    setResult(null);
    try {
      const list = await testServer(getServer(server.id) ?? server);
      setResult(`Works: ${list.length} tool${list.length === 1 ? "" : "s"} found.`);
      setOpen(true);
    } catch {
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = (name: string, on: boolean) => {
    const disabled = new Set(server.disabledTools);
    if (on) disabled.delete(name);
    else disabled.add(name);
    updateServer(server.id, { disabledTools: [...disabled] });
  };

  return (
    <div className="card connector-card">
      <div className="card-row">
        <Plug size={16} className="muted" aria-hidden />
        <div className="grow">
          <strong>{server.name}</strong>
          <span className="badge">{server.transport === "stdio" ? "local" : "remote"}</span>
          <div className="small muted ellipsis" title={server.transport === "stdio" ? server.command : server.url}>
            {server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}
          </div>
        </div>
        <label className="connector-switch" title={server.enabled ? "Switch off" : "Switch on"}>
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={!canRun}
            onChange={(e) => {
              if (e.target.checked && !ensureLaunchApproved(server)) return;
              void setServerEnabled(server.id, e.target.checked);
            }}
          />
          <span className="small">{server.enabled ? "On" : "Off"}</span>
        </label>
      </div>

      <div className={`connector-status ${line.tone}`} role="status">
        {line.tone === "busy" && <Loader2 size={13} className="spin" aria-hidden />}
        <span className="dot" aria-hidden />
        {line.text}
      </div>
      {server.enabled && status?.state === "error" && status.error && <pre className="connector-error">{status.error}</pre>}
      {result && <div className="status ok">{result}</div>}
      {unconfirmed && canRun && (
        <div className="connector-warning small" role="alert">
          <ShieldAlert size={14} aria-hidden />
          <span className="grow">This command hasn't been confirmed on this device, so it won't run until you allow it.</span>
          <button className="btn" onClick={() => void test()}>
            Review command
          </button>
        </div>
      )}
      {hiddenTools.length > 0 && (
        <div className="connector-warning small" role="alert">
          <ShieldAlert size={14} aria-hidden />
          <span>
            Hidden characters in {hiddenTools.map((t) => t.name).join(", ")}. They're removed before the AI reads them, but hidden text is a common way to
            slip instructions to an AI. Keep this connector only if you trust it.
          </span>
        </div>
      )}
      {review.length > 0 && <ToolChanges serverId={server.id} review={review} />}
      {status?.skippedTools?.length ? (
        <div className="small muted">
          Left out (the server described them wrongly): {status.skippedTools.map((t) => `${t.name} (${t.reason})`).join("; ")}
        </div>
      ) : null}

      <div className="btn-row connector-actions">
        <button className="btn" onClick={() => void test()} disabled={busy || !canRun}>
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Test connection
        </button>
        <button className="btn" onClick={onEdit}>
          <Pencil size={14} /> Edit
        </button>
        {status?.state === "connected" && (
          <button className="btn" onClick={() => void connectorManager.disconnect(server.id)}>
            Disconnect
          </button>
        )}
        <button
          className="btn danger"
          onClick={() => {
            if (confirm(`Remove the ${server.name} connector?`)) void removeServer(server.id);
          }}
        >
          <Trash2 size={14} /> Remove
        </button>
      </div>

      {tools.length > 0 && (
        <div className="connector-tools">
          <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {enabledCount} of {tools.length} tools on
          </button>
          {open && (
            <ul>
              {tools.map((tool) => {
                const trusted = server.readOnlyTools?.includes(tool.name) ?? false;
                const risk = riskFromAnnotations(tool.annotations, trusted);
                const claims = claimsReadOnly(tool.annotations);
                // Shown as the AI sees it: hidden characters removed.
                const { tool: shown, hidden } = cleanTool(tool);
                return (
                  <li key={tool.name}>
                    <label>
                      <input type="checkbox" checked={!server.disabledTools.includes(tool.name)} onChange={(e) => toggleTool(tool.name, e.target.checked)} />
                      <span className="grow">
                        <code>{shown.name}</code>
                        <span className={`badge risk-${risk}`}>{risk === "read" ? "read-only" : risk === "destructive" ? "destructive" : "asks"}</span>
                        {hidden > 0 && <span className="badge tool-flag">hidden characters</span>}
                        {toReview.has(tool.name) && <span className="badge tool-flag">off until reviewed</span>}
                        {shown.description && <span className="small muted connector-tool-desc">{shown.description}</span>}
                        <span className="small muted connector-tool-desc">as {agentToolName(server.name, tool.name)}</span>
                      </span>
                    </label>
                    {risk !== "destructive" && (
                      <label className="toggle compact connector-readonly">
                        <input
                          type="checkbox"
                          checked={trusted}
                          onChange={(e) =>
                            updateServer(server.id, {
                              readOnlyTools: e.target.checked
                                ? [...new Set([...(server.readOnlyTools ?? []), tool.name])]
                                : (server.readOnlyTools ?? []).filter((n) => n !== tool.name),
                            })
                          }
                        />
                        <span className="small muted">
                          Only reads: runs without asking{claims && !trusted ? " (the server says it only reads; tick to trust that)" : ""}
                        </span>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectorForm({ initial, desktop, onDone, existing }: { initial: Draft; desktop: boolean; onDone: () => void; existing?: ConnectorConfig }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [install, setInstall] = useState<(typeof COMPUTER_PRESETS)[number] | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const presets = PRESETS.filter((p) => desktop || !p.desktopOnly);
  const mac = desktop && window.adtbotDesktop?.platform === "darwin";

  const save = async () => {
    const parsed = configFromDraft(draft);
    if ("error" in parsed) return setError(parsed.error);
    // A local command runs only after the user saw it in full and allowed it.
    const launch = parsed.config.transport === "stdio" ? launchKey(parsed.config) : undefined;
    if (launch && launch !== existing?.approvedLaunch && !confirm(launchConfirmText(parsed.config))) return;
    setError("");
    setSaving(true);
    try {
      if (existing) {
        // Pointed at a different server: its first tool list is what the user approves, as when adding.
        const moved = connectionKey({ ...existing, ...parsed.config }) !== connectionKey(existing);
        updateServer(existing.id, { ...parsed.config, approvedLaunch: launch, ...(moved ? { approvedTools: undefined } : {}) });
        const now = useConnectors.getState().servers.find((s) => s.id === existing.id);
        if (now?.enabled) await testServer(now).catch(() => undefined);
      } else {
        const server = addServer({ ...parsed.config, enabled: true, approvedLaunch: launch });
        await testServer(server).catch(() => undefined);
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card connector-form">
      {!existing && (
        <div className="connector-presets">
          <span className="small muted">Examples:</span>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="btn"
              title={p.hint}
              onClick={() => {
                setInstall(null);
                setDraft({ ...emptyDraft(), ...p.draft });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {!existing && mac && (
        <div className="connector-presets">
          <span className="small muted">Control this Mac:</span>
          {COMPUTER_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`btn${install?.label === p.label ? " active" : ""}`}
              title={p.hint}
              onClick={() => {
                setInstall(p);
                setDraft({ ...emptyDraft(), ...p.draft });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {install && (
        <div className="connector-install">
          <p className="small">
            <strong>{install.label}</strong> ({install.license}, <a href={install.url} target="_blank" rel="noreferrer">source</a>): {install.hint}
          </p>
          <p className="small">
            Install it once in Terminal: <code>{install.install}</code>
          </p>
          <p className="small muted">ADT Bot already uses Mac apps by name on its own; add this for its extra tools.</p>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor="mcp-name">Name</label>
          <input id="mcp-name" className="input" value={draft.name} placeholder="GitHub" onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="mcp-type">Type</label>
          <select id="mcp-type" className="select" value={draft.transport} onChange={(e) => set({ transport: e.target.value as Draft["transport"] })}>
            <option value="http">Remote server (URL)</option>
            <option value="stdio" disabled={!desktop}>
              Local command{desktop ? "" : " (desktop app only)"}
            </option>
          </select>
        </div>
      </div>

      {draft.transport === "http" ? (
        <>
          <div className="field">
            <label htmlFor="mcp-url">Server URL</label>
            <input
              id="mcp-url"
              className="input"
              inputMode="url"
              spellCheck={false}
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(e) => set({ url: e.target.value })}
            />
            <span className="small muted">Streamable HTTP is used; older servers that only offer SSE (URLs often ending in /sse) work too.</span>
          </div>
          <div className="field">
            <label htmlFor="mcp-token">Bearer token or API key (optional)</label>
            <input
              id="mcp-token"
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.token}
              placeholder="Sent as Authorization: Bearer …"
              onChange={(e) => set({ token: e.target.value })}
            />
          </div>
          <details className="connector-advanced" open={Boolean(draft.headers || draft.direct || draft.timeoutSec)}>
            <summary className="small muted">Advanced</summary>
            <div className="field">
              <label htmlFor="mcp-headers">Extra headers (one per line)</label>
              <textarea
                id="mcp-headers"
                className="textarea"
                spellCheck={false}
                value={draft.headers}
                placeholder={"X-API-Key: abc123"}
                onChange={(e) => set({ headers: e.target.value })}
              />
            </div>
            <TimeoutField draft={draft} set={set} />
            <label className="toggle compact">
              <input type="checkbox" checked={draft.direct} onChange={(e) => set({ direct: e.target.checked })} />
              <span className="small">Connect directly instead of through the app's relay (the server must allow browser requests)</span>
            </label>
          </details>
        </>
      ) : (
        <>
          <div className="field-row">
            <div className="field connector-command">
              <label htmlFor="mcp-command">Command</label>
              <input id="mcp-command" className="input" spellCheck={false} value={draft.command} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="mcp-args">Arguments</label>
              <input
                id="mcp-args"
                className="input"
                spellCheck={false}
                value={draft.args}
                placeholder="-y @modelcontextprotocol/server-everything"
                onChange={(e) => set({ args: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="mcp-env">Environment variables (NAME=value, one per line)</label>
            <textarea id="mcp-env" className="textarea" spellCheck={false} value={draft.env} placeholder="GITHUB_TOKEN=ghp_…" onChange={(e) => set({ env: e.target.value })} />
          </div>
          <details className="connector-advanced" open={Boolean(draft.cwd || draft.timeoutSec)}>
            <summary className="small muted">Advanced</summary>
            <div className="field">
              <label htmlFor="mcp-cwd">Working folder (optional)</label>
              <input id="mcp-cwd" className="input" spellCheck={false} value={draft.cwd} placeholder="~/Projects" onChange={(e) => set({ cwd: e.target.value })} />
            </div>
            <TimeoutField draft={draft} set={set} />
          </details>
          <label className="toggle compact">
            <input type="checkbox" checked={draft.controlsComputer} onChange={(e) => set({ controlsComputer: e.target.checked })} />
            <span className="small">
              Controls this computer (screen, apps or files): follows Computer access. Off in Sandbox; with Full access its tools run without asking.
            </span>
          </label>
          <span className="small muted">
            The command runs on this computer with your permissions, through your login shell (so <code>npx</code>, <code>uvx</code> and{" "}
            <code>docker</code> are found). Only add servers you trust.
          </span>
        </>
      )}

      {error && <div className="status err">{error}</div>}
      <div className="btn-row connector-actions">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 size={14} className="spin" />} {existing ? "Save" : "Add and connect"}
        </button>
        <button className="btn" onClick={onDone} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Tools that changed after the user approved the connector, or appeared later. They stay off
 * (the AI doesn't even see them) until the user reads what they say now and approves them.
 */
function ToolChanges({ serverId, review }: { serverId: string; review: ToolReview[] }) {
  const [open, setOpen] = useState(false);
  const count = `${review.length} tool${review.length === 1 ? "" : "s"}`;
  return (
    <div className="connector-warning small" role="alert">
      <ShieldAlert size={14} aria-hidden />
      <div className="grow">
        <div>
          {count} changed or appeared since you added this connector, and {review.length === 1 ? "stays" : "stay"} off until you review{" "}
          {review.length === 1 ? "it" : "them"}. A server can change what its tools tell the AI after you approve it.
        </div>
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Review
        </button>
        {open && (
          <ul className="connector-review">
            {review.map((r) => (
              <li key={r.name}>
                <code>{cleanTool({ name: r.name }).tool.name}</code>{" "}
                <span className="badge tool-flag">{r.kind === "new" ? "new" : `changed: ${r.changes.join(", ") || "details"}`}</span>
                {r.kind === "changed" && r.before !== r.after && (
                  <>
                    <div className="small muted">Before</div>
                    <pre>{r.before || "(no description)"}</pre>
                  </>
                )}
                <div className="small muted">{r.kind === "changed" ? "Now" : "Description"}</div>
                <pre>{r.after || "(no description)"}</pre>
                <button className="btn" onClick={() => approveToolChanges(serverId, [r.name])}>
                  Approve
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && review.length > 1 && (
          <div className="btn-row">
            <button className="btn" onClick={() => approveToolChanges(serverId, review.map((r) => r.name))}>
              Approve all {review.length}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TimeoutField({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
  return (
    <div className="field">
      <label htmlFor="mcp-timeout">Time limit per tool call, seconds</label>
      <input
        id="mcp-timeout"
        className="input connector-timeout"
        inputMode="numeric"
        value={draft.timeoutSec}
        placeholder="60"
        onChange={(e) => set({ timeoutSec: e.target.value.replace(/[^\d]/g, "") })}
      />
    </div>
  );
}
