import { desktopInvoke, isDesktop } from "../desktop";
import { useStore } from "../store";
import type { AgentSettings } from "../types";
import type { AgentTool, ToolContext } from "./tools";

/** Settings → Tools & safety → Computer access. */
export type ComputerAccess = AgentSettings["access"];

export const ACCESS_MODES: Record<ComputerAccess, { label: string; hint: string }> = {
  sandbox: {
    label: "Sandbox",
    hint: "Bots work only inside the ADT Bot Workspace folder. Commands run in an OS sandbox that can't see your other files or start apps. Screen control and coding agents are off.",
  },
  restricted: {
    label: "Restrictive",
    hint: "Bots can reach your whole computer, but ask before anything that changes something (using the approval policy below). Destructive actions always ask.",
  },
  full: {
    label: "Full access",
    hint: "Bots control the whole computer without asking: commands, any file, apps, the screen, mouse and keyboard. Your deny list still applies, and destructive actions still ask unless you turn that off.",
  },
};

/** Tool groups that act on this computer: commands and files, the screen, and coding-agent CLIs. */
const COMPUTER_GROUPS = new Set(["local", "mac", "cli-agents"]);

export function isComputerTool(tool: Pick<AgentTool, "group" | "controlsComputer">): boolean {
  return COMPUTER_GROUPS.has(tool.group) || tool.controlsComputer === true;
}

/** The access that applies to a request: shared rooms never get more than Restrictive. */
export function effectiveAccess(agent: Pick<AgentSettings, "access">, context?: Pick<ToolContext, "shared">): ComputerAccess {
  const access = agent.access ?? "restricted";
  return context?.shared && access === "full" ? "restricted" : access;
}

export type AccessVerdict = { outcome: "allow"; reason: string } | { outcome: "deny"; reason: string; refusal: string } | { outcome: "policy" };

/**
 * What Computer access decides for one call of a computer tool, before the approval policy:
 * allow it outright, refuse it, or leave it to the policy. The deny list is checked before this.
 */
export function accessVerdict(
  tool: AgentTool,
  args: Record<string, unknown>,
  risk: AgentTool["risk"],
  agent: Pick<AgentSettings, "access" | "confirmDestructive">,
  context?: Pick<ToolContext, "shared">,
): AccessVerdict {
  if (!isComputerTool(tool)) return { outcome: "policy" };
  const access = effectiveAccess(agent, context);
  if (access === "sandbox") {
    const refuse = (what: string) => ({
      outcome: "deny" as const,
      reason: `Sandbox mode: ${what}`,
      refusal:
        `Refused: Computer access is set to Sandbox, so ${what}. Don't retry it. Work inside the ADT Bot Workspace folder ` +
        `(use relative paths), or tell the user they can change Computer access in Settings → Tools & safety.`,
    });
    if (tool.group === "mac") return refuse("screen control is off");
    if (tool.controlsComputer) return refuse("connectors that control this computer are off");
    if (tool.group === "cli-agents") return refuse("coding agents can't be used (they run outside the sandbox)");
    const contained = tool.sandboxed?.(args);
    if (contained === false) return refuse("bots can only use the ADT Bot Workspace folder");
    // Contained, but deleting or overwriting the user's work in the folder still asks.
    if (contained && risk !== "destructive") return { outcome: "allow", reason: "inside the sandbox" };
    return { outcome: "policy" };
  }
  if (access === "full") {
    if (risk === "destructive" && agent.confirmDestructive) return { outcome: "policy" };
    return { outcome: "allow", reason: "full access" };
  }
  return { outcome: "policy" };
}

/** Whether a tool can ever run in voice mode, where nobody can answer an approval card. */
export function runsWithoutAsking(tool: AgentTool, agent: Pick<AgentSettings, "access" | "confirmDestructive">): boolean {
  // Calls that turn out riskier (riskFor) are refused at run time in voice mode, so offer these.
  if (tool.risk === "read") return true;
  if (!isComputerTool(tool)) return false;
  if (agent.access === "full") return true;
  return agent.access === "sandbox" && tool.group === "local" && Boolean(tool.sandboxed);
}

/** What the model is told about its reach, so it plans within it. */
export function accessGuidance(agent: Pick<AgentSettings, "access" | "confirmDestructive">, context?: Pick<ToolContext, "shared">): string {
  switch (effectiveAccess(agent, context)) {
    case "sandbox":
      return "Computer access: Sandbox. You can only work inside the ADT Bot Workspace folder (use relative paths); commands run isolated there, with no access to the user's other files, and you can't see or control the screen.";
    case "full":
      return `Computer access: Full. You can run commands, read and change any file, open and quit apps, and see and control the screen without asking${agent.confirmDestructive ? " (destructive actions still ask the user)" : ""}. Act carefully: check the screen after acting, and never delete or overwrite anything the user didn't ask you to.`;
    default:
      return "Computer access: Restrictive. You can reach the whole computer, but the user approves actions that change things.";
  }
}

// The desktop side enforces the mode too (paths, the command and file sandbox, screen control,
// coding agents), so a bug in the approval rules can't widen it. Connectors (MCP servers) the user
// added run as configured and follow the approval policy. Keep it in step with the setting.
if (typeof window !== "undefined" && isDesktop()) {
  let sent: ComputerAccess | null = null;
  const sync = () => {
    const { hydrated, settings } = useStore.getState();
    const access = settings.agent.access ?? "restricted";
    if (!hydrated || access === sent) return;
    sent = access;
    void desktopInvoke("adt:system:access", { access }).catch(() => (sent = null));
  };
  useStore.subscribe(sync);
  sync();
}
