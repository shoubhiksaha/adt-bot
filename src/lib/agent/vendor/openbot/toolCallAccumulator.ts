// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/**
 * Reassembly of streamed `tool_calls` deltas.
 *
 * Fragments arrive keyed by `index`: the id and name land in the first one,
 * then `function.arguments` dribbles in as JSON string pieces that are only
 * valid once concatenated. Accumulate per index; parse exactly once at the end.
 */

import { isPlainObject, repairJson, safeJsonParse } from './lenientJson'
import { newCallId } from './messageContent'
import type { ToolCall } from './types'

export interface OaFunctionDelta {
  name?: string
  arguments?: unknown
}

export interface OaToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: OaFunctionDelta
}

interface ToolSlot {
  id?: string
  name: string
  args: string
}

export class ToolCallAccumulator {
  private readonly slots = new Map<number, ToolSlot>()
  private nextIndex = 0

  get size(): number {
    return this.slots.size
  }

  push(deltas: OaToolCallDelta[] | undefined): void {
    if (!Array.isArray(deltas)) return
    for (const delta of deltas) {
      const index = typeof delta.index === 'number' ? delta.index : this.nextIndex
      this.nextIndex = Math.max(this.nextIndex, index + 1)
      const slot = this.slots.get(index) ?? { name: '', args: '' }
      if (typeof delta.id === 'string' && delta.id) slot.id = delta.id
      mergeFunction(slot, delta.function)
      this.slots.set(index, slot)
    }
  }

  finish(): ToolCall[] {
    return [...this.slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, slot]) =>
        slot.name
          ? [{ id: slot.id ?? newCallId(), name: slot.name, args: parseToolArgs(slot.args) }]
          : []
      )
  }
}

function mergeFunction(slot: ToolSlot, fn: OaFunctionDelta | undefined): void {
  if (!fn) return
  if (typeof fn.name === 'string' && fn.name) {
    // Names normally arrive whole; a few servers fragment them.
    if (!slot.name) slot.name = fn.name
    else if (fn.name !== slot.name && !slot.name.endsWith(fn.name)) slot.name += fn.name
  }
  if (typeof fn.arguments === 'string') slot.args += fn.arguments
  else if (isPlainObject(fn.arguments)) slot.args = JSON.stringify(fn.arguments)
}

/** Parse accumulated argument text as leniently as is safe. */
export function parseToolArgs(text: string): Record<string, unknown> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return {}

  const direct = safeJsonParse<unknown>(trimmed)
  const unwrapped = typeof direct === 'string' ? safeJsonParse<unknown>(direct) : direct
  if (isPlainObject(unwrapped)) return unwrapped

  const repaired = safeJsonParse<unknown>(repairJson(trimmed))
  return isPlainObject(repaired) ? repaired : {}
}
