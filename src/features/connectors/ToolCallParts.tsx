import { ExternalLink, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { connectorToolInfo } from "../../lib/mcp/connectors";
import { answerQuestion, type Field, onQuestionsChanged, pendingQuestion, type Question, validateAnswer } from "../../lib/mcp/elicitation";
import { hasHidden, revealHidden } from "../../lib/mcp/unicode";
import type { ToolCallRecord } from "../../lib/types";
import "./connectors.css";

/** Re-renders when a connector question appears or is answered. */
export function useQuestionsVersion() {
  const [, setVersion] = useState(0);
  useEffect(() => onQuestionsChanged(() => setVersion((v) => v + 1)), []);
}

export const isConnectorTool = (name: string) => Boolean(connectorToolInfo(name));

/**
 * Approval card details for a connector tool: which connector, the tool's whole description, and
 * the exact arguments (hidden characters shown as \u codes), with a warning when the connector's
 * tool metadata had hidden characters.
 */
export function ConnectorApprovalInfo({ call }: { call: ToolCallRecord }) {
  const info = connectorToolInfo(call.name);
  if (!info) return null;
  const args = JSON.stringify(call.args ?? {}, null, 2);
  return (
    <div className="connector-approval">
      {info.connectorHidden > 0 && (
        <div className="connector-warning small" role="alert">
          <ShieldAlert size={14} aria-hidden /> The {info.connector} connector's tool descriptions had hidden characters
          {info.hidden ? ", this tool's too" : ""}. They were removed, but hidden text is a way to slip instructions to the AI: check this
          call does what you asked.
        </div>
      )}
      {hasHidden(args) && (
        <div className="connector-warning small" role="alert">
          <ShieldAlert size={14} aria-hidden /> The arguments contain hidden characters, shown below as \u codes.
        </div>
      )}
      <div className="small muted">
        From the <strong>{info.connector}</strong> connector · tool <code>{info.tool}</code>
      </div>
      <details className="connector-approval-desc">
        <summary className="small">What this tool does</summary>
        <p className="small">{info.description || "The server gave no description."}</p>
      </details>
      <div className="small muted">Exact arguments</div>
      <pre className="approval-detail">{revealHidden(args)}</pre>
    </div>
  );
}

/** A question a connector asked during this tool call, if any. Only the user's answer goes back. */
export function ConnectorQuestion({ callId }: { callId: string }) {
  useQuestionsVersion();
  const question = pendingQuestion(callId);
  if (!question) return null;
  return (
    <div className="approval-card connector-question" role="group" aria-label="Question from a connector">
      <div className="approval-title">
        <MessageCircleQuestion size={15} aria-hidden /> {question.connector} asks
      </div>
      <p className="connector-question-message">{question.message}</p>
      {question.kind === "form" ? <QuestionForm key={callId} callId={callId} question={question} /> : <QuestionLink key={callId} callId={callId} question={question} />}
      <div className="small muted">
        Your answer goes to {question.connector}, not to the AI.
        {question.hidden > 0 && " Hidden characters were removed from this question."}
      </div>
    </div>
  );
}

const initial = (fields: Field[]) => Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));

function QuestionForm({ callId, question }: { callId: string; question: Extract<Question, { kind: "form" }> }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initial(question.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const send = () => {
    const checked = validateAnswer(question.fields, values);
    if ("errors" in checked) return setErrors(checked.errors);
    answerQuestion(callId, { action: "accept", content: checked.content });
  };

  return (
    <form
      className="connector-question-form"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {question.sensitive && (
        <div className="connector-warning small" role="alert">
          <ShieldAlert size={14} aria-hidden /> Don't type passwords, API keys or card numbers here: servers aren't supposed to ask for them in a form.
        </div>
      )}
      {question.fields.map((f) => (
        <FieldInput key={f.key} id={`${callId}-${f.key}`} field={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
      <div className="btn-row">
        <button type="submit" className="btn primary">
          Send
        </button>
        <button type="button" className="btn" onClick={() => answerQuestion(callId, { action: "decline" })}>
          Decline
        </button>
        <button type="button" className="btn" onClick={() => answerQuestion(callId, { action: "cancel" })}>
          Not now
        </button>
      </div>
    </form>
  );
}

function FieldInput({ id, field, value, error, onChange }: { id: string; field: Field; value: unknown; error?: string; onChange: (v: unknown) => void }) {
  const label = (
    <>
      {field.label}
      {field.required && <span aria-hidden> *</span>}
    </>
  );
  const hint = (
    <>
      {field.description && <span className="small muted">{field.description}</span>}
      {error && <span className="small error-text">{error}</span>}
    </>
  );
  if (field.kind === "boolean") {
    return (
      <div className="field">
        <label className="toggle compact">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="small">{label}</span>
        </label>
        {hint}
      </div>
    );
  }
  if (field.kind === "multi") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="field connector-question-multi">
        <legend className="small">{label}</legend>
        {field.options?.map((o) => (
          <label key={o.value} className="toggle compact">
            <input type="checkbox" checked={list.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...list, o.value] : list.filter((v) => v !== o.value))} />
            <span className="small">{o.label}</span>
          </label>
        ))}
        {hint}
      </fieldset>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {field.kind === "select" ? (
        <select id={id} className="select" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className="input"
          type={field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
          inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={field.format === "date-time" ? "2026-10-20T14:30" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint}
    </div>
  );
}

function QuestionLink({ callId, question }: { callId: string; question: Extract<Question, { kind: "url" }> }) {
  const [opened, setOpened] = useState(false);
  const at = question.url.indexOf(question.host);
  return (
    <div className="connector-question-link">
      {/* The whole address, with the site highlighted, before anything opens. */}
      <div className="approval-detail connector-url">
        {at >= 0 ? (
          <>
            {question.url.slice(0, at)}
            <strong>{question.host}</strong>
            {question.url.slice(at + question.host.length)}
          </>
        ) : (
          question.url
        )}
      </div>
      {question.warning && (
        <div className="connector-warning small" role="alert">
          <ShieldAlert size={14} aria-hidden /> {question.warning}
        </div>
      )}
      <div className="btn-row">
        {opened ? (
          <button type="button" className="btn primary" onClick={() => answerQuestion(callId, { action: "accept" })}>
            I've finished there
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              // Opens in your browser, outside the app: neither the app nor the AI sees the page.
              window.open(question.url, "_blank", "noopener,noreferrer");
              setOpened(true);
            }}
          >
            <ExternalLink size={14} aria-hidden /> Open {question.host}
          </button>
        )}
        <button type="button" className="btn" onClick={() => answerQuestion(callId, { action: "decline" })}>
          Decline
        </button>
        <button type="button" className="btn" onClick={() => answerQuestion(callId, { action: "cancel" })}>
          Not now
        </button>
      </div>
    </div>
  );
}
