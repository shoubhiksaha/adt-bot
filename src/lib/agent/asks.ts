/**
 * How an action a bot wants to take is put to the user: on approval cards ("Allow the bot to run a
 * command: npm test?") and, in voice mode, aloud.
 */
type Call = { name: string; args: Record<string, unknown> };

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
  const what = ASKS[call.name] ?? `use “${call.name.replace(/^mcp_/, "").replace(/[_-]+/g, " ")}”`;
  const main = mainArg(call);
  return `Allow the bot to ${what}${main ? `: ${main}` : ""}?`;
}

/** The same question, worded to be spoken: shorter, no quotes or ellipses. */
export function askAloudText(call: Call): string {
  const what = ASKS[call.name] ?? `use ${call.name.replace(/^mcp_/, "").replace(/[_-]+/g, " ")}`;
  const main = mainArg(call)?.replace(/[“”"`]/g, "").replace(/…$/, "");
  const shortMain = main && main.length > 60 ? `${main.slice(0, 60).replace(/\s+\S*$/, "")}` : main;
  return `Can I ${what}${shortMain ? `: ${shortMain}` : ""}? Say yes or no.`;
}
