/** Pure helpers for bot computers: command risk, labels. No app state here (unit tested). */
import type { ToolRisk } from "../../lib/agent/tools";

/** Commands that only look at things. Anything else inside the sandbox asks first. */
const READ_ONLY = new Set([
  "ls", "ll", "cat", "pwd", "echo", "printf", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "stat", "file", "du", "df",
  "whoami", "id", "uname", "date", "which", "type", "tree", "sort", "uniq", "cut", "diff", "cmp", "md5sum", "sha1sum", "sha256sum",
  "basename", "dirname", "realpath", "readlink", "hostname", "uptime", "free", "ps", "nproc", "true", "test", "[", "less", "more", "column",
  "jq", "nl", "tac", "od", "hexdump", "xxd", "base64",
]);

/** Version / help probes are read-only for any program ("python3 --version", "git status"). */
const READ_ONLY_FORMS = [
  /^[\w.+-]+\s+(--version|-V|--help|-h|version)$/,
  /^git\s+(status|log|diff|show|ls-files|rev-parse)(\s+(?!--output)\S+)*$/,
  /^git\s+(branch(\s+-(a|r|v|vv))*|remote(\s+-v)?|config\s+--get\s+\S+)$/,
  /^(pip3?|npm)\s+(list|ls|freeze|show)(\s+\S+)*$/,
];

/** Still sandboxed, but these can wreck the bot's files or the container, so they always ask. */
const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rRf]/, // rm -r / -f / -rf
  /\brm\s+(-[a-zA-Z]+\s+)*(\/|~|\*|\/workspace\/?)(\s|$)/,
  /\b(mkfs|shred|wipefs)\b/,
  /\bdd\s+[^|]*\bof=/,
  /\bfind\b[^|]*\s-delete\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\bchmod\s+-R\b|\bchown\s+-R\b/,
  /\bgit\s+(clean\s+-[a-zA-Z]*f|reset\s+--hard|push\s+[^|]*--force)/,
  /\btruncate\b/,
  /\bkill(all)?\s+-9\s+(-1|1)\b/,
];

/** Shell features that can write or run something else even after a read-only verb. */
const SIDE_EFFECTS =
  /[><`]|\$\(|\b(sed|perl)\s+-i|\s-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b|\bxargs\b|\btee\b|--pre\b|--compress-program|--to-command|--checkpoint-action|--use-compress-program/;

/** Splits on ; & && || | and newlines (good enough to judge each step; not a full shell parser). */
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || SIDE_EFFECTS.test(c)) return false;
  return segments(c).every((seg) => {
    const words = seg.split(/\s+/);
    // "FOO=1 ls" sets an env var for the command; still judge the command.
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const verb = words[0] ?? "";
    if (READ_ONLY.has(verb)) return true;
    const rest = words.join(" ");
    return READ_ONLY_FORMS.some((re) => re.test(rest));
  });
}

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(command));
}

/** computer_run's per-call risk: commands run inside the bot's own container. */
export function riskForCommand(command: string): ToolRisk {
  if (isDestructiveCommand(command)) return "destructive";
  if (isReadOnlyCommand(command)) return "read";
  return "write";
}

/** Did this command probably pull in content from the internet? */
export function fetchesWeb(command: string): boolean {
  return /\b(curl|wget|git\s+(clone|pull|fetch)|pip3?\s+(install|download)|npm\s+(install|i|view)|npx|apt(-get)?\s+install|lynx|chromium)\b/.test(command);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Joins a folder and a child name inside the container. */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(dir: string): string {
  const parts = dir.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/") || "/";
}
