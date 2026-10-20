/**
 * Apps' controls as macOS accessibility reports them (electron/native/mac-helper.swift), shown to
 * the model as a numbered list it can act on by id or by name.
 */
export type UiElement = {
  id: number;
  role: string;
  label?: string;
  value?: string;
  frame?: { x: number; y: number; w: number; h: number };
  /** Centre in the latest screenshot's pixels, when it's on screen. */
  at?: { x: number; y: number };
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  input?: boolean;
  web?: boolean;
};

export type UiSnapshot = {
  name: string;
  bundleId: string;
  pid: number;
  window: string;
  windows: string[];
  elements: UiElement[];
  matched: number;
  truncated: boolean;
  focusedId?: number;
  frontmost: boolean;
  note?: string;
};

const TEXT_ROLES = new Set(["text", "heading", "image"]);

const quoteText = (s: string) => JSON.stringify(s);

/** One line per element: `[12] button "Send" @(640,712)`. */
export function formatElement(e: UiElement): string {
  const parts = [`[${e.id}] ${e.role}`];
  if (e.label) parts.push(quoteText(e.label));
  if (e.value !== undefined && e.value !== "") parts.push(`${e.input ? "=" : "—"} ${quoteText(e.value)}`);
  else if (e.input) parts.push('= ""');
  const flags = [e.focused && "focused", e.selected && "selected", e.disabled && "disabled"].filter(Boolean);
  if (flags.length) parts.push(`(${flags.join(", ")})`);
  if (e.at && !TEXT_ROLES.has(e.role)) parts.push(`@(${e.at.x},${e.at.y})`);
  return parts.join(" ");
}

export function formatUi(snap: UiSnapshot, limit = 200): string {
  const others = snap.windows.filter((w) => w && w !== snap.window);
  const head = [
    `${snap.name}${snap.window ? ` — window ${quoteText(snap.window)}` : ""}${snap.frontmost ? " (in front)" : " (in the background)"}`,
    others.length ? `Other windows: ${others.slice(0, 8).map(quoteText).join(", ")}` : "",
    snap.note ?? "",
  ].filter(Boolean);
  const shown = snap.elements.slice(0, limit);
  const lines = shown.map(formatElement);
  const hidden = Math.max(snap.matched, snap.elements.length) - shown.length;
  if (!snap.elements.length) lines.push("(no matching controls; try without a query, another window, or mac_screenshot)");
  if (hidden > 0 || snap.truncated) lines.push(`… ${hidden > 0 ? `${hidden} more` : "more"} not shown: pass a query to find something specific.`);
  return [...head, ...lines].join("\n");
}

/** Lowercase, without invisible marks, punctuation runs collapsed. */
export function normalize(text: string): string {
  return text
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, "")
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .trim();
}

function score(e: UiElement, want: string, role?: string): number {
  if (role && !normalize(e.role).includes(normalize(role))) return 0;
  const label = normalize(e.label ?? "");
  const value = normalize(e.value ?? "");
  let s = 0;
  if (label === want) s = 100;
  else if (label.startsWith(want)) s = 80;
  else if (want.split(" ").every((w) => label.includes(w))) s = 60;
  else if (value === want) s = 50;
  else if (value && want.split(" ").every((w) => value.includes(w))) s = 35;
  if (!s) return 0;
  // Something you can act on beats plain text with the same words.
  if (TEXT_ROLES.has(e.role)) s -= 25;
  if (e.disabled) s -= 30;
  if (!e.at) s -= 5;
  return s;
}

export type Pick = { element: UiElement; others: UiElement[] } | { error: string };

/** The element a name refers to ("Send", "Search", "Mom"), or an explanation listing the candidates. */
export function pickElement(elements: UiElement[], text: string, role?: string): Pick {
  const want = normalize(text);
  if (!want) return { error: "Say which element: give its [id] from mac_ui, or its text." };
  const ranked = elements
    .map((e) => ({ e, s: score(e, want, role) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return { error: `Nothing called ${quoteText(text)}${role ? ` (${role})` : ""} is in the window. Check mac_ui's list, or take a screenshot.` };
  const best = ranked[0];
  const ties = ranked.filter((r) => r.s === best.s && r.e !== best.e);
  // Several different things share the best match: let the model choose rather than guess.
  if (ties.length && ties.some((t) => normalize(t.e.label ?? "") !== normalize(best.e.label ?? "") || t.e.role !== best.e.role)) {
    return { error: `Several elements match ${quoteText(text)}; press one by id:\n${[best, ...ties].slice(0, 8).map((r) => formatElement(r.e)).join("\n")}` };
  }
  return { element: best.e, others: ties.map((t) => t.e) };
}

/** Labels of buttons that delete, pay, or can't be undone: pressing them always asks first. */
export const RISKY_LABEL =
  /\b(delete|remove|erase|trash|empty|uninstall|discard|wipe|format|reset|revoke|deactivate|unsubscribe|sign ?out|log ?out|block|report|pay|purchase|buy|checkout|place order|transfer|confirm payment)\b/i;
