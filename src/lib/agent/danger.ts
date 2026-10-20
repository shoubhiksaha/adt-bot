/**
 * Commands that delete, overwrite, escalate, persist, wipe disks, or run code fetched from the
 * internet. These always ask (even with Full access). A pattern list can't be complete, so Full
 * access also asks before any command once the turn has read outside content (see approvals.ts).
 */
const DANGEROUS: RegExp[] = [
  // Deleting: any rm/rmdir/unlink/shred/srm, find -delete or -exec rm, trash.
  /(^|[\s;&|(`$])(rm|rmdir|unlink|shred|srm|trash)(\s|$)/,
  /\bfind\b.*\s-(delete|exec(dir)?\s+(rm|shred|unlink|mv))\b/,
  // Privilege, power, disks.
  /(^|[\s;&|(`])(sudo|su|doas|pkexec)(\s|$)/,
  /\b(mkfs|fdisk|gpt|newfs\w*|shutdown|reboot|halt|poweroff)\b/,
  /\bdd\b.*\b(of|if)=/,
  /\bdiskutil\s+(\w+\s+)?(erase\w*|delete\w*|partition\w*|zero\w*|reformat|secureerase|unmount\w*)/i,
  /\btmutil\s+(delete|disable)/,
  /\bcsrutil\b|\bspctl\s+--?(master-)?disable|\bnvram\b/,
  // Git history and working-tree destruction.
  /\bgit\s+(clean\b|reset\s+--hard|checkout\s+(--\s+)?\.(\s|$)|restore\s+(--\S+\s+)*\.(\s|$)|push\s+.*(-f\b|--force)|branch\s+-D|stash\s+(drop|clear)|filter-branch|update-ref\s+-d)/,
  // Permissions and ownership, recursive or on the home folder.
  /\b(chmod|chown|chgrp|chflags)\s+(\S+\s+)*(-[a-zA-Z]*R|--recursive)\b/,
  /\b(chmod|chown|chgrp)\b[^;&|]*\s(~|\$HOME|\/Users|\/System|\/etc|\/usr)(\/|\s|$)/,
  // Processes and system services, persistence.
  /\b(kill|killall|pkill)\b/,
  /\b(launchctl|crontab|systemctl)\s+\S|(^|[;&|]\s*)at\s+\S/,
  /\bdefaults\s+(delete|write)\b/,
  /\bsecurity\s+(find-\w+-password|dump-keychain|delete-\w+|export|unlock-keychain)/,
  /\bosascript\b/,
  // Code from the internet straight into an interpreter.
  /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(\w*sh|python\d*(\.\d+)?|node|ruby|perl|php|osascript|bun|deno)\b/,
  /\b(\w*sh|python\d*|node|ruby|perl|bun|deno)\s+(-\S+\s+)*<\(\s*(curl|wget)/,
  /\$\(\s*(curl|wget)\b/,
  // Sending local files out.
  /\b(curl|wget)\b[^;&|]*(\s-T\s|--upload-file|\s-d\s*@|--data[\w-]*\s*@|\s-F\s*\S+=@|--post-file)/,
  /\b(scp|sftp|rsync)\b[^;&|]*\s\S+:/,
  /\b(nc|ncat|netcat|socat)\b/,
  // Inline code that deletes files or runs other programs.
  /\b(python\d*(\.\d+)?|node|ruby|perl|php|bun|deno)\s+(-\S+\s+)*-[a-zA-Z]*[ce]\b.*\b(rmtree|remove|unlink|rmdir|rmSync|rm_rf|rm_r|truncate|system|popen|subprocess|child_process|exec\w*|spawn\w*|eval|writeFile\w*|open\s*\()/,
  // Overwriting with a redirect: the home folder, dotfiles, absolute paths (not /dev/null), devices.
  /(^|[^>&0-9])>\|?\s*(~|\$HOME|\/(?!dev\/null\b)|\.[\w-]+(\/|\s|$)|\/dev\/(?!null\b))/,
  /\btee\b(\s+-a)?\s+(~|\$HOME|\/|\.\w)/,
  /\b(truncate|shred)\b|(^|[;&|]\s*):\s*>/,
  // Hiding what runs: eval, decoding, commands built from variables.
  /\beval\b|\bbase64\s+(-d|-D|--decode)|\bxxd\s+-r|\bopenssl\s+(enc|base64)\s+.*-d/,
  /(^|[;&|(`]\s*)\$\{?\w+\}?(\s|$)/,
  /\$\{?\w+\}?[a-zA-Z]|[a-zA-Z]\$\{?\w+\}?(\s|$)/,
  /\b(exec|source)\s+<\(|\bcommand\s+-p\b/,
];

/** Quotes and backslashes are stripped first, so `r''m -rf` or `\\rm` can't hide a command. */
export const isDangerous = (command: string) => {
  const plain = command.replace(/['"\\]/g, "");
  return DANGEROUS.some((pattern) => pattern.test(plain));
};
