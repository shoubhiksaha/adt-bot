/**
 * Questions from MCP servers (elicitation): a server asks the user for some details (a form) or to
 * open a page (a URL), in the middle of a tool call. 2026-07-28 servers send them inside an
 * input_required result; older ones send an elicitation/create request. Either way they are shown
 * to the user in the chat, under the tool call, and only the user's answer goes back: never the
 * model's, and nothing is filled in automatically.
 */
import { stripHidden } from "./unicode";

export type FieldKind = "string" | "number" | "integer" | "boolean" | "select" | "multi";
export type AnswerValue = string | number | boolean | string[];

export type Field = {
  key: string;
  label: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  options?: { value: string; label: string }[];
  default?: AnswerValue;
};

export type Question =
  | { kind: "form"; connector: string; message: string; fields: Field[]; hidden: number; sensitive: boolean }
  | { kind: "url"; connector: string; message: string; url: string; host: string; warning?: string; hidden: number };

export type ElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, AnswerValue> };

export type InputRequest = { method: string; params?: Record<string, unknown> };

const MESSAGE_CHARS = 2_000;
const TEXT_CHARS = 300;

/** Turns a server's elicitation request into a question for the user, or throws when it can't be shown. */
export function questionFromRequest(request: InputRequest, connector: string): Question {
  if (request.method !== "elicitation/create") throw new Error(`The server asked for something ADT Bot doesn't support (${String(request.method).slice(0, 60)}).`);
  const params = request.params ?? {};
  let hidden = 0;
  const text = (value: unknown, max = TEXT_CHARS) => {
    if (typeof value !== "string") return "";
    const r = stripHidden(value);
    hidden += r.removed;
    return r.text.slice(0, max);
  };
  const message = text(params.message, MESSAGE_CHARS) || "The server needs some details to continue.";
  if (params.mode === "url") {
    const raw = typeof params.url === "string" ? params.url : "";
    if (stripHidden(raw).removed) throw new Error("The server sent a link with hidden characters in it.");
    const { url, host, warning } = checkUrl(raw);
    return { kind: "url", connector, message, url, host, warning, hidden };
  }
  if (params.mode !== undefined && params.mode !== "form") throw new Error(`The server asked in a way ADT Bot doesn't support (${String(params.mode).slice(0, 40)}).`);
  const schema = (params.requestedSchema ?? {}) as { type?: unknown; properties?: unknown; required?: unknown };
  if (schema.type !== undefined && schema.type !== "object") throw new Error("The server's question has a form ADT Bot can't show.");
  const properties = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
  const fields: Field[] = [];
  for (const [rawKey, value] of Object.entries(properties).slice(0, 50)) {
    // The key goes back to the server as is; only what's shown is cleaned.
    hidden += stripHidden(rawKey).removed;
    const field = fieldFrom(rawKey, value as Record<string, unknown>, required.has(rawKey), text);
    if (!field) throw new Error("The server's question has a form ADT Bot can't show.");
    fields.push(field);
  }
  const sensitive = fields.some((f) => SENSITIVE.test(`${f.key} ${f.label} ${f.description ?? ""}`)) || SENSITIVE.test(message);
  return { kind: "form", connector, message, fields, hidden, sensitive };
}

/** Secrets a server mustn't ask for in a form (the spec has them use a web page instead). */
const SENSITIVE = /\b(pass(word|code|phrase)?|secret|api[\s_-]?key|access[\s_-]?token|token|credit[\s_-]?card|card[\s_-]?number|cvv|cvc|ssn|social security|pin)\b/i;

function fieldFrom(key: string, s: Record<string, unknown>, required: boolean, text: (v: unknown, max?: number) => string): Field | null {
  if (!s || typeof s !== "object") return null;
  const label = text(s.title) || text(key);
  const base = { key, label, description: text(s.description, 600) || undefined, required };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (s.type === "boolean") return { ...base, kind: "boolean", default: typeof s.default === "boolean" ? s.default : undefined };
  if (s.type === "number" || s.type === "integer") {
    return { ...base, kind: s.type, minimum: num(s.minimum), maximum: num(s.maximum), default: num(s.default) };
  }
  if (s.type === "string") {
    if (Array.isArray(s.oneOf)) {
      const options = (s.oneOf as { const?: unknown; title?: unknown }[])
        .filter((o) => o && typeof o.const === "string")
        .map((o) => ({ value: o.const as string, label: text(o.title) || text(o.const) }));
      return options.length ? { ...base, kind: "select", options, default: typeof s.default === "string" ? s.default : undefined } : null;
    }
    if (Array.isArray(s.enum)) {
      const names = strings(s.enumNames);
      const options = strings(s.enum).map((value, i) => ({ value, label: text(names[i]) || text(value) }));
      return options.length ? { ...base, kind: "select", options, default: typeof s.default === "string" ? s.default : undefined } : null;
    }
    const format = ["email", "uri", "date", "date-time"].includes(String(s.format)) ? (s.format as Field["format"]) : undefined;
    return { ...base, kind: "string", format, minLength: num(s.minLength), maxLength: num(s.maxLength), default: typeof s.default === "string" ? s.default : undefined };
  }
  if (s.type === "array" && s.items && typeof s.items === "object") {
    const items = s.items as { enum?: unknown; anyOf?: unknown };
    const options = Array.isArray(items.anyOf)
      ? (items.anyOf as { const?: unknown; title?: unknown }[]).filter((o) => o && typeof o.const === "string").map((o) => ({ value: o.const as string, label: text(o.title) || text(o.const) }))
      : strings(items.enum).map((value) => ({ value, label: text(value) }));
    if (!options.length) return null;
    return { ...base, kind: "multi", options, minItems: num(s.minItems), maxItems: num(s.maxItems), default: Array.isArray(s.default) ? strings(s.default) : undefined };
  }
  return null;
}

/** Checks a link a server wants opened: http(s) only, with warnings for look-alike hosts. */
export function checkUrl(raw: string): { url: string; host: string; warning?: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("The server sent a link that isn't a valid web address.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`The server sent a ${parsed.protocol.replace(":", "")} link; only web links are opened.`);
  if (parsed.username || parsed.password) throw new Error("The server sent a link with a sign-in name in it.");
  const host = parsed.hostname;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(host);
  const warning = /(^|\.)xn--/i.test(host)
    ? "This address uses look-alike letters (punycode). Check it's the site you expect."
    : parsed.protocol === "http:" && !local
      ? "This link isn't encrypted (http)."
      : undefined;
  return { url: parsed.toString(), host, warning };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks and converts what the user typed; returns the content to send or an error per field. */
export function validateAnswer(fields: Field[], values: Record<string, unknown>): { content: Record<string, AnswerValue> } | { errors: Record<string, string> } {
  const content: Record<string, AnswerValue> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = values[f.key];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (f.required && f.kind !== "boolean") errors[f.key] = "Required.";
      else if (f.required && f.kind === "boolean") content[f.key] = false;
      continue;
    }
    switch (f.kind) {
      case "boolean":
        content[f.key] = raw === true || raw === "true";
        break;
      case "number":
      case "integer": {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n) || (f.kind === "integer" && !Number.isInteger(n))) errors[f.key] = f.kind === "integer" ? "Enter a whole number." : "Enter a number.";
        else if (f.minimum !== undefined && n < f.minimum) errors[f.key] = `At least ${f.minimum}.`;
        else if (f.maximum !== undefined && n > f.maximum) errors[f.key] = `At most ${f.maximum}.`;
        else content[f.key] = n;
        break;
      }
      case "select": {
        const v = String(raw);
        if (!f.options?.some((o) => o.value === v)) errors[f.key] = "Pick one of the options.";
        else content[f.key] = v;
        break;
      }
      case "multi": {
        const list = (Array.isArray(raw) ? raw : [raw]).map(String);
        if (!list.every((v) => f.options?.some((o) => o.value === v))) errors[f.key] = "Pick from the options.";
        else if (f.minItems !== undefined && list.length < f.minItems) errors[f.key] = `Pick at least ${f.minItems}.`;
        else if (f.maxItems !== undefined && list.length > f.maxItems) errors[f.key] = `Pick at most ${f.maxItems}.`;
        else content[f.key] = list;
        break;
      }
      default: {
        const v = String(raw);
        if (f.minLength !== undefined && v.length < f.minLength) errors[f.key] = `At least ${f.minLength} characters.`;
        else if (f.maxLength !== undefined && v.length > f.maxLength) errors[f.key] = `At most ${f.maxLength} characters.`;
        else if (f.format === "email" && !EMAIL.test(v.trim())) errors[f.key] = "Enter an email address.";
        else if (f.format === "uri" && !validUri(v.trim())) errors[f.key] = "Enter a full web address.";
        else if (f.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) errors[f.key] = "Enter a date (YYYY-MM-DD).";
        else if (f.format === "date-time" && Number.isNaN(Date.parse(v.trim()))) errors[f.key] = "Enter a date and time.";
        else content[f.key] = f.format ? v.trim() : v;
      }
    }
  }
  return Object.keys(errors).length ? { errors } : { content };
}

const validUri = (v: string) => {
  try {
    return Boolean(new URL(v).protocol);
  } catch {
    return false;
  }
};

// Pending questions, shown by the chat under the tool call that asked --------------------------

/** Unanswered questions give up after this long (the server hears "cancel"). */
export const QUESTION_TIMEOUT_MS = 10 * 60_000;

const pending = new Map<string, { question: Question; resolve: (answer: ElicitAnswer) => void }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Shows a question under a tool call and waits for the user. Stop or the time limit answer "cancel". */
export function askUser(callId: string, question: Question, signal?: AbortSignal, timeoutMs = QUESTION_TIMEOUT_MS): Promise<ElicitAnswer> {
  if (pending.has(callId)) return Promise.reject(new Error("The server asked a second question before the first was answered."));
  return new Promise((resolve) => {
    const finish = (answer: ElicitAnswer) => {
      if (pending.get(callId)?.resolve !== finish) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      pending.delete(callId);
      changed();
      resolve(answer);
    };
    const stop = () => finish({ action: "cancel" });
    const timer = setTimeout(stop, timeoutMs);
    pending.set(callId, { question, resolve: finish });
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    changed();
  });
}

export function pendingQuestion(callId: string): Question | undefined {
  return pending.get(callId)?.question;
}

/** The user's answer, from the question card. */
export function answerQuestion(callId: string, answer: ElicitAnswer) {
  pending.get(callId)?.resolve(answer);
}

export function onQuestionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
