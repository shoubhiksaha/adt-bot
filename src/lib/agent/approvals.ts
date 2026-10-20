import { updateSettings, useStore } from "../store";
import { accessVerdict, isComputerTool } from "./access";
import type { AgentTool, ToolContext } from "./tools";
import {
  argsKey,
  deniedRuleForCall,
  denyRefusal,
  derivePattern,
  detailFor,
  evaluate,
  kindForTool,
  rememberKey,
  summarise,
  targetForCall,
} from "./vendor/openbot/approvalPolicy";
import type { ToolCall } from "./vendor/openbot/types";

export type Decision = "once" | "always" | "deny";

/**
 * Approvals granted with "allow once" under the ask-first-time policy, for this app session. Chat
 * rooms keep their own (keyed by room), so nothing approved in a private chat runs for guests.
 */
const rememberedByScope = new Map<string, Set<string>>();
const rememberedFor = (scope: string) => {
  let set = rememberedByScope.get(scope);
  if (!set) rememberedByScope.set(scope, (set = new Set()));
  return set;
};
/** Which scope each pending approval card belongs to. */
const askedScope = new Map<string, string>();
const pending = new Map<string, (decision: Decision) => void>();
const listeners = new Set<() => void>();

export type GateResult =
  | { outcome: "allow"; reason: string }
  | { outcome: "deny"; reason: string; refusal: string }
  | { outcome: "ask"; reason: string; summary: string; detail: string; kind: string; allowAlways: boolean };

/**
 * Tools that change things beyond the screen: commands, files, scripts, coding agents, routines. After a turn
 * has read outside content, these ask even with Full access (screen actions still run, so Full
 * access stays usable for "send this message"-type tasks).
 */
export function taintSensitive(tool: AgentTool, risk: AgentTool["risk"]): boolean {
  if (risk === "read") return false;
  // Routines run again later with the same tools: an injected instruction must not schedule itself.
  if (tool.group === "routines") return true;
  if (!isComputerTool(tool)) return false;
  // Screen control (built in, or a Mac-control connector) stays usable: that's what Full access is for.
  if (tool.controlsComputer) return false;
  return tool.group !== "mac" || tool.name === "mac_applescript";
}

/**
 * Decides what can run without asking. The deny list wins; then Computer access (Sandbox refuses
 * anything outside the workspace, Full access runs computer tools unasked); then read-only tools
 * never ask, destructive ones always do, and the approval policy decides the rest. Last, a turn that
 * has read outside content asks before commands and file changes, whatever allowed them.
 * `forceAsk` names a reason the caller found to ask anyway (e.g. typing into a terminal).
 */
export function gate(
  tool: AgentTool,
  call: ToolCall,
  context?: Pick<ToolContext, "shared" | "taint"> & { conversationId?: string },
  forceAsk?: string,
): GateResult {
  const { agent } = useStore.getState().settings;
  // Rooms: the allow list (rules for your own chats) doesn't apply, and approvals stay in that room.
  const scope = context?.shared ? `room:${context.conversationId ?? ""}` : "";
  const remembered = rememberedFor(scope);
  const policySettings = { approvalPolicy: agent.approvalPolicy, allowlist: context?.shared ? [] : agent.allowlist, denylist: agent.denylist };
  const denied = deniedRuleForCall(policySettings, call);
  if (denied) return { outcome: "deny", reason: `blocked by your deny rule "${denied}"`, refusal: denyRefusal(call.name, denied) };
  const risk = tool.riskFor?.(call.args) ?? tool.risk;
  const target = targetForCall(call);
  const kind = tool.kind ?? kindForTool(call.name);
  const ask = (reason: string, allowAlways: boolean): GateResult => {
    askedScope.set(call.id, scope);
    return { outcome: "ask", reason, summary: summarise(call.name, call, target), detail: detailFor(call), kind, allowAlways: allowAlways && !scope };
  };
  const tainted = context?.taint?.sources.size ? [...context.taint.sources][0] : "";
  const checkTaint = (allowed: GateResult): GateResult => {
    if (allowed.outcome !== "allow") return allowed;
    if (forceAsk) return ask(forceAsk, false);
    if (tainted && taintSensitive(tool, risk)) return ask(`this conversation just read outside content (${tainted}), so changes to your computer ask first`, false);
    return allowed;
  };
  const access = accessVerdict(tool, call.args ?? {}, risk, agent, context);
  if (access.outcome === "deny") return access;
  if (access.outcome === "allow") return checkTaint(access);
  if (risk === "read") return checkTaint({ outcome: "allow", reason: "read-only" });
  const verdict = evaluate(policySettings, call.name, target, remembered, risk === "destructive", argsKey(call));
  if (verdict.outcome === "allow") return checkTaint({ outcome: "allow", reason: verdict.reason });
  if (verdict.outcome === "deny") return { outcome: "deny", reason: verdict.reason, refusal: denyRefusal(call.name, verdict.reason) };
  return ask(verdict.reason, risk !== "destructive" && derivePattern(kind, call.name, target) !== null);
}

/** Waits for the user's decision on an approval card (resolved from the chat UI). */
export function waitForDecision(callId: string, signal: AbortSignal): Promise<Decision> {
  return new Promise((resolve) => {
    const done = (decision: Decision) => {
      pending.delete(callId);
      listeners.forEach((l) => l());
      resolve(decision);
    };
    pending.set(callId, done);
    listeners.forEach((l) => l());
    signal.addEventListener("abort", () => done("deny"), { once: true });
  });
}

export function isPending(callId: string): boolean {
  return pending.has(callId);
}

export function onApprovalsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the approval card. "always" adds an allow rule (shell commands generalise to their verb). */
export function decide(tool: AgentTool | undefined, call: ToolCall, decision: Decision) {
  const scope = askedScope.get(call.id) ?? "";
  askedScope.delete(call.id);
  if (decision !== "deny") {
    const target = targetForCall(call);
    // Remember this exact call (every argument), not just its target: a different folder, file
    // content or task is asked about again.
    rememberedFor(scope).add(rememberKey(call.name, argsKey(call)));
    if (decision === "always" && tool && !scope) {
      const pattern = derivePattern(tool.kind ?? kindForTool(call.name), call.name, target);
      const { agent } = useStore.getState().settings;
      if (pattern && !agent.allowlist.includes(pattern)) updateSettings({ agent: { ...agent, allowlist: [...agent.allowlist, pattern] } });
    }
  }
  pending.get(call.id)?.(decision);
}
