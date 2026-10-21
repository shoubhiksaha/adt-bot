import { Ban, Check, ChevronRight, Loader2, MessageSquare, ShieldAlert, ShieldCheck, Undo2, Wrench, X } from "lucide-react";
import { askTitle, mainArg } from "../lib/agent/asks";
import { VideoPlayer } from "./VideoPlayer";
import { useEffect, useState } from "react";
import { isPending, onApprovalsChanged } from "../lib/agent/approvals";
import { describeRewind, type RewindResult, type TurnChanges } from "../lib/agent/rewind";
import { answerApproval } from "../lib/agent/loop";
import { desktopInvoke, isDesktop } from "../lib/desktop";
import { openConversation, useStore } from "../lib/store";
import { ConnectorApprovalInfo, ConnectorQuestion, isConnectorTool, useQuestionsVersion } from "../features/connectors/ToolCallParts";
import { openView } from "../features/registry";
import { pendingQuestion } from "../lib/mcp/elicitation";
import type { ToolCallRecord } from "../lib/types";
import { Visualization } from "./viz/Visualization";

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
  visualize: "Drew a chart",
  ask_bot: "Asked another bot",
  mac_ui: "Looked at",
  mac_press: "Pressed",
  mac_set_text: "Typed",
  mac_screenshot: "Took a screenshot",
  mac_click: "Clicked",
  mac_type: "Typed",
  mac_key: "Pressed",
  mac_scroll: "Scrolled",
  mac_drag: "Dragged",
  mac_open_app: "Opened",
  mac_list_apps: "Checked open apps",
  mac_applescript: "Ran an AppleScript",
  mac_browser: "Used the browser",
  mac_find_text: "Read the screen",
  mac_recipes: "Recipes",
  mac_recipe_run: "Ran a recipe",
  create_routine: "Scheduled",
  update_routine: "Changed a routine",
  delete_routine: "Deleted a routine",
  list_routines: "Checked routines",
};


/** Tools whose file changes the desktop side keeps per turn, so the turn can be undone. */
const FILE_TOOLS = new Set(["write_file", "run_command"]);


function label(call: ToolCallRecord): string {
  const base = LABELS[call.name] ?? call.name.replace(/^mcp_/, "").replace(/[_-]+/g, " ");
  const main = mainArg(call);
  if (call.name === "mac_press" && !main && typeof call.args.id === "number") return `${base} an element`;
  if (call.name === "rewind") return call.args.action === "undo" ? "Undid file changes" : "Checked file changes";
  return main ? `${base}: ${main}` : base;
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
export function ToolCalls({ calls, live, turn }: { calls: ToolCallRecord[]; live: boolean; turn?: string }) {
  usePendingVersion();
  useQuestionsVersion();
  // A connector's question (elicitation) waits on the user like an approval does.
  const asking = calls.some((c) => c.status === "running" && pendingQuestion(c.id));
  const waiting = asking || calls.some((c) => c.status === "awaiting");
  const [open, setOpen] = useState(false);
  const expanded = open || waiting || (live && calls.some((c) => c.status === "running"));
  const done = calls.filter((c) => c.status === "done").length;
  const changedFiles = !live && Boolean(turn) && isDesktop() && calls.some((c) => FILE_TOOLS.has(c.name) && c.status === "done");

  return (
    <div className="tool-calls">
      <button type="button" className="tool-calls-head" onClick={() => setOpen((v) => !v)} aria-expanded={expanded}>
        <Wrench size={13} />
        {live && !waiting ? "Working…" : asking ? "Needs your answer" : waiting ? "Needs your approval" : `Used ${calls.length} tool${calls.length === 1 ? "" : "s"}`}
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
      {/* Charts stay visible when the list is collapsed. */}
      {calls.map(
        (call) =>
          call.display?.kind === "visualization" && (
            <div key={`viz-${call.id}`} className="tool-visualizations">
              <Visualization spec={call.display.spec} />
            </div>
          ),
      )}
      {changedFiles && turn && <UndoFileChanges turn={turn} />}
    </div>
  );
}

type UndoState =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "confirm"; changes: TurnChanges }
  | { step: "working" }
  | { step: "done"; text: string };

/**
 * "Undo this turn's file changes": lists what will be put back, deleted or left alone (files changed
 * since the bot changed them), and only acts after the user confirms.
 */
function UndoFileChanges({ turn }: { turn: string }) {
  const [state, setState] = useState<UndoState>({ step: "idle" });
  const [force, setForce] = useState(false);

  const load = async () => {
    setState({ step: "loading" });
    try {
      const changes = await desktopInvoke<TurnChanges>("adt:system:changes", { turn });
      if (!changes.files.length) setState({ step: "done", text: "No file changes to undo (they're kept for 7 days, and an undone turn can't be undone twice)." });
      else {
        setForce(false);
        setState({ step: "confirm", changes });
      }
    } catch (error) {
      setState({ step: "done", text: `Couldn't read this turn's file changes: ${(error as Error).message}` });
    }
  };

  const undo = async () => {
    setState({ step: "working" });
    try {
      setState({ step: "done", text: describeRewind(await desktopInvoke<RewindResult>("adt:system:rewind", { turn, force, by: "user" })) });
    } catch (error) {
      setState({ step: "done", text: `Couldn't undo: ${(error as Error).message}` });
    }
  };

  if (state.step === "idle" || state.step === "loading") {
    return (
      <div className="tool-undo">
        <button type="button" className="link-btn" onClick={load} disabled={state.step === "loading"}>
          {state.step === "loading" ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />} Undo this turn's file changes
        </button>
      </div>
    );
  }
  if (state.step === "working") {
    return (
      <div className="tool-undo small muted">
        <Loader2 size={13} className="spin" /> Undoing…
      </div>
    );
  }
  if (state.step === "done") {
    return (
      <div className="tool-undo small muted">
        {state.text}{" "}
        <button type="button" className="link-btn" onClick={load}>
          Check again
        </button>
      </div>
    );
  }

  const files = state.changes.files;
  const ready = files.filter((f) => f.restorable && !f.changedSince);
  const newer = files.filter((f) => f.restorable && f.changedSince);
  const stuck = files.filter((f) => !f.restorable);
  const restore = ready.filter((f) => f.change !== "created");
  const remove = ready.filter((f) => f.change === "created");
  const list = (items: TurnChanges["files"]) => <pre className="approval-detail">{items.map((f) => f.path).join("\n")}</pre>;
  return (
    <div className="approval-card tool-undo-card" role="group" aria-label="Undo file changes">
      <div className="approval-title">
        <Undo2 size={15} /> Undo this turn's file changes?
      </div>
      {restore.length > 0 && (
        <>
          <div className="small">Put back as they were before this turn:</div>
          {list(restore)}
        </>
      )}
      {remove.length > 0 && (
        <>
          <div className="small">Delete (the bot created them):</div>
          {list(remove)}
        </>
      )}
      {newer.length > 0 && (
        <>
          <div className="small">Changed again after the bot changed them, so left as they are:</div>
          {list(newer)}
          <label className="toggle small">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>Undo these too (the newer changes are lost)</span>
          </label>
        </>
      )}
      {stuck.length > 0 && (
        <>
          <div className="small muted">Can't be undone (too big to keep a copy):</div>
          {list(stuck)}
        </>
      )}
      <div className="btn-row">
        <button type="button" className="btn primary" onClick={undo} disabled={!ready.length && !(force && newer.length)}>
          Undo changes
        </button>
        <button type="button" className="btn" onClick={() => setState({ step: "idle" })}>
          Cancel
        </button>
      </div>
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
      {(call.status === "running" || call.status === "pending") && call.result && <div className="tool-progress small muted">{call.result}</div>}
      {call.review && !awaiting && (
        <div className={`tool-progress small muted tool-review ${call.review.verdict}`}>
          <ShieldCheck size={12} /> AI reviewer {call.review.verdict === "allow" ? "allowed this" : call.review.verdict === "block" ? "stopped this" : "asked you"}: {call.review.reason}
        </div>
      )}
      {call.status === "running" && <ConnectorQuestion callId={call.id} />}

      {awaiting && call.approval && (
        <div className="approval-card" role="group" aria-label="Approval needed">
          <div className="approval-title">
            <ShieldAlert size={15} /> {askTitle(call)}
          </div>
          {/\s/.test(call.approval.reason ?? "") && <div className="small muted approval-reason">Asking because {call.approval.reason}.</div>}
          {isConnectorTool(call.name) ? <ConnectorApprovalInfo call={call} /> : <pre className="approval-detail">{call.approval.detail}</pre>}
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

      {/* Screenshots are embedded images; an address (e.g. from an imported chat) isn't loaded. */}
      {call.display?.kind === "image" && /^data:image\//.test(call.display.src) && (
        <img className="tool-image" src={call.display.src} alt={call.display.caption ?? "Tool output"} />
      )}
      {call.display?.kind === "terminal" && (details || call.status === "error") && <pre className="tool-terminal">{call.display.text}</pre>}
      {call.display?.kind === "conversation" && <ConversationLink display={call.display} />}
      {call.display?.kind === "video" && <VideoPlayer mediaId={call.display.mediaId} name={call.display.name} />}
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
