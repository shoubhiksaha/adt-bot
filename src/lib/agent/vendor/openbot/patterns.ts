// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/**
 * Pattern matching for the approval allowlist / denylist, plus the shell tokenising
 * needed to turn a command into a sensible "always allow" rule.
 */

import { escapeRegex } from './text'

/*
 * A `/body/flags` literal, with flags JavaScript actually accepts.
 *
 * The old test was "starts with `/` and is longer than two characters", split
 * on the *last* slash — which reads an ordinary absolute path as a regex whose
 * final segment is the flags. `/etc/passwd` became `new RegExp('etc',
 * 'passwd')`, threw on the invalid flags, and returned false: a denylist entry
 * that did not match even itself, failing open with no error anywhere. Anchoring
 * the flags to the characters that are really flags means a path falls through
 * to the literal handling below instead.
 */
const REGEX_LITERAL = /^\/(.+)\/([dgimsuvy]*)$/

/**
 * ADT Bot: an allow rule written as a regex must match the whole value (`anchored`): unanchored,
 * `/ls/` allowed any command containing "ls". Deny rules stay unanchored (broader is safer there).
 */
function asRegex(pattern: string, anchored = false): RegExp | undefined {
  const parsed = REGEX_LITERAL.exec(pattern)
  if (!parsed) return undefined
  try {
    return new RegExp(anchored ? `^(?:${parsed[1] ?? ''})$` : (parsed[1] ?? ''), parsed[2] ?? '')
  } catch {
    return undefined
  }
}

/** Whether a rule would be read as a regular expression. */
export function looksLikeRegex(pattern: string): boolean {
  return asRegex(pattern.trim()) !== undefined
}

/**
 * Whitespace runs collapse before literal comparison, because `rm  -rf /` and
 * `rm -rf /` run the same command and only one of them used to match a rule.
 */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * Match a value against an allow/deny pattern.
 *   `/re/flags`  → regular expression (flags must be real regex flags)
 *   `git *`      → glob (`*` = any run, `?` = one character)
 *   `git`        → exact match, or command prefix (`git status` matches)
 *   `/etc/passwd`→ anything else beginning with `/` is a literal path
 */
export function matchPattern(pattern: string, value: string): boolean {
  const raw = pattern.trim()
  if (!raw || !value.trim()) return false

  const rx = asRegex(raw, true)
  if (rx) return rx.test(value.trim())

  const p = normalise(raw)
  const v = normalise(value)

  if (p === v) return true

  if (p.includes('*') || p.includes('?')) {
    const body = Array.from(p)
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRegex(c)))
      .join('')
    try {
      return new RegExp(`^${body}$`).test(v)
    } catch {
      return false
    }
  }

  return v.startsWith(`${p} `)
}

/**
 * Denylist matching is intentionally broader: plain patterns also match as
 * substrings, and case is ignored.
 *
 * An absolute path used to be excluded from the substring fallback, so a rule
 * like `/Users/me/.ssh` — having already failed to parse as a regex — protected
 * nothing at all. A denylist that misses is far worse than one that over-matches,
 * so a path now falls through to the same substring handling as any other
 * literal, and a glob is retried case-insensitively.
 */
export function matchDenyPattern(pattern: string, value: string): boolean {
  if (matchPattern(pattern, value)) return true
  const rx = asRegex(pattern.trim())
  if (rx) return rx.test(value.trim())

  const p = normalise(pattern).toLowerCase()
  const v = normalise(value).toLowerCase()
  if (!p || !v) return false

  if (p.includes('*') || p.includes('?')) return matchPattern(p, v)
  return v.includes(p)
}

export function matchesAny(patterns: string[], values: string[]): string | null {
  for (const p of patterns) {
    for (const v of values) {
      if (v && matchPattern(p, v)) return p
    }
  }
  return null
}

export function matchesAnyDeny(patterns: string[], values: string[]): string | null {
  for (const p of patterns) {
    for (const v of values) {
      if (v && matchDenyPattern(p, v)) return p
    }
  }
  return null
}

/** Split a command into tokens, respecting simple quoting. */
export function shellTokens(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** Pipes, redirects, substitutions — anything that makes generalising a rule unsafe. */
export function hasShellMetacharacters(command: string): boolean {
  return /[;&|><`$(){}]|\n/.test(command)
}
