import { Ban, Check, ChevronRight, Loader2, MessageSquare, ShieldAlert, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { isPending, onApprovalsChanged } from "../lib/agent/approvals";
import { answerApproval } from "../lib/agent/loop";
import { openConversation, useStore } from "../lib/store";
import { openView } from "../features/registry";
import type { ToolCallRecord } from "../lib/types";

const LABELS: Record<string, string> = {
  web_search: "Searched the web",
  read_url: "Read a page",
  search_knowledge: "Searched knowledge",
  remember: "Saved to memory",
  create_image: "Created an image",
  current_time: "Checked the time",
  calculate: "Calculated",
  run_command: "Ran a command",
  read_file: "Read a file",
  write_file: "Wrote a file",
  list_files: "Listed files",
  open_on_computer: "Opened on your computer",
  find_tools: "Looked for tools",
  ask_bot: "Asked another bot",
};

function label(call: ToolCallRecord): string {
  const base = LABELS[call.name] ?? call.name.replace(/[_-]+/g, " ");
  const main = ["query", "url", "command", "path", "fact", "expression", "prompt", "target", "task"].map((k) => call.args[k]).find((v) => typeof v === "string") as
    | string
    | undefined;
  return main ? `${base}: ${main.length > 90 ? `${main.slice(0, 90)}…` : main}` : base;
}

function StatusIcon({ status }: { status: ToolCallRecord["status"] }) {
  if (status === "running" || status === "pending") return <Loader2 size={14} className="spin" />;
  if (status === "done") return <Check size={14} className="ok-icon" />;
  if (status === "awaiting") return <ShieldAlert size={14} className="warn-icon" />;
  if (status === "denied") return <Ban size={14} className="muted" />;
  return <X size={14} className="error-text" />;
}

function usePendingVersion() {
  const [, setVersion] = useState(0);
  useEffect(() => onApprovalsChanged(() => setVersion((v) => v + 1)), []);
}

/** The tools a bot used for an answer, with approval cards for actions waiting on the user. */
export function ToolCalls({ calls, live }: { calls: ToolCallRecord[]; live: boolean }) {
  usePendingVersion();
  const waiting = calls.some((c) => c.status === "awaiting");
  const [open, setOpen] = useState(false);
  const expanded = open || waiting || (live && calls.some((c) => c.status === "running"));
  const done = calls.filter((c) => c.status === "done").length;

  return (
    <div className="tool-calls">
      <button type="button" className="tool-calls-head" onClick={() => setOpen((v) => !v)} aria-expanded={expanded}>
        <Wrench size={13} />
        {live && !waiting ? "Working…" : waiting ? "Needs your approval" : `Used ${calls.length} tool${calls.length === 1 ? "" : "s"}`}
        {!live && done !== calls.length && <span className="muted"> · {calls.length - done} not completed</span>}
        <ChevronRight size={13} className={`chev${expanded ? " open" : ""}`} />
      </button>
      {expanded && (
        <ol className="tool-list">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCallRecord }) {
  const [details, setDetails] = useState(false);
  const awaiting = call.status === "awaiting";
  const actionable = awaiting && isPending(call.id);

  return (
    <li className={`tool-row ${call.status}`}>
      <button type="button" className="tool-row-head" onClick={() => setDetails((v) => !v)}>
        <StatusIcon status={call.status} />
        <span className="grow ellipsis">{label(call)}</span>
        {call.ms !== undefined && call.status !== "awaiting" && <span className="small muted">{(call.ms / 1000).toFixed(1)}s</span>}
      </button>
      {call.status === "running" && call.result && <div className="tool-progress small muted">{call.result}</div>}

      {awaiting && call.approval && (
        <div className="approval-card" role="group" aria-label="Approval needed">
          <div className="approval-title">
            <ShieldAlert size={15} /> Allow {call.approval.summary}?
          </div>
          <pre className="approval-detail">{call.approval.detail}</pre>
          {actionable ? (
            <div className="btn-row">
              <button type="button" className="btn primary" onClick={() => answerApproval(call, "once")}>
                Allow once
              </button>
              {call.approval.allowAlways && (
                <button type="button" className="btn" onClick={() => answerApproval(call, "always")}>
                  Always allow
                </button>
              )}
              <button type="button" className="btn danger" onClick={() => answerApproval(call, "deny")}>
                Deny
              </button>
            </div>
          ) : (
            <div className="small muted">This request expired (the app was reloaded or the reply was stopped).</div>
          )}
        </div>
      )}

      {call.display?.kind === "image" && <img className="tool-image" src={call.display.src} alt={call.display.caption ?? "Tool output"} />}
      {call.display?.kind === "terminal" && (details || call.status === "error") && <pre className="tool-terminal">{call.display.text}</pre>}
      {call.display?.kind === "conversation" && <ConversationLink display={call.display} />}
      {details && (
        <div className="tool-details">
          <div className="small muted">Input</div>
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
          {call.result && call.display?.kind !== "terminal" && call.display?.kind !== "conversation" && (
            <>
              <div className="small muted">Result</div>
              <pre>{call.result}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function ConversationLink({ display }: { display: Extract<NonNullable<ToolCallRecord["display"]>, { kind: "conversation" }> }) {
  const exists = useStore((s) => Boolean(s.conversations[display.conversationId]));
  return (
    <div className="tool-progress small">
      {display.text && <pre className="tool-terminal">{display.text}</pre>}
      {exists && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            openConversation(display.conversationId);
            openView(null);
          }}
        >
          <MessageSquare size={13} /> {display.label}
        </button>
      )}
    </div>
  );
}
