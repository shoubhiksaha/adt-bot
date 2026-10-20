import { type AgentTool, num, registerTool, registerToolGroup, str, type ToolContext } from "../../lib/agent/tools";
import { type MacApp, type MacFrontmost, type MacScreenshot, mac } from "./api";
import { isMacDesktop, useMacControl, whileControlling } from "./store";
import { formatUi, normalize, pickElement, RISKY_LABEL, type UiElement, type UiSnapshot } from "./ui";

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

const COORDS = "Coordinates are pixels in the latest mac_screenshot image (top-left is 0,0), or an element's @(x,y) from mac_ui.";

/** The latest mac_ui elements, so presses by id know what they press (for approvals and the result). */
const known = new Map<number, { label: string; role: string; app: string }>();
let lastApp = "";

function remember(snap: UiSnapshot) {
  lastApp = snap.name;
  if (known.size > 4000) known.clear();
  for (const e of snap.elements) known.set(e.id, { label: e.label ?? "", role: e.role, app: snap.name });
}

async function readUi(args: { app?: string; window?: string; query?: string; menus?: boolean; max?: number }): Promise<UiSnapshot> {
  const snap = await mac<UiSnapshot>("ui", args);
  remember(snap);
  return snap;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The window after an action, so the model sees the result without another step. */
async function after(app: string | undefined, note: string): Promise<string> {
  await pause(450);
  try {
    return `${note}\n\nNow:\n${formatUi(await readUi({ app: app || undefined, max: 80 }), 80)}`;
  } catch {
    return note;
  }
}

/** Finds the element an id or a name refers to, reading the window when needed. */
async function target(args: Record<string, unknown>, roleHint?: string): Promise<{ element: UiElement | { id: number; label: string; role: string }; app?: string; extra: string }> {
  const id = num(args, "id", NaN);
  const app = str(args, "app") || undefined;
  if (Number.isFinite(id)) {
    const k = known.get(id);
    return { element: { id, label: k?.label ?? "", role: k?.role ?? "element" }, app: app ?? k?.app, extra: "" };
  }
  const text = str(args, "text") || str(args, "field");
  if (!text) throw new Error("Give the element's id from mac_ui, or its text.");
  const snap = await readUi({ app, query: undefined, max: 600 });
  const pick = pickElement(snap.elements, text, str(args, "role") || roleHint);
  if ("error" in pick) throw new Error(`${pick.error}\n\n${formatUi(snap, 60)}`);
  const extra = pick.others.length ? ` (also matched ${pick.others.map((o) => `[${o.id}]`).join(", ")})` : "";
  return { element: pick.element, app: snap.name, extra };
}

const describe = (e: { id: number; label?: string; role: string }) => `${e.role}${e.label ? ` "${e.label}"` : ""} [${e.id}]`;

/** Deleting, paying, signing out…: those always ask, even with Full access. */
function pressRisk(args: Record<string, unknown>): AgentTool["risk"] {
  const id = num(args, "id", NaN);
  const label = Number.isFinite(id) ? (known.get(id)?.label ?? "") : str(args, "text");
  return RISKY_LABEL.test(label) ? "destructive" : "write";
}

const TERMINALS = /^(terminal|iterm2?|warp|ghostty|alacritty|kitty|wezterm|hyper|tabby)$/i;
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
      "Take a screenshot of this Mac's main display (or a region, or the frontmost window) and look at it. Prefer mac_ui for apps (faster and exact); use screenshots for what it can't describe: images, canvases, games, or to check how something looks. ADT Bot itself may be in front: bring the target app forward with mac_open_app first.",
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
    name: "mac_ui",
    risk: "read",
    timeoutMs: 30_000,
    description:
      "List the controls in an app's window from macOS accessibility: buttons, text fields, links, list rows (e.g. chats), menus and visible text, each with an [id]. " +
      "Use this FIRST to work with any app: it's fast and exact. Then act with mac_press (by id or text) and mac_set_text. " +
      "Defaults to the app in front (ignoring ADT Bot). Use query to find something in a long window, menus:true to search the menu bar (File, Edit…).",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: 'App name, e.g. "WhatsApp", "Safari", "Notes" (default: the app in front)' },
        query: { type: "string", description: "Only elements whose text contains these words" },
        window: { type: "string", description: "Part of a window title, when the app has several" },
        menus: { type: "boolean", description: "Include the app's menu bar items" },
        max: { type: "number", description: "Most elements to list (default 200)" },
      },
    },
    async run(args) {
      const snap = await readUi({
        app: str(args, "app") || undefined,
        query: str(args, "query") || undefined,
        window: str(args, "window") || undefined,
        menus: args.menus === true,
        max: num(args, "max", 200),
      });
      return { content: formatUi(snap, num(args, "max", 200)), untrustedSource: `the ${snap.name} app on this Mac` };
    },
  }),
  macTool({
    name: "mac_press",
    risk: "write",
    riskFor: pressRisk,
    timeoutMs: 40_000,
    description:
      "Press a button, link, tab, menu item or list row in an app, by its [id] from mac_ui or by its text (e.g. text \"Send\", text \"Mom\"). " +
      "Works even when the app is behind other windows. Returns the window's controls afterwards, so you rarely need to look again. " +
      "action: double_click, right_click, or focus instead of a press.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Element id from the latest mac_ui list" },
        text: { type: "string", description: "Or: the element's text/label" },
        role: { type: "string", description: 'With text: limit to a role, e.g. "button", "row", "link", "tab"' },
        app: { type: "string", description: "With text: the app (default: the app in front)" },
        action: { type: "string", enum: ["press", "double_click", "right_click", "focus"], description: "Default press" },
      },
    },
    async run(args) {
      const { element, app, extra } = await target(args);
      const action = str(args, "action", "press");
      const done = await mac<{ method: string }>("press", { element: element.id, action });
      const how = done.method === "click" ? "Clicked" : done.method === "select" ? "Selected" : done.method === "focus" ? "Focused" : "Pressed";
      return { content: await after(app ?? lastApp, `${how} ${describe(element)}${extra}.`), untrustedSource: "the screen of this Mac" };
    },
  }),
  macTool({
    name: "mac_set_text",
    risk: "write",
    riskFor: (args) => (TERMINALS.test(str(args, "app")) ? "destructive" : "write"),
    timeoutMs: 120_000,
    description:
      "Type into a text field, search box or message box in an app, by its [id] from mac_ui or by its label/placeholder (field). Replaces what's there unless append is true. " +
      "submit:true presses Return afterwards (sends a chat message, runs a search). Returns the window's controls afterwards.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Field id from the latest mac_ui list" },
        field: { type: "string", description: 'Or: the field\'s label or placeholder, e.g. "Search", "Type a message"' },
        app: { type: "string", description: "With field: the app (default: the app in front)" },
        text: { type: "string", description: "The text to type" },
        submit: { type: "boolean", description: "Press Return after typing" },
        append: { type: "boolean", description: "Add to the end instead of replacing" },
      },
      required: ["text"],
    },
    async run(args) {
      const { element, app, extra } = await target(args, undefined);
      const text = str(args, "text");
      const done = await mac<{ typed: number; value?: string }>("setText", { element: element.id, text, replace: args.append !== true, submit: args.submit === true });
      const check = done.value !== undefined && text && !normalize(done.value).includes(normalize(text).slice(0, 40)) ? ` The field now shows "${done.value}" — check it.` : "";
      return {
        content: await after(app ?? lastApp, `Typed ${done.typed} characters into ${describe(element)}${extra}${args.submit === true ? " and pressed Return" : ""}.${check}`),
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
      return `${clicks >= 2 ? "Double-clicked" : button === "right" ? "Right-clicked" : "Clicked"} at (${args.x}, ${args.y}). Check the result with mac_ui or mac_screenshot.`;
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
    description:
      'Open or bring forward an app on this Mac by name (e.g. "Safari", "Notes") and list its controls, open a link, or quit an app (action "quit"). ' +
      "Links can be web pages or app links, which are often the fastest way: whatsapp://send?phone=<country code + number, digits only>&text=<url-encoded message> opens that WhatsApp chat with the message typed (then press Send), " +
      "mailto:, sms:, tel:, facetime:, spotify:, maps:, slack:, zoommtg:.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "App name as in the Applications folder" },
        url: { type: "string", description: "A web or app link to open (instead of an app name)" },
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
        return /^https?:/i.test(url) ? `Opened ${url}.` : await after(undefined, `Opened ${url}.`);
      }
      if (!app) throw new Error("Give an app name or a url.");
      await mac("open", { name: app });
      // Wait for its window, then show its controls.
      for (let i = 0; i < 8; i++) {
        await pause(i ? 400 : 600);
        const snap = await readUi({ app, max: 120 }).catch(() => null);
        if (snap?.elements.length) return { content: `Opened ${app}.\n\n${formatUi(snap, 120)}`, untrustedSource: `the ${app} app on this Mac` };
      }
      return `Opened ${app}. Use mac_ui or mac_screenshot to see it.`;
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
