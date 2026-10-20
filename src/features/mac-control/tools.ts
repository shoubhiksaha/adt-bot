import { type AgentTool, num, registerTool, registerToolGroup, str, type ToolContext } from "../../lib/agent/tools";
import { type MacApp, type MacFrontmost, type MacScreenshot, mac } from "./api";
import { isMacDesktop, useMacControl, whileControlling } from "./store";

/**
 * Computer use on the user's Mac. Off until the user switches on "Allow bots to control this Mac"
 * (Settings → Computer control) or gives Full access. Looking is read-only; acting asks per the
 * approval policy (not with Full access); AppleScript and quitting apps are destructive.
 */
registerToolGroup({
  id: "mac",
  label: "Control this Mac",
  description: "See the screen, move the pointer, click, type and open apps on this Mac.",
  platforms: ["desktop"],
});

/** On when "Allow bots to control this Mac" is, or with Full access; never in Sandbox mode. */
const available = (ctx: Pick<ToolContext, "settings">) => {
  const access = ctx.settings.agent.access ?? "restricted";
  return isMacDesktop() && access !== "sandbox" && (useMacControl.getState().enabled || access === "full");
};

const COORDS = "Coordinates are pixels in the latest mac_screenshot image (top-left is 0,0).";
const point = { x: { type: "number", description: "X in screenshot pixels" }, y: { type: "number", description: "Y in screenshot pixels" } } as const;

function macTool(tool: Omit<AgentTool, "group" | "kind" | "platforms" | "available">): AgentTool {
  return {
    ...tool,
    group: "mac",
    kind: "computer",
    platforms: ["desktop"],
    available,
    run: (args, ctx) => whileControlling(() => tool.run(args, ctx)),
  };
}

export const macTools: AgentTool[] = [
  macTool({
    name: "mac_screenshot",
    risk: "read",
    timeoutMs: 60_000,
    description:
      "Take a screenshot of this Mac's main display (or a region, or the frontmost window) and look at it. Do this before clicking and after acting to check the result. ADT Bot itself may be in front: bring the target app forward with mac_open_app first.",
    parameters: {
      type: "object",
      properties: {
        window: { type: "boolean", description: "Only the frontmost window" },
        x: { type: "number", description: "Region left, in the previous screenshot's pixels (optional)" },
        y: { type: "number", description: "Region top" },
        width: { type: "number", description: "Region width" },
        height: { type: "number", description: "Region height" },
      },
    },
    async run(args) {
      const region = args.width && args.height ? { x: num(args, "x", 0), y: num(args, "y", 0), width: num(args, "width", 0), height: num(args, "height", 0) } : undefined;
      const shot = await mac<MacScreenshot>("screenshot", { window: args.window === true, region });
      const src = `data:${shot.mediaType};base64,${shot.data}`;
      return {
        content: [
          `Screenshot ${shot.width}×${shot.height} px of ${region ? "a region" : args.window ? "the front window" : "the screen"} (screen is ${shot.screen.width}×${shot.screen.height} points).`,
          "Use pixel coordinates in this image for mac_click, mac_drag and mac_scroll.",
          shot.note ?? "",
        ]
          .filter(Boolean)
          .join(" "),
        display: { kind: "image", src, caption: `Screenshot ${shot.width}×${shot.height}` },
        image: { mediaType: shot.mediaType, data: shot.data },
        untrustedSource: "the screen of this Mac",
      };
    },
  }),
  macTool({
    name: "mac_click",
    risk: "write",
    description: `Click at a point on this Mac's screen. ${COORDS}`,
    parameters: {
      type: "object",
      properties: {
        ...point,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left" },
        clicks: { type: "number", description: "2 for a double-click" },
      },
      required: ["x", "y"],
    },
    async run(args) {
      const button = str(args, "button", "left");
      const clicks = num(args, "clicks", 1);
      await mac("click", { x: num(args, "x", NaN), y: num(args, "y", NaN), button, clicks });
      return `${clicks >= 2 ? "Double-clicked" : button === "right" ? "Right-clicked" : "Clicked"} at (${args.x}, ${args.y}). Take a screenshot to see the result.`;
    },
  }),
  macTool({
    name: "mac_type",
    risk: "write",
    timeoutMs: 180_000,
    description: "Type text into the focused field of the frontmost app on this Mac (newlines press Return). Click the field first.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async run(args) {
      const { typed } = await mac<{ typed: number }>("type", { text: str(args, "text") });
      return `Typed ${typed} characters.`;
    },
  }),
  macTool({
    name: "mac_key",
    risk: "write",
    description: 'Press a key or shortcut on this Mac, e.g. "enter", "esc", "tab", "down", "cmd+c", "cmd+shift+t", "ctrl+alt+left".',
    parameters: { type: "object", properties: { combo: { type: "string" } }, required: ["combo"] },
    async run(args) {
      const { label } = await mac<{ label: string }>("key", { combo: str(args, "combo") });
      return `Pressed ${label}.`;
    },
  }),
  macTool({
    name: "mac_scroll",
    risk: "write",
    description: `Scroll at a point on this Mac's screen. dy > 0 scrolls down, dx > 0 scrolls right (in pixels, e.g. 400). ${COORDS}`,
    parameters: {
      type: "object",
      properties: { ...point, dx: { type: "number" }, dy: { type: "number" } },
      required: ["x", "y"],
    },
    async run(args) {
      await mac("scroll", { x: num(args, "x", NaN), y: num(args, "y", NaN), dx: num(args, "dx", 0), dy: num(args, "dy", 0) });
      return `Scrolled (${num(args, "dx", 0)}, ${num(args, "dy", 0)}) at (${args.x}, ${args.y}).`;
    },
  }),
  macTool({
    name: "mac_drag",
    risk: "write",
    description: `Drag with the left button from one point to another on this Mac's screen. ${COORDS}`,
    parameters: {
      type: "object",
      properties: { ...point, to_x: { type: "number" }, to_y: { type: "number" } },
      required: ["x", "y", "to_x", "to_y"],
    },
    async run(args) {
      await mac("drag", { x: num(args, "x", NaN), y: num(args, "y", NaN), toX: num(args, "to_x", NaN), toY: num(args, "to_y", NaN) });
      return `Dragged from (${args.x}, ${args.y}) to (${args.to_x}, ${args.to_y}).`;
    },
  }),
  macTool({
    name: "mac_list_apps",
    risk: "read",
    description: "List the apps running on this Mac and which app and window are in front.",
    parameters: { type: "object", properties: {} },
    async run() {
      const [apps, front] = await Promise.all([mac<MacApp[]>("apps"), mac<MacFrontmost>("frontmost").catch(() => null)]);
      const lines = apps.map((a) => `- ${a.name}${a.active ? " (in front)" : ""}${a.hidden ? " (hidden)" : ""}`);
      const head = front ? `Frontmost: ${front.name}${front.window ? ` — window "${front.window}"` : ""}` : "";
      return [head, `Running apps:\n${lines.join("\n")}`].filter(Boolean).join("\n\n");
    },
  }),
  macTool({
    name: "mac_open_app",
    risk: "write",
    riskFor: (args) => (args.action === "quit" ? "destructive" : "write"),
    description: 'Open or bring forward an app on this Mac by name (e.g. "Safari", "Notes"), open a web link, or quit an app (action "quit").',
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name as in the Applications folder" },
        url: { type: "string", description: "http(s) link to open in the default browser (instead of an app)" },
        action: { type: "string", enum: ["open", "quit"], description: "Default open" },
      },
    },
    async run(args) {
      const url = str(args, "url");
      const app = str(args, "app");
      if (args.action === "quit") {
        const { quit } = await mac<{ quit: string[] }>("quit", { name: app });
        return `Asked ${quit.join(", ")} to quit.`;
      }
      if (url) {
        await mac("openUrl", { url });
        return `Opened ${url}.`;
      }
      if (!app) throw new Error("Give an app name or a url.");
      await mac("open", { name: app });
      return `Opened ${app}. Take a screenshot to see it.`;
    },
  }),
  macTool({
    name: "mac_applescript",
    risk: "destructive",
    timeoutMs: 90_000,
    description: "Run an AppleScript (or JavaScript for Automation) on this Mac and return its output. Always asks the user first. Prefer the other mac_ tools when they can do the job.",
    parameters: {
      type: "object",
      properties: { script: { type: "string" }, language: { type: "string", enum: ["applescript", "javascript"] } },
      required: ["script"],
    },
    async run(args) {
      const { output } = await mac<{ output: string }>("applescript", { source: str(args, "script"), language: str(args, "language", "applescript") });
      return { content: output || "(no output)", untrustedSource: "AppleScript output" };
    },
  }),
];

for (const tool of macTools) registerTool(tool);
