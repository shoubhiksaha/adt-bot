// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/** Small, dependency-free five-field cron matcher for routine scheduling. */

interface Field {
  values: Set<number>
  wildcard: boolean
}

export interface ParsedCron {
  minute: Field
  hour: Field
  day: Field
  month: Field
  weekday: Field
}

const LIMITS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
] as const

/*
 * `7` means Sunday, and ONLY in the weekday field.
 *
 * Cron accepts both 0 and 7 for Sunday, so the weekday field folds 7 down to 0.
 * That fold used to live here, where every field passes through: `0 7 * * *`
 * parsed its hour as midnight, so "every day at 07:00" ran at 00:00; `0 9 7 * *`
 * lost the 7th of the month and never fired at all; and a plain `* * * * *`
 * skipped seven minutes past every hour. Only the caller knows which field it
 * is holding, so only the caller may ask for the fold.
 */
function addRange(values: Set<number>, start: number, end: number, step: number, sundayAlias: boolean): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(step) || step <= 0 || start > end) return false
  for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value)
  return true
}

function parseField(source: string, min: number, max: number, sundayAlias = false): Field | null {
  const values = new Set<number>()
  const wildcard = source.split(',').some((part) => part.split('/')[0] === '*')
  for (const part of source.split(',')) {
    if (!part) return null
    const [rangeSource, stepSource] = part.split('/')
    if (part.split('/').length > 2) return null
    const step = stepSource === undefined ? 1 : Number(stepSource)
    let start: number
    let end: number
    if (rangeSource === '*') {
      start = min
      end = max
    } else if (rangeSource?.includes('-')) {
      const pieces = rangeSource.split('-')
      if (pieces.length !== 2) return null
      start = Number(pieces[0])
      end = Number(pieces[1])
    } else {
      start = Number(rangeSource)
      // `5/15` means every 15 units starting at 5, through the field's maximum.
      // Without a slash, a lone value still means exactly that value.
      end = stepSource === undefined ? start : max
    }
    if (start < min || end > max || !addRange(values, start, end, step, sundayAlias)) return null
  }
  return values.size > 0 ? { values, wildcard } : null
}

export function parseCron(source: string): ParsedCron | null {
  const parts = source.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const fields = parts.map((part, index) => {
    const [min, max] = LIMITS[index]!
    // Index 4 is the weekday field: the only one where 7 means Sunday.
    return parseField(part!, min, max, index === 4)
  })
  if (fields.some((field) => field === null)) return null
  return {
    minute: fields[0]!,
    hour: fields[1]!,
    day: fields[2]!,
    month: fields[3]!,
    weekday: fields[4]!
  }
}

export function isValidCron(source: string): boolean {
  return parseCron(source) !== null
}

export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.values.has(date.getMinutes())) return false
  if (!parsed.hour.values.has(date.getHours())) return false
  if (!parsed.month.values.has(date.getMonth() + 1)) return false
  const dayMatch = parsed.day.values.has(date.getDate())
  const weekdayMatch = parsed.weekday.values.has(date.getDay())
  // Traditional cron treats day-of-month and weekday as OR when both are
  // restricted, and as ordinary wildcard conjunction otherwise.
  const calendarMatch = !parsed.day.wildcard && !parsed.weekday.wildcard
    ? dayMatch || weekdayMatch
    : dayMatch && weekdayMatch
  return calendarMatch
}

const MINUTE_MS = 60_000
const MAX_CATCH_UP_MS = 366 * 24 * 60 * MINUTE_MS

/** Whether at least one scheduled minute has elapsed since the last attempt. */
export function cronIsDue(source: string, since: number, now: number): boolean {
  const parsed = parseCron(source)
  if (!parsed || !Number.isFinite(since) || !Number.isFinite(now) || since >= now) return false
  const first = Math.max(
    Math.floor(since / MINUTE_MS) * MINUTE_MS + MINUTE_MS,
    Math.floor((now - MAX_CATCH_UP_MS) / MINUTE_MS) * MINUTE_MS
  )
  const last = Math.floor(now / MINUTE_MS) * MINUTE_MS
  for (let at = first; at <= last; at += MINUTE_MS) {
    if (cronMatches(parsed, new Date(at))) return true
  }
  return false
}
