// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/**
 * Forgiving JSON reading.
 *
 * Streamed tool arguments and prompted tool blocks arrive truncated,
 * double-encoded or wrapped in prose, so parsing has to survive all three.
 */

export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Close unterminated strings/brackets left by a truncated fragment. */
export function repairJson(text: string): string {
  let out = text.replace(/,\s*([}\]])/g, '$1')
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of out) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString && ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inString) out += '"'
  while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  return out
}

/**
 * Extract the first balanced `{...}` object from arbitrary text.
 * With `autoClose`, an unterminated object is repaired instead of rejected.
 */
export function extractJsonObject(text: string, autoClose = false): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString && ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return autoClose ? repairJson(text.slice(start)) : null
}

/** Parse an object, tolerating truncation, double encoding and surrounding prose. */
export function parseObjectLoose(text: string): Record<string, unknown> | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null

  const direct = safeJsonParse<unknown>(trimmed)
  const unwrapped = typeof direct === 'string' ? safeJsonParse<unknown>(direct) : direct
  if (isPlainObject(unwrapped)) return unwrapped

  const extracted = extractJsonObject(trimmed) ?? extractJsonObject(trimmed, true)
  if (extracted) {
    const parsed = safeJsonParse<unknown>(extracted) ?? safeJsonParse<unknown>(repairJson(extracted))
    if (isPlainObject(parsed)) return parsed
  }
  return null
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
