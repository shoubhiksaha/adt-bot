// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/** Tolerant JSON handling for model output, which is rarely clean JSON. */

import { truncate } from './text'

/**
 * How many characters one `extractJson` may look at.
 *
 * Every `{` or `[` starts a scan that runs to the end of the string when it finds
 * no partner, so a long run of unmatched openers is quadratic — and this runs on
 * model and agent-CLI output during memory extraction, on the main process's own
 * thread, where a busy loop freezes the window. Genuine embedded JSON matches
 * within the first scans, so the budget only ever cuts short text that was never
 * going to parse.
 */
const SCAN_BUDGET = 2_000_000

/** Index of the bracket closing the one at `start`, or -1 before `limit` is reached. */
function matchBracket(text: string, start: number, limit: number): number {
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < limit; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** First parseable JSON object/array embedded anywhere in `text`, within the budget. */
export function extractJson(text: string): unknown {
  let budget = SCAN_BUDGET
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '{' && c !== '[') continue
    if (budget <= 0) break
    const limit = Math.min(text.length, i + budget)
    const end = matchBracket(text, i, limit)
    budget -= (end < 0 ? limit : end + 1) - i
    if (end <= i) continue
    try {
      return JSON.parse(text.slice(i, end + 1))
    } catch {
      /* not valid here — keep scanning */
    }
  }
  return undefined
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** JSON.stringify that never throws and never floods a prompt. */
export function stringifySafe(value: unknown, max = 4000): string {
  if (typeof value === 'string') return truncate(value, max)
  try {
    return truncate(JSON.stringify(value) ?? String(value), max)
  } catch {
    return truncate(String(value), max)
  }
}
