// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/** Prompt-and-parse fallback for model clients without native tool schemas. */


import type { ToolCall, ToolSchema } from './types'
import { textOf } from './messageContent'
import type { ChatChunk, ProviderMessage } from './types'

const OPEN = '<openbot_tool_call>'
const CLOSE = '</openbot_tool_call>'

function protocol(tools: ToolSchema[]): string {
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }))
  return [
    '# OpenBOT tool-call protocol',
    'OpenBOT, not this model client, executes tools and applies approvals.',
    'When a tool is needed, answer with one call and no prose in exactly this form:',
    `${OPEN}{"name":"tool_name","arguments":{}}${CLOSE}`,
    'Use only a listed tool and valid JSON arguments. After execution, its result will appear in the conversation.',
    `Tools: ${JSON.stringify(catalog)}`
  ].join('\n')
}

/** Add the fallback protocol to the existing system turn without mutating it. */
export function withPromptedTools(messages: ProviderMessage[], tools: ToolSchema[]): ProviderMessage[] {
  if (tools.length === 0) return messages
  const instructions = protocol(tools)
  const at = messages.findIndex((message) => message.role === 'system')
  if (at < 0) return [{ role: 'system', content: instructions }, ...messages]
  return messages.map((message, index) =>
    index === at
      ? { ...message, content: `${textOf(message.content).trim()}\n\n${instructions}` }
      : message
  )
}

export interface PromptedToolOutput {
  text: string
  call?: ToolCall
}

/** Extract at most one explicitly delimited call; unknown/malformed calls remain text. */
export function parsePromptedToolOutput(text: string, tools: ToolSchema[]): PromptedToolOutput {
  const start = text.indexOf(OPEN)
  const end = start < 0 ? -1 : text.indexOf(CLOSE, start + OPEN.length)
  if (start < 0 || end < 0) return { text }

  const raw = text.slice(start + OPEN.length, end).trim()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { text }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text }
  const record = value as Record<string, unknown>
  const name = typeof record['name'] === 'string' ? record['name'] : ''
  const schema = tools.find((tool) => tool.name === name)
  if (!schema) return { text }

  const nested = record['arguments'] ?? record['args']
  const candidate = nested !== undefined
    ? nested
    : Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'name' && key !== 'tool')
      )
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { text }

  // Small/local models often flatten a requested `arguments` object into the
  // envelope itself. Accept that shape, but only pass fields the enabled
  // tool's schema actually advertises; explanatory keys must never leak into
  // execution just because a model invented them.
  const allowed = schema.parameters.properties
  const args = Object.fromEntries(
    Object.entries(candidate as Record<string, unknown>).filter(([key]) =>
      Object.prototype.hasOwnProperty.call(allowed, key)
    )
  )

  const before = text.slice(0, start).trim()
  const after = text.slice(end + CLOSE.length).trim()
  return {
    text: [before, after].filter(Boolean).join('\n'),
    call: { id: `prompted-${crypto.randomUUID()}`, name, args }
  }
}

/** Buffer text so protocol markup never flashes in the transcript before parsing. */
export async function* promptedToolStream(
  stream: AsyncIterable<ChatChunk>,
  tools: ToolSchema[],
  emptyFallback?: string
): AsyncGenerator<ChatChunk> {
  let text = ''
  let failure: unknown
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text') text += chunk.delta ?? ''
      else if (chunk.type !== 'done') yield chunk
    }
  } catch (error) {
    failure = error
  }

  const parsed = parsePromptedToolOutput(text, tools)
  if (parsed.text) yield { type: 'text', delta: parsed.text }
  if (parsed.call) yield { type: 'tool_call', call: parsed.call }
  if (failure !== undefined) throw failure
  if (!parsed.text && !parsed.call && emptyFallback) {
    yield { type: 'text', delta: emptyFallback }
  }
  yield { type: 'done' }
}
