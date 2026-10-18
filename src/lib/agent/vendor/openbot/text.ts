// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/** String shaping used by prompts, summaries and routine step intents. */

export function truncate(text: string, max: number, suffix = '…'): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix
}

/** Collapse whitespace and keep the leading sentence — a one-line gist. */
export function firstSentence(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const m = /^(.{10,}?[.!?])(\s|$)/.exec(flat)
  return truncate(m ? m[1] : flat, max)
}

export function oneLine(text: string, max = 200): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Lowercased significant words — the basis for cheap similarity checks. */
export function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}
