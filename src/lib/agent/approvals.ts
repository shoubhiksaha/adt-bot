import { updateSettings, useStore } from "../store";
import type { AgentTool } from "./tools";
import {
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

/** Approvals granted with "allow once" under the ask-first-time policy, for this app session. */
const remembered = new Set<string>();
const pending = new Map<string, (decision: Decision) => void>();
const listeners = new Set<() => void>();

export type GateResult =
  | { outcome: "allow"; reason: string }
  | { outcome: "deny"; reason: string; refusal: string }
  | { outcome: "ask"; reason: string; summary: string; detail: string; kind: string; allowAlways: boolean };

/** Decides what can run without asking. Read-only tools never ask; destructive ones always do. */
export function gate(tool: AgentTool, call: ToolCall): GateResult {
  const { agent } = useStore.getState().settings;
  const policySettings = { approvalPolicy: agent.approvalPolicy, allowlist: agent.allowlist, denylist: agent.denylist };
  const denied = deniedRuleForCall(policySettings, call);
  if (denied) return { outcome: "deny", reason: `blocked by your deny rule "${denied}"`, refusal: denyRefusal(call.name, denied) };
  const risk = tool.riskFor?.(call.args) ?? tool.risk;
  if (risk === "read") return { outcome: "allow", reason: "read-only" };
  const target = targetForCall(call);
  const verdict = evaluate(policySettings, call.name, target, remembered, risk === "destructive");
  if (verdict.outcome === "allow") return { outcome: "allow", reason: verdict.reason };
  if (verdict.outcome === "deny") return { outcome: "deny", reason: verdict.reason, refusal: denyRefusal(call.name, verdict.reason) };
  const kind = tool.kind ?? kindForTool(call.name);
  return {
    outcome: "ask",
    reason: verdict.reason,
    summary: summarise(call.name, call, target),
    detail: detailFor(call),
    kind,
    allowAlways: risk !== "destructive" && derivePattern(kind, call.name, target) !== null,
  };
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
  if (decision !== "deny") {
    const target = targetForCall(call);
    remembered.add(rememberKey(call.name, target));
    if (decision === "always" && tool) {
      const pattern = derivePattern(tool.kind ?? kindForTool(call.name), call.name, target);
      const { agent } = useStore.getState().settings;
      if (pattern && !agent.allowlist.includes(pattern)) updateSettings({ agent: { ...agent, allowlist: [...agent.allowlist, pattern] } });
    }
  }
  pending.get(call.id)?.(decision);
}
