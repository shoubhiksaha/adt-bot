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
  // "text area", "search field": a field without a name is called by its kind (saved recipes do this).
  else if (normalize(e.role) === want) s = label ? 20 : 40;
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
  if (!ranked.length) return { error: `Nothing called ${quoteText(text)}${role ? ` (${role})` : ""} is in the window. Check mac_ui's list; for web pages use mac_browser, and for text accessibility can't see, mac_find_text.` };
  const best = ranked[0];
  const ties = ranked.filter((r) => r.s === best.s && r.e !== best.e);
  // Several different things share the best match: let the model choose rather than guess.
  // (Unnamed ones can't be told apart at all.)
  if (ties.length && (!best.e.label || ties.some((t) => normalize(t.e.label ?? "") !== normalize(best.e.label ?? "") || t.e.role !== best.e.role))) {
    return { error: `Several elements match ${quoteText(text)}; press one by id:\n${[best, ...ties].slice(0, 8).map((r) => formatElement(r.e)).join("\n")}` };
  }
  return { element: best.e, others: ties.map((t) => t.e) };
}

/** Labels of buttons that delete, pay, or can't be undone: pressing them always asks first. */
export const RISKY_LABEL =
  /\b(delete|remove|erase|trash|empty|uninstall|discard|wipe|format|reset|revoke|deactivate|unsubscribe|sign ?out|log ?out|block|report|pay|purchase|buy|checkout|place order|transfer|confirm payment)\b/i;

/** A web page in the user's browser, as electron/features/70-mac-control.cjs reads it. */
export type PageElement = UiElement & { href?: string; offscreen?: boolean };
export type PageSnapshot = {
  browser: string;
  url: string;
  title: string;
  elements: PageElement[];
  matched: number;
  scroll?: { y: number; height: number; view: number };
  text?: string;
  textLength?: number;
};

export function formatPage(page: PageSnapshot, offset = 0): string {
  const head = `${page.browser} — ${page.title ? `${quoteText(page.title)} ` : ""}${page.url}`;
  const lines = page.elements.map((e) => {
    const parts = [formatElement({ ...e, at: undefined })];
    if (e.href && e.role === "link") parts.push(`→ ${e.href}`);
    if (e.offscreen) parts.push("(scrolled out of view)");
    return parts.join(" ");
  });
  if (!page.elements.length) lines.push("(nothing to click or type into matches)");
  if (page.matched > page.elements.length) lines.push(`… ${page.matched - page.elements.length} more not shown: pass a query to find something specific.`);
  const below = page.scroll && page.scroll.height > page.scroll.y + page.scroll.view + 40 ? "There's more of the page below." : "";
  const text =
    page.text !== undefined
      ? `\n\nPage text${offset ? ` from character ${offset}` : ""}${page.textLength !== undefined ? ` (${page.textLength} characters in all)` : ""}:\n${page.text}${
          page.textLength !== undefined && offset + page.text.length < page.textLength ? `\n… continues: read again with offset ${offset + page.text.length}.` : ""
        }`
      : "";
  return [head, below, ...lines].filter(Boolean).join("\n") + text;
}

/** Lines of text recognized on screen that contain all the words asked for. */
export function matchLines<T extends { text: string }>(lines: T[], query: string): T[] {
  const words = normalize(query).split(" ").filter(Boolean);
  if (!words.length) return lines;
  return lines.filter((l) => {
    const t = normalize(l.text);
    return words.every((w) => t.includes(w));
  });
}
