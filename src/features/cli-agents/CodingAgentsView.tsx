import { CheckCircle2, CircleSlash, Loader2, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  CLI_AGENT_NAMES,
  detectCliAgents,
  PERMISSION_LABELS,
  runCliAgent,
  Transcript,
  type CliAgentId,
  type CliPermission,
  type DetectedCli,
} from "../../lib/cli-agents/client";
import "./cli-agents.css";

type Run = {
  id: string;
  agent: CliAgentId;
  prompt: string;
  folder: string;
  status: "running" | "done" | "error" | "cancelled";
  transcript: string;
  sessionId: string;
  result: string;
  error: string;
  startedAt: number;
  ms?: number;
  resumed?: string;
};

/** Runs live outside the component, so leaving the view doesn't lose a running transcript. */
const useRuns = create<{ runs: Run[] }>(() => ({ runs: [] }));
const controllers = new Map<string, AbortController>();

function patchRun(id: string, patch: Partial<Run>) {
  useRuns.setState((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

async function startRun(options: { agent: CliAgentId; prompt: string; folder: string; permission: CliPermission; model: string; resumeSession?: string }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const run: Run = {
    id,
    agent: options.agent,
    prompt: options.prompt,
    folder: options.folder,
    status: "running",
    transcript: "",
    sessionId: options.resumeSession ?? "",
    result: "",
    error: "",
    startedAt: Date.now(),
    resumed: options.resumeSession,
  };
  useRuns.setState((s) => ({ runs: [run, ...s.runs].slice(0, 12) }));
  const controller = new AbortController();
  controllers.set(id, controller);
  const transcript = new Transcript(400_000);
  let lastPaint = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const paint = () => {
    timer = null;
    lastPaint = Date.now();
    patchRun(id, { transcript: transcript.toString() });
  };
  try {
    const summary = await runCliAgent(
      {
        agent: options.agent,
        prompt: options.prompt,
        cwd: options.folder || undefined,
        permission: options.permission,
        model: options.model || undefined,
        resumeSession: options.resumeSession,
        timeoutMs: 60 * 60_000,
      },
      (event) => {
        transcript.push(event);
        if (event.type === "session") patchRun(id, { sessionId: event.sessionId });
        // Repaint at most ~10 times a second.
        if (Date.now() - lastPaint > 100) paint();
        else timer ??= setTimeout(paint, 100);
      },
      controller.signal,
    );
    if (timer) clearTimeout(timer);
    patchRun(id, {
      transcript: transcript.toString(),
      status: summary.cancelled ? "cancelled" : summary.ok ? "done" : "error",
      sessionId: summary.sessionId || run.sessionId,
      result: summary.result,
      error: summary.ok ? "" : summary.error,
      folder: summary.cwd || options.folder,
      ms: summary.durationMs,
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    const cancelled = (error as Error).name === "AbortError";
    patchRun(id, { transcript: transcript.toString(), status: cancelled ? "cancelled" : "error", error: cancelled ? "Cancelled." : (error as Error).message });
  } finally {
    controllers.delete(id);
  }
}

export default function CodingAgentsView() {
  const [agents, setAgents] = useState<DetectedCli[] | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [detectError, setDetectError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [agent, setAgent] = useState<CliAgentId>("claude");
  const [folder, setFolder] = useState("");
  const [permission, setPermission] = useState<CliPermission>("default");
  const [model, setModel] = useState("default");
  const [task, setTask] = useState("");
  const [continueSession, setContinueSession] = useState(true);
  const runs = useRuns((s) => s.runs);
  const [selected, setSelected] = useState<string | null>(null);
  const run = runs.find((r) => r.id === selected) ?? runs[0];
  const outputRef = useRef<HTMLPreElement>(null);

  const detect = useCallback(async () => {
    setDetecting(true);
    setDetectError("");
    try {
      const result = await detectCliAgents();
      setAgents(result.agents);
      setWorkspace(result.workspace);
      setAgent((current) => (result.agents.some((a) => a.id === current && a.installed) ? current : (result.agents.find((a) => a.installed)?.id ?? current)));
    } catch (error) {
      setDetectError((error as Error).message);
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  useEffect(() => {
    const el = outputRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [run?.transcript]);

  const info = agents?.find((a) => a.id === agent);
  const installed = agents?.filter((a) => a.installed) ?? [];
  // Follow-ups continue the selected run's session when it belongs to the same agent.
  const resumable = run && run.agent === agent && run.sessionId && run.status !== "running" && info?.resume ? run : null;
  const busy = runs.some((r) => r.status === "running" && r.agent === agent && r.folder === folder);

  const submit = () => {
    const prompt = task.trim();
    if (!prompt || !info?.installed) return;
    setTask("");
    setSelected(null);
    void startRun({
      agent,
      prompt,
      folder: resumable && continueSession ? run.folder : folder.trim(),
      permission,
      model: model === "default" ? "" : model,
      resumeSession: resumable && continueSession ? resumable.sessionId : undefined,
    });
  };

  return (
    <div className="cli-agents">
      <section className="cli-agents-intro">
        <p className="muted small">
          Run command-line AI tools installed on this computer. They work in a folder with their own tools and logins; your bots can also hand them
          tasks with the <code>delegate_to_cli_agent</code> tool, or use one as their model (Settings → Providers → Coding agents).
        </p>
        <button type="button" className="btn" onClick={() => void detect()} disabled={detecting}>
          {detecting ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Detect again
        </button>
      </section>

      {detectError && <div className="status err">{detectError}</div>}

      <div className="cli-agents-grid">
        {(agents ?? []).map((a) => (
          <button
            type="button"
            key={a.id}
            className={`card cli-agent-card${a.id === agent ? " active" : ""}${a.installed ? "" : " missing"}`}
            onClick={() => a.installed && setAgent(a.id)}
            disabled={!a.installed}
            title={a.path ?? a.install}
          >
            <span className="cli-agent-name">
              {a.installed ? <CheckCircle2 size={14} className="ok" /> : <CircleSlash size={14} />} {a.name}
            </span>
            <span className="small muted">{a.installed ? (a.version ? `v${a.version}` : "installed") : "not installed"}</span>
            {!a.installed && <code className="cli-install">{a.install}</code>}
            {a.error && <span className="small cli-warn">{a.error.slice(0, 120)}</span>}
          </button>
        ))}
        {!agents && !detectError && (
          <div className="muted small">
            <Loader2 size={14} className="spin" /> Looking for installed tools…
          </div>
        )}
      </div>

      {agents && !installed.length && (
        <p className="muted small">None of the supported tools were found on your PATH. Install one of them, then press “Detect again”.</p>
      )}

      {installed.length > 0 && (
        <section className="card cli-run-form">
          <div className="cli-form-row">
            <label className="field">
              <span className="field-label">Agent</span>
              <select className="select" value={agent} onChange={(e) => setAgent(e.target.value as CliAgentId)}>
                {installed.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span className="field-label">Folder</span>
              <input className="input" placeholder={workspace || "ADT Bot Workspace"} value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
            </label>
          </div>
          <div className="cli-form-row">
            <label className="field grow">
              <span className="field-label">Permissions</span>
              <select className="select" value={permission} onChange={(e) => setPermission(e.target.value as CliPermission)}>
                {(Object.keys(PERMISSION_LABELS) as CliPermission[]).map((p) => (
                  <option key={p} value={p}>
                    {PERMISSION_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                {(info?.models ?? ["default"]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {permission === "bypass" && (
            <div className="status err">The agent will run commands and change files without asking. Only use this in a folder you can afford to lose.</div>
          )}
          <textarea
            className="textarea"
            placeholder={resumable && continueSession ? "Follow-up for the same session…" : `What should ${CLI_AGENT_NAMES[agent]} do?`}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={submit} disabled={!task.trim() || !info?.installed || busy}>
              <Play size={14} /> {resumable && continueSession ? "Continue" : "Run"}
            </button>
            {resumable && (
              <label className="small cli-continue">
                <input type="checkbox" checked={continueSession} onChange={(e) => setContinueSession(e.target.checked)} /> Continue session{" "}
                <code>{resumable.sessionId.slice(0, 13)}</code>
              </label>
            )}
            <span className="small muted">⌘/Ctrl + Enter</span>
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section className="cli-runs">
          <div className="cli-run-tabs">
            {runs.map((r) => (
              <button type="button" key={r.id} className={`cli-run-tab ${r.status}${r.id === run?.id ? " active" : ""}`} onClick={() => setSelected(r.id)} title={r.prompt}>
                {r.status === "running" && <Loader2 size={12} className="spin" />} {CLI_AGENT_NAMES[r.agent]}: {r.prompt.slice(0, 32)}
              </button>
            ))}
            <button
              type="button"
              className="icon-btn"
              aria-label="Clear finished runs"
              title="Clear finished runs"
              onClick={() => useRuns.setState((s) => ({ runs: s.runs.filter((r) => r.status === "running") }))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {run && (
            <div className="card cli-run">
              <div className="cli-run-head">
                <div className="grow small">
                  <strong>{CLI_AGENT_NAMES[run.agent]}</strong>
                  {run.folder && <span className="muted"> · {run.folder}</span>}
                  {run.sessionId && <span className="muted"> · session {run.sessionId}</span>}
                  {run.ms !== undefined && <span className="muted"> · {(run.ms / 1000).toFixed(1)} s</span>}
                </div>
                {run.status === "running" ? (
                  <button type="button" className="btn danger" onClick={() => controllers.get(run.id)?.abort()}>
                    <Square size={13} /> Cancel
                  </button>
                ) : (
                  <span className={`badge cli-status ${run.status}`}>{run.status}</span>
                )}
              </div>
              <div className="cli-prompt small">
                {run.resumed ? "↳ " : "› "}
                {run.prompt}
              </div>
              <pre className="cli-transcript" ref={outputRef}>
                {run.transcript || (run.status === "running" ? "Starting…" : "")}
              </pre>
              {run.error && <div className="status err">{run.error}</div>}
              {run.status === "done" && run.result && (
                <div className="cli-result">
                  <div className="field-label">Result</div>
                  <div className="cli-result-text">{run.result}</div>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
