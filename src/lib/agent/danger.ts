/**
 * Commands that delete, overwrite, escalate, persist, wipe disks, or run code fetched from the
 * internet. These always ask (even with Full access). A pattern list can't be complete, so Full
 * access also asks before any command once the turn has read outside content (see approvals.ts).
 */
const DANGEROUS: RegExp[] = [
  // Deleting: any rm/rmdir/unlink/shred/srm, find -delete or -exec rm, trash.
  /(^|[\s;&|(`$])(rm|rmdir|unlink|shred|srm|trash)(\s|$)/,
  /\bfind\b.*\s-(delete|exec(dir)?\s+(\S*\/)?(rm|shred|unlink|mv|srm|sh|bash|zsh))\b/,
  // Privilege, power, disks.
  /(^|[\s;&|(`])(sudo|su|doas|pkexec)(\s|$)/,
  /\b(mkfs|fdisk|gpt|newfs\w*|shutdown|reboot|halt|poweroff)\b/,
  /\bdd\b.*\b(of|if)=/,
  /\bdiskutil\s+(\w+\s+)?(erase\w*|delete\w*|partition\w*|zero\w*|reformat|secureerase|unmount\w*)/i,
  /\btmutil\s+(delete|disable)/,
  /\bcsrutil\b|\bspctl\s+--?(master-)?disable|\bnvram\b/,
  // Git history and working-tree destruction (also a force push by "+branch", and inline aliases).
  /\bgit\s+(clean\b|reset\s+--hard|checkout\s+(--\s+)?\.(\s|$)|restore\s+(--\S+\s+)*\.(\s|$)|push\s+.*(-f\b|--force|\s\+\S)|branch\s+-D|stash\s+(drop|clear)|filter-branch|update-ref\s+-d)/,
  /\bgit\b[^;&|]*\s-c\s+alias\./,
  // Wiping by other means: rsync --delete, moving or copying over with /dev/null, moving folders out of home.
  /\brsync\b[^;&|]*\s--delete/,
  /\b(mv|cp)\b[^;&|]*\s\/dev\/null\b/,
  /\bmv\s+(-\S+\s+)*(~|\$\{?HOME\}?|\/Users\/)/,
  /\bsqlite3\b.*\b(delete|drop|update|insert)\b/i,
  // Permissions and ownership, recursive or on the home folder.
  /\b(chmod|chown|chgrp|chflags)\s+(\S+\s+)*(-[a-zA-Z]*R|--recursive)\b/,
  /\b(chmod|chown|chgrp)\b[^;&|]*\s(~|\$\{?HOME\}?|\/Users|\/System|\/etc|\/usr)(\/|\s|$)/,
  /\bchmod\s+(-\S+\s+)*0{3}\b/,
  // Processes and system services, persistence.
  /\b(kill|killall|pkill)\b/,
  /\b(launchctl|crontab|systemctl)\s+\S|(^|[;&|]\s*)at\s+\S/,
  /\bdefaults\s+(delete|write)\b/,
  /\bsecurity\s+(find-\w+-password|dump-keychain|delete-\w+|export|unlock-keychain)/,
  /\bosascript\b/,
  /\b(networksetup\s+-set|scutil\s+--set|pfctl\b|route\s+(-\S+\s+)*(add|delete|change)\b)/,
  // Code from the internet straight into an interpreter.
  /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(\w*sh|python\d*(\.\d+)?|node|ruby|perl|php|osascript|bun|deno)\b/,
  /\b(\w*sh|python\d*|node|ruby|perl|bun|deno)\s+(-\S+\s+)*<\(\s*(curl|wget)/,
  /\$\(\s*(curl|wget)\b/,
  // Anything piped into a shell (base64, rev, printf…), or a shell fed a here-doc or here-string.
  /\|\s*(sudo\s+)?(ba|z|da|k|c|tc|fi)?sh\b(\s|$)/,
  /\|\s*(python\d*(\.\d+)?|node|ruby|perl|php|bun|deno|osascript)\s*(-\s*)?$/,
  /\b(ba|z|da|k)?sh\s*<</,
  // Downloading and running in one go.
  /\b(curl|wget)\b.*(&&|;|\|\|)\s*((ba|z|da)?sh|chmod\s+\+x)\s/,
  // Sending local files out.
  /\b(curl|wget)\b[^;&|]*(\s-T\s|--upload-file|\s-d\s*@|--data[\w-]*\s*@|\s-F\s*\S+=@|--post-file)/,
  /\b(scp|sftp|rsync)\b[^;&|]*\s\S+:/,
  /\|\s*ssh\b/,
  /\b(curl|wget|nc)\b[^;&|]*(\$\(|`)/,
  /\b(nc|ncat|netcat|socat)\b/,
  // Inline code that deletes files or runs other programs.
  /\b(python\d*(\.\d+)?|node|ruby|perl|php|bun|deno)\s+(-\S+\s+)*-[a-zA-Z]*[ce]\b.*\b(rmtree|remove|unlink|rmdir|rmSync|rm_rf|rm_r|truncate|system|popen|subprocess|child_process|exec\w*|spawn\w*|eval|writeFile\w*|open\s*\(|getattr|__import__|__dict__|importlib|urlopen|socket|requests\.(post|put))/,
  // Overwriting with a redirect: the home folder, dotfiles, absolute paths (not /dev/null), devices.
  /(^|[^>&0-9])>\|?\s*(~|\$\{?HOME\}?|\/(?!dev\/null\b)|\.[\w-]+(\/|\s|$)|\.\.\/|\/dev\/(?!null\b))/,
  /\btee\b(\s+-a)?\s+(~|\$HOME|\/|\.\w)/,
  /\b(truncate|shred)\b|(^|[;&|]\s*):\s*>/,
  // Hiding what runs: eval, decoding, commands built from variables.
  /\beval\b|\bbase64\s+(-d|-D|--decode)|\bxxd\s+-r|\bopenssl\s+(enc|base64)\s+.*-d/,
  /(^|[;&|(`]\s*)\$\{?\w+\}?(\s|$)/,
  /\$\{?\w+\}?[a-zA-Z]|[a-zA-Z]\$\{?\w+\}?(\s|$)/,
  /\b(exec|source)\s+<\(|\bcommand\s+-p\b/,
  /\$\{?IFS\}?/,
  // A command word disguised with a glob ("[r]m", "/bin/r?") or zsh's "=rm".
  /(^|[;&|(`]\s*)(\S*[?*[\]]\S*|=\w+)\s/,

  // Windows (cmd and PowerShell): deleting, formatting, code from text or the internet, persistence.
  /\b(del|erase)\s+(\S+\s+)*\/[sq]\b/i,
  /\b(rd|rmdir)\s+(\S+\s+)*\/s\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(remove-item|ri|rm|del|erase|rmdir|rd)\b[^;&|]*\s-(r|recurse)\b/i,
  /\b(clear-content|clear-recyclebin|format-volume|clear-disk|remove-partition|initialize-disk)\b/i,
  /\b(iex|invoke-expression|invoke-command|start-process|set-executionpolicy|stop-process|taskkill)\b/i,
  /\b(powershell|pwsh)(\.exe)?\b[^;&|]*\s-(e|ec|en|enc|enco\w*)\s/i,
  /\b(downloadstring|downloadfile|invoke-webrequest|invoke-restmethod|iwr|irm|start-bitstransfer)\b[^;&]*\|/i,
  /\breg(\.exe)?\s+(add|delete|import|load|restore)\b/i,
  /\bschtasks(\.exe)?\s+\/(create|change|delete)\b/i,
  /\bcipher(\.exe)?\s+\/w/i,
  /\b(bcdedit|vssadmin|wbadmin|takeown|diskpart)\b/i,
  /\bwmic\b.*\bdelete\b/i,
  /\bicacls\b.*\/(grant|deny|remove|reset|setowner)\b/i,
  /\bnet\s+(user|localgroup)\b.*\/(add|delete)\b/i,
  /\bsc(\.exe)?\s+(create|delete|config)\b/i,
];

/** "$'\x72\x6d'": a word spelled in hex or octal escapes hides what it says. */
const HIDDEN_ESCAPES = /\$'[^']*\\(x[0-9a-f]{2}|[0-7]{3})/i;

/**
 * The command as the checks read it: quotes and backslashes removed (so `r''m` and `\rm` can't hide
 * a word), command words without their folder (`/bin/rm` → `rm`), wrappers that run the next word
 * removed (`env`, `nohup`, `time`, `xargs -0`…), and git's `-C dir` / `-c key=value` dropped.
 */
export function commandForChecks(command: string): string {
  let plain = command.replace(/['"\\]/g, "");
  const start = "(^|[;&|(`]\\s*|\\$\\(\\s*)";
  const wrapper = new RegExp(
    `${start}(env(\\s+-\\S+|\\s+\\w+=\\S*)*|command|builtin|nohup|nice(\\s+-n)?(\\s+-?\\d+)?|time|exec|stdbuf(\\s+-\\S+)*|caffeinate(\\s+-\\S+)*|doas|xargs(\\s+-\\S+(\\s+\\{\\})?)*)\\s+`,
    "g",
  );
  const folder = new RegExp(`${start}(?:[\\w.~-]*\\/)+([\\w.+-]+)(?=\\s|$)`, "g");
  for (let i = 0; i < 3; i++) plain = plain.replace(wrapper, "$1").replace(folder, "$1$2");
  return plain.replace(/\bgit((\s+-[Cc]\s+\S+)+)(?=\s)/g, (all, flags: string) => (/-c\s+alias\./.test(flags) ? all : "git"));
}

/** Whether a shell command deletes, overwrites, escalates, persists, sends data out or hides what it runs. */
export const isDangerous = (command: string) => {
  if (HIDDEN_ESCAPES.test(command)) return true;
  const plain = commandForChecks(command);
  return DANGEROUS.some((pattern) => pattern.test(plain));
};

/**
 * Apps where typed text runs as code: terminals (by name, part of a name, or bundle id, since the
 * helper also finds apps that way) and script runners.
 */
export const TERMINAL_APPS =
  /terminal|iterm|warp|alacritty|kitty|wezterm|ghostty|hyper|tabby|termius|console|powershell|pwsh|\bcmd\b|command prompt|conhost|\bwsl\b|mintty|git bash|script ?editor|scripteditor|automator|shortcuts|xterm|konsole|tilix|terminator/i;

const TERMINAL_NAMES = ["terminal", "iterm2", "warp", "alacritty", "kitty", "wezterm", "ghostty", "hyper", "tabby", "termius", "console", "powershell", "pwsh", "cmd", "command prompt", "conhost", "wsl", "mintty", "git bash", "script editor", "automator", "shortcuts", "xterm", "konsole", "tilix", "terminator", "windowsterminal"];

/** A named app is a terminal, or the start or part of a terminal's name (the helper finds apps by prefix too). */
export function isTerminalApp(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return TERMINAL_APPS.test(n) || (n.length >= 3 && TERMINAL_NAMES.some((t) => t.includes(n)));
}
