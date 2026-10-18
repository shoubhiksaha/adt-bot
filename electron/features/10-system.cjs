// "This computer": run commands and read/write files on the user's machine. Every call is
// approved in the app first (see src/lib/agent/approvals.ts); this side only executes.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_OUTPUT = 200_000;

function workspaceDir() {
  const dir = path.join(os.homedir(), "ADT Bot Workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Relative paths are inside the workspace; "~" is the home folder. */
function resolvePath(input) {
  const raw = String(input || ".").trim();
  if (raw === "~" || raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(1));
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(workspaceDir(), raw);
}

function shellFor(command) {
  if (process.platform === "win32") return ["cmd.exe", ["/d", "/s", "/c", command]];
  return [process.env.SHELL || "/bin/zsh", ["-lc", command]];
}

function exec({ command, cwd, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const [bin, args] = shellFor(String(command));
    const child = spawn(bin, args, { cwd: resolvePath(cwd || "."), env: process.env });
    let output = "";
    const take = (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      output += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`;
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.length >= MAX_OUTPUT ? `${output}\n[output cut]` : output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(error.message) });
    });
  });
}

exports.register = ({ ipcMain, shell }) => {
  ipcMain.handle("adt:system:info", () => ({
    workspace: workspaceDir(),
    platform: process.platform,
    arch: process.arch,
    home: os.homedir(),
    user: os.userInfo().username,
    hostname: os.hostname(),
  }));
  ipcMain.handle("adt:system:exec", (_e, payload) => exec(payload ?? {}));
  ipcMain.handle("adt:system:read", (_e, { path: p, maxBytes = 400000 } = {}) => {
    const file = resolvePath(p);
    const buffer = fs.readFileSync(file);
    const slice = buffer.subarray(0, maxBytes);
    if (slice.includes(0)) return { path: file, binary: true, size: buffer.length, text: "" };
    return { path: file, binary: false, size: buffer.length, text: slice.toString("utf8"), truncated: buffer.length > maxBytes };
  });
  ipcMain.handle("adt:system:write", (_e, { path: p, content = "", append = false } = {}) => {
    const file = resolvePath(p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (append) fs.appendFileSync(file, String(content));
    else fs.writeFileSync(file, String(content));
    return { path: file, size: fs.statSync(file).size };
  });
  ipcMain.handle("adt:system:list", (_e, { path: p } = {}) => {
    const dir = resolvePath(p);
    return {
      path: dir,
      entries: fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map((d) => {
        let size = 0;
        try {
          size = d.isFile() ? fs.statSync(path.join(dir, d.name)).size : 0;
        } catch {}
        return { name: d.name, type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "link" : "file", size };
      }),
    };
  });
  ipcMain.handle("adt:system:open", (_e, { target } = {}) => {
    const value = String(target || "");
    if (/^https?:\/\//.test(value)) return shell.openExternal(value);
    return shell.openPath(resolvePath(value));
  });
};

exports._test = { resolvePath, exec, workspaceDir };
