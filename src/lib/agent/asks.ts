/**
 * How an action a bot wants to take is put to the user: on approval cards ("Allow the bot to run a
 * command: npm test?") and, in voice mode, aloud.
 */
import { getTool } from "./tools";

type Call = { name: string; args: Record<string, unknown> };

/** The tool's own plain-words description of this call ("send an email to bob@…: “Lunch?”"), if it has one. */
function toolSummary(call: Call): string | undefined {
  try {
    const text = getTool(call.name)?.summary?.(call.args ?? {});
    return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : undefined;
  } catch {
    return undefined;
  }
}

/** What a bot asks to do, for approval cards: "Allow the bot to run a command?" */
export const ASKS: Record<string, string> = {
  run_command: "run a command",
  read_file: "read a file",
  write_file: "write a file",
  list_files: "look in a folder",
  read_url: "open a web page",
  open_on_computer: "open something on your computer",
  create_image: "create an image",
  mac_press: "press",
  mac_set_text: "type into a field",
  mac_type: "type on your Mac",
  mac_key: "press keys on your Mac",
  mac_click: "click on your Mac",
  mac_scroll: "scroll on your Mac",
  mac_drag: "drag on your Mac",
  mac_open_app: "open",
  mac_applescript: "run an AppleScript",
  mac_browser: "use your browser",
  mac_recipes: "save a recipe",
  mac_recipe_run: "run a recipe",
  delegate_to_cli_agent: "hand a task to a coding agent",
  create_routine: "create a routine",
  rewind: "undo file changes",
};

const MAIN_ARGS = ["query", "url", "command", "path", "fact", "expression", "prompt", "target", "task", "app", "element", "text", "field", "combo", "script", "name"];

export function mainArg(call: Call): string | undefined {
  const value = MAIN_ARGS.map((k) => call.args[k]).find((v) => typeof v === "string" && v) as string | undefined;
  return value && (value.length > 90 ? `${value.slice(0, 90)}…` : value);
}

export function askTitle(call: Call): string {
  const summary = toolSummary(call);
  if (summary) return `Allow the bot to ${summary}?`;
  const what = ASKS[call.name] ?? `use “${call.name.replace(/^mcp_/, "").replace(/[_-]+/g, " ")}”`;
  const main = mainArg(call);
  return `Allow the bot to ${what}${main ? `: ${main}` : ""}?`;
}

/** Spoken questions read this much of what will run; the rest is on screen (askAloudDetail). */
const SPOKEN_CHARS = 120;

/**
 * What the approval is really about, in full: the command, script or text for most tools; for a
 * routine, what it will do every time it runs (not just its name).
 */
export function askAloudDetail(call: Call): string {
  const routine = /^(create|update)_routine$/.test(call.name);
  const instruction = typeof call.args.instruction === "string" ? call.args.instruction : "";
  const name = typeof call.args.name === "string" ? call.args.name : "";
  const main = routine && instruction ? `${name ? `${name}, which will: ` : ""}${instruction}` : (MAIN_ARGS.map((k) => call.args[k]).find((v) => typeof v === "string" && v) as string | undefined) ?? "";
  return main.slice(0, 2000);
}

/** The same question, worded to be spoken: no quotes; a long command is cut and the rest pointed to on screen. */
export function askAloudText(call: Call): string {
  const summary = toolSummary(call)?.replace(/[“”"`]/g, "");
  if (summary) return `Can I ${summary}? Say yes or no.`;
  const what = ASKS[call.name] ?? (call.name === "update_routine" ? "change a routine" : `use ${call.name.replace(/^mcp_/, "").replace(/[_-]+/g, " ")}`);
  const main = askAloudDetail(call).replace(/[“”"`]/g, "").replace(/\s+/g, " ").trim();
  const long = main.length > SPOKEN_CHARS;
  const spoken = long ? main.slice(0, SPOKEN_CHARS).replace(/\s+\S*$/, "") : main;
  return `Can I ${what}${spoken ? `: ${spoken}` : ""}?${long ? " The rest is on your screen." : ""} Say yes or no.`;
}

/** What the bot is doing during a tool step, for the voice screen. */
export function activityFor(tool: string): string {
  const known: Record<string, string> = {
    mac_screenshot: "Looking at the screen",
    mac_click: "Clicking",
    mac_type: "Typing",
    mac_key: "Pressing keys",
    mac_scroll: "Scrolling",
    mac_drag: "Dragging",
    mac_open_app: "Opening an app",
    mac_list_apps: "Checking open apps",
    mac_applescript: "Running a script",
    run_command: "Running a command",
    read_file: "Reading a file",
    write_file: "Saving a file",
    list_files: "Looking at files",
    open_on_computer: "Opening it",
    web_search: "Searching the web",
    read_url: "Reading a page",
    ask_bot: "Asking another bot",
  };
  return `${known[tool] ?? "Working"}…`;
}
