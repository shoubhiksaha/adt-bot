// Vendored from OpenBOT (github.com/ashhart/OpenBot), MIT License, Copyright (c) 2026 OpenBOT contributors. See ./LICENSE.
/**
 * The decision rules behind the approval gate: what a request is "about", whether a
 * policy can answer it without asking, and what rule to persist for "always allow".
 *
 * Kept separate from the prompting machinery so the rules stay readable and testable.
 */

import type { ApprovalPolicy, ApprovalRequest, Settings, ToolCall, ToolSchema } from './types'
import { hasShellMetacharacters, matchesAny, matchesAnyDeny, shellTokens } from './patterns'
import { asString, stringifySafe } from './json'
import { truncate } from './text'

export type ApprovalKind = ApprovalRequest['kind']

/** Argument names that usually carry the thing being acted on. */
const TARGET_KEYS = ['command', 'cmd', 'path', 'file', 'filePath', 'url', 'app', 'target', 'query']

export function kindForTool(name: string, schema?: ToolSchema): ApprovalKind {
  if (schema?.computerUse) return 'computer'
  switch (name) {
    case 'shell':
      return 'shell'
    case 'write_file':
      return 'write'
    case 'edit_file':
      return 'edit'
    case 'fetch':
    case 'web_search':
    case 'navigate':
      return 'fetch'
    case 'click':
    case 'type_text':
    case 'key_press':
    case 'scroll':
    case 'drag':
    case 'open_app':
    case 'screenshot':
      return 'computer'
    default:
      return name.startsWith('mcp') ? 'mcp' : 'write'
  }
}

/** The string allow/deny rules are matched against. */
export function targetForCall(call: ToolCall): string {
  const args = call.args ?? {}
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  // No obvious subject (e.g. a CLI-agent task: agent + task + folder). Use every argument, so
  // approving one call never approves a different task that happens to share its first string.
  const strings = Object.values(args).filter((v) => typeof v === 'string' && v.trim())
  if (strings.length <= 1) return typeof strings[0] === 'string' ? strings[0].trim() : ''
  return argsKey(call)
}

/** Every argument, in a stable order: what "already approved in this session" remembers. */
export function argsKey(call: ToolCall): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sort((value as Record<string, unknown>)[k])]))
        : value
  return JSON.stringify(sort(call.args ?? {}))
}

/** Values a rule may match: the target itself, and a tool-scoped key. */
export function matchableValues(toolName: string, target: string): string[] {
  return [target, `tool:${toolName}`].filter(Boolean)
}

/** How far into nested arguments the deny sweep walks, and how many values it keeps. */
const MAX_ARG_DEPTH = 3
const MAX_ARG_VALUES = 40

/**
 * Every string this call carries, not just the one `targetForCall` settled on.
 *
 * The model names its own arguments. A tool whose payload arrives as `script`,
 * `body` or `input` — most registry and MCP tools — matched no denylist rule at
 * all, and a call that also passed a harmless `command: "ls"` had that decoy
 * checked instead of the payload.
 */
export function argStrings(call: ToolCall): string[] {
  const out: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (out.length >= MAX_ARG_VALUES) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) out.push(trimmed)
      return
    }
    if (depth >= MAX_ARG_DEPTH || !value || typeof value !== 'object') return
    for (const nested of Object.values(value as Record<string, unknown>)) walk(nested, depth + 1)
  }
  walk(call.args ?? {}, 0)
  return out
}

/**
 * The denylist rule this whole call trips, or null.
 *
 * Deliberately wider than `evaluate`'s own check, which only sees the single
 * derived target: a deny rule is the user's hard "never", so it is matched
 * against every argument. Both executors run this before anything else, so it
 * also covers the tools that raise their own approval and the read-only tools
 * that raise none.
 */
export function deniedRuleForCall(settings: Settings, call: ToolCall): string | null {
  const derived = matchableValues(call.name, targetForCall(call))
  const values = [...new Set([...derived, ...argStrings(call)])]
  return matchesAnyDeny(settings.denylist ?? [], values)
}

/** What a refused call is told, wherever it was refused from. */
export function denyRefusal(toolName: string, rule: string): string {
  return (
    `Refused: "${toolName}" is blocked by the denylist rule "${rule}", which the user set. ` +
    `Do not retry it and do not work around it — tell them what you were trying to do instead.`
  )
}

/** Key for `ask-first-time` memory: same tool on the same target is asked once. */
export function rememberKey(toolName: string, target: string): string {
  return `${toolName}::${target}`
}

export interface PolicyVerdict {
  /** 'allow' and 'deny' are final; 'ask' means prompt the user. */
  outcome: 'allow' | 'deny' | 'ask'
  reason: string
}

/**
 * Resolve everything decidable without the user.
 *
 * The denylist is checked first and beats every policy, including `auto-run`.
 *
 * `force` is second, and beats everything below it for the same reason: the tool
 * raising the request has declared the action destructive or irreversible, and
 * `tools/approval.ts` documents those as always confirmed. Every computer-use action
 * is raised that way. Until this was consulted the flag was accepted and dropped —
 * under `auto-run` a high-risk shell command, a `fetch` POST and every screen action
 * ran with no prompt at all.
 */
export function evaluate(
  settings: Settings,
  toolName: string,
  target: string,
  remembered: ReadonlySet<string>,
  force = false,
  /** What "already approved" is keyed on; defaults to the target. Pass every argument (`argsKey`). */
  rememberAs = target
): PolicyVerdict {
  const values = matchableValues(toolName, target)

  const denied = matchesAnyDeny(settings.denylist ?? [], values)
  if (denied) {
    return { outcome: 'deny', reason: `blocked by denylist rule "${denied}"` }
  }

  if (force) {
    return { outcome: 'ask', reason: "this could delete or change something that can't easily be undone" }
  }

  const policy: ApprovalPolicy = settings.approvalPolicy ?? 'ask-every-time'

  if (policy === 'auto-run') {
    return { outcome: 'allow', reason: 'auto-run policy' }
  }

  /*
   * A rule like `git status *` must not wave through `git status && curl … | sh`: once the
   * target chains, pipes or substitutes commands, only a rule for that exact text (or one
   * that allows the whole tool) counts.
   */
  const chained = hasShellMetacharacters(target)
  const allowed = (settings.allowlist ?? []).find((rule) =>
    matchesAny([rule], [`tool:${toolName}`]) ? true : matchesAny([rule], [target]) && (!chained || rule.trim() === target)
  )
  if (allowed) {
    return { outcome: 'allow', reason: `allowlist rule "${allowed}"` }
  }

  /*
   * An empty target means the call carried no string to be about — every argument
   * was a number, a flag, a coordinate. Its key is a bare `tool::`, which is the
   * whole tool rather than one action: approving a single call of it once silently
   * allowed every later call of it, whatever the arguments. Ask each time instead.
   */
  if (policy === 'ask-first-time' && target && remembered.has(rememberKey(toolName, rememberAs))) {
    return { outcome: 'allow', reason: 'already approved in this session' }
  }

  return { outcome: 'ask', reason: policy }
}

/**
 * The rule persisted when the user picks "always allow", or null when the approval
 * must not be generalised at all — "always" then degrades to "allow once".
 *
 * Shell commands generalise to the leading verb (plus subcommand when there is one) so
 * the rule is useful; anything with pipes, redirects or substitutions stays literal,
 * because generalising those is not safe. Other kinds stay literal too.
 *
 * Screen control is never generalised. `click`, `scroll` and `drag` carry no string
 * argument to be literal about, so the rule collapsed to a bare `tool:click` — the user
 * approving one click at one position silently granted unlimited clicking anywhere on
 * screen, permanently, across every session. There is no honest pattern for "this click",
 * so there is no rule.
 */
const NO_GENERALISE =
  /^(python\d*(\.\d+)?|node|nodejs|deno|bun|ruby|perl|php|lua|osascript|swift|npx|bunx|pnpx|uvx|pipx|env|xargs|exec|eval|source|command|nohup|time|sudo|doas|\w*sh|curl|wget|nc|ncat|socat|scp|sftp|rsync|ssh|ftp|tftp|telnet|open|find|awk|gawk|sed|dd|tar|security|defaults|launchctl|crontab|chmod|chown|mv|cp|rm|ln|tee|install)$/i

export function derivePattern(
  kind: ApprovalKind,
  toolName: string,
  target: string
): string | null {
  if (kind === 'computer') return null
  if (!target) return `tool:${toolName}`
  if (kind !== 'shell') return target

  if (hasShellMetacharacters(target)) return target
  const tokens = shellTokens(target)
  if (tokens.length === 0) return target
  const verb = tokens[0]
  // ADT Bot: interpreters, network and shell tools can do anything with other arguments
  // (`python -c …`, `curl -T ~/.ssh/id_rsa …`, `bash -c …`): only this exact command is allowed.
  if (NO_GENERALISE.test(verb.replace(/^.*\//, ''))) return target
  const sub = tokens[1]
  if (sub && !sub.startsWith('-') && !sub.includes('/') && /^[a-z0-9:_-]+$/i.test(sub)) {
    return `${verb} ${sub} *`
  }
  return `${verb} *`
}

/** Human-readable one-liner for the approval card. */
export function summarise(toolName: string, call: ToolCall, target: string): string {
  if (target) return `${toolName}: ${truncate(target, 120)}`
  return `${toolName}(${truncate(Object.keys(call.args ?? {}).join(', '), 80)})`
}

export function detailFor(call: ToolCall): string {
  const entries = Object.entries(call.args ?? {})
  if (entries.length === 0) return '(no arguments)'
  return entries
    .map(([k, v]) => `${k}: ${asString(v) || stringifySafe(v, 2000)}`)
    .join('\n')
}
