// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See ../agent/vendor/openbot/LICENSE.
/**
 * Coercion helpers for visualisation specs.
 *
 * Everything here exists because the input is model output: it may be missing, the wrong type,
 * a number as a string, or absurdly long. Each helper returns a usable value rather than
 * throwing, so a malformed spec still renders.
 */

import { VISUALIZATION_KINDS, VISUALIZATION_TONES, type VisualizationTone } from "../agent/vendor/openbot/visualization";

export const MAX_GRID = 8;

export const KINDS = new Set<string>(VISUALIZATION_KINDS);
export const TONES = new Set<string>(VISUALIZATION_TONES);

export type Loose = Record<string, unknown>;

/**
 * `String(value)` minus the ways it throws: `{"toString": 1}` is valid JSON and converting it
 * raises inside a React render. Symbols and null-prototype objects fail the same way.
 */
function asString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * Collapse whitespace and clamp length. The leading slice keeps the whitespace scan off a
 * runaway string (a 10 MB "title" is a plausible generation).
 */
export function text(value: unknown, fallback: string, max: number): string {
  if (value === null || value === undefined) return fallback;
  const flat = asString(value)
    .slice(0, max * 8 + 64)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return flat === "" ? fallback : flat;
}

/** As `text`, but an empty result means "field absent" rather than "use the fallback". */
export function optionalText(value: unknown, max: number): string | undefined {
  const flat = text(value, "", max);
  return flat === "" ? undefined : flat;
}

export function tone(value: unknown): VisualizationTone | undefined {
  const key = asString(value ?? "")
    .trim()
    .toLowerCase();
  return TONES.has(key) ? (key as VisualizationTone) : undefined;
}

/**
 * Numbers arrive as `12`, `"12"`, `"1,200"`, `"12%"`, `"18ms"` or `"$4.50"`. Falling back to the
 * first number in the string is wrong far less often than falling back to zero.
 */
export function finite(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const cleaned = value.replace(/[,\s%]/g, "");
    if (cleaned !== "") {
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
    }
    const embedded = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (embedded) return Number(embedded[0]);
  }
  return fallback;
}

/** A 0..MAX_GRID integer, or `undefined` when the field was never supplied. */
export function gridIndex(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(MAX_GRID, Math.floor(n)));
}

/**
 * Read a collection field. Accepts a real array, a JSON string holding one (common when a
 * backend re-serialises tool arguments), or nothing.
 */
export function rows(value: unknown, cap: number): Loose[] {
  let list: unknown = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.slice(0, cap).map((item) => (item && typeof item === "object" ? (item as Loose) : { label: item }));
}

/** True when the caller supplied the field at all, in any of the forms `rows` accepts. */
export function present(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === "string" && value.trim().startsWith("["));
}
