// "This computer": run commands and read/write files on the user's machine. Every call is
// approved in the app first (see src/lib/agent/approvals.ts); this side executes, and enforces
// Sandbox mode on its own: only the workspace folder, and commands confined by the OS.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSnapshots, plainIo, validTurn } = require("../rewind.cjs");

const MAX_OUTPUT = 200_000;

/** Earlier versions of files bots changed, per turn, for undo (electron/rewind.cjs). Set up in register(). */
let snapshots = null;
const ACCESS_MODES = new Set(["sandbox", "restricted", "full"]);

/** Shared with the other features (main.cjs); the app keeps it in step with the setting. */
let access = { mode: "sandbox" };

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

const SANDBOX_REFUSAL = "Sandbox mode: bots can only use the ADT Bot Workspace folder.";

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isInside(dir, file) {
  return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** Inside the workspace, by its plain or real path. */
function inWorkspace(file) {
  const dir = workspaceDir();
  let real = path.resolve(file);
  try {
    real = path.join(fs.realpathSync(path.dirname(real)), path.basename(real));
  } catch {}
  return isInside(dir, path.resolve(file)) || isInside(fs.realpathSync(dir), real);
}

/**
 * Sandbox mode: the real location (every symlink followed) must be inside the workspace. Parts
 * that don't exist yet are about to be created there. A dangling symlink can't be followed, so
 * it's refused rather than written through.
 */
function confine(file, mode = access.mode) {
  if (mode !== "sandbox") return file;
  const root = fs.realpathSync(workspaceDir());
  let probe = path.resolve(file);
  const rest = [];
  while (!exists(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    rest.unshift(path.basename(probe));
    probe = up;
  }
  let real;
  try {
    real = path.join(fs.realpathSync(probe), ...rest);
  } catch {
    throw new Error(SANDBOX_REFUSAL);
  }
  if (!isInside(root, real)) throw new Error(SANDBOX_REFUSAL);
  return real;
}

/**
 * macOS Seatbelt profile for Sandbox mode. The last matching rule wins.
 * - Network: no connections out (not even to this computer's own servers or local sockets such as
 *   Docker's or ssh-agent's), so nothing in the workspace can be sent anywhere. Linux's bwrap
 *   --unshare-all does the same.
 * - Files: read and write the workspace (which holds the sandbox's own $HOME and $TMPDIR). Nothing
 *   else under any user's folder (only the home folder's own metadata, which tools need to resolve
 *   paths), shared or per-user temp folders, other volumes, apps' shared data, system-wide
 *   preferences (except the Xcode licence record, which git and python3 check), keychains or logs.
 *   The system itself (/usr, /System, /etc…) stays readable so commands and toolchains run.
 * - No way to start programs outside the sandbox or act through other processes: Launch Services,
 *   Apple Events, launchd, the window server (screen and input), the pasteboard, preferences
 *   (cfprefsd reads and writes them on a process's behalf) and Spotlight (lists any file name).
 */
const MAC_PROFILE = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (subpath (param "WORKSPACE"))))
(deny file-write*)
(allow file-write*
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/") (regex #"^/dev/ttys"))
(deny file-read* file-write* (subpath (param "HOME")) (subpath "/Users") (subpath "/Volumes")
  (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/private/var/folders")
  (subpath "/Library/Application Support") (subpath "/Library/Preferences") (subpath "/Library/Keychains")
  (subpath "/Library/Logs") (subpath "/private/var/log"))
(allow file-read-metadata (literal "/Users"))
(allow file-read* (literal "/Library/Preferences/com.apple.dt.Xcode.plist"))
(allow file-read-metadata (literal (param "HOME")))
(allow file-read-metadata (regex #"^/private/var(/folders(/[^/]+(/[^/]+(/[TC])?)?)?)?/?$"))
(allow file-read* file-write*
  (regex #"^/private/var/folders/[^/]+/[^/]+/T/(xcrun_db|tmp\\.)[^/]*$")
  (regex #"^/private/var/folders/[^/]+/[^/]+/C/(clang|org\\.llvm\\.clang|com\\.apple\\.DeveloperTools)(/|$)"))
(allow file-read* file-write* (subpath (param "WORKSPACE")))
(deny appleevent-send)
(deny mach-lookup
  (global-name-regex #"^com\\.apple\\.coreservices\\.")
  (global-name-regex #"^com\\.apple\\.lsd\\.")
  (global-name-regex #"^com\\.apple\\.windowserver")
  (global-name-regex #"^com\\.apple\\.pasteboard")
  (global-name-regex #"^com\\.apple\\.cfprefsd")
  (global-name-regex #"^com\\.apple\\.metadata\\.mds")
  (global-name "com.apple.ScriptingAdditions")
  (global-name "com.apple.tccd")
  (global-name "com.apple.tccd.system"))
(deny process-exec
  (literal "/usr/bin/open")
  (literal "/usr/bin/osascript")
  (literal "/bin/launchctl")
  (literal "/usr/bin/automator")
  (literal "/usr/bin/shortcuts")
  (literal "/usr/bin/sudo")
  (literal "/usr/bin/pbcopy")
  (literal "/usr/bin/pbpaste"))`;

const BWRAP = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];

/** Whether this system can confine processes (macOS always; Linux with bubblewrap). */
function canSandbox() {
  if (process.platform === "darwin") return true;
  return process.platform === "linux" && BWRAP.some((p) => fs.existsSync(p));
}

/** How to run `argv` confined to the workspace, or an Error when this system can't. */
function sandboxArgv(argv, cwd) {
  const workspace = fs.realpathSync(workspaceDir());
  const home = fs.realpathSync(os.homedir());
  // Tools that keep caches, config and temp files in $HOME / $TMPDIR use folders in the workspace.
  const sandboxHome = path.join(workspace, ".sandbox-home");
  const sandboxTmp = path.join(workspace, ".sandbox-tmp");
  fs.mkdirSync(sandboxHome, { recursive: true });
  fs.mkdirSync(sandboxTmp, { recursive: true });
  const env = {
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(path.delimiter),
    HOME: sandboxHome,
    TMPDIR: sandboxTmp,
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: "dumb",
    USER: process.env.USER || "",
  };
  if (process.platform === "darwin") {
    return { bin: "/usr/bin/sandbox-exec", args: ["-D", `WORKSPACE=${workspace}`, "-D", `HOME=${home}`, "-p", MAC_PROFILE, ...argv], env };
  }
  if (process.platform === "linux") {
    const bwrap = BWRAP.find((p) => fs.existsSync(p));
    if (!bwrap) return new Error("Sandbox mode needs bubblewrap to run commands on Linux. Install it (e.g. sudo apt install bubblewrap), or change Computer access in Settings.");
    // Read-only system, empty home, /run (desktop and D-Bus sockets), /tmp and removable media; the
    // workspace mounted back in; no network (also cuts off X11's abstract sockets).
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    for (const dir of ["/tmp", "/run", "/var/tmp", "/mnt", "/media", "/home", "/root", home]) args.push("--tmpfs", dir);
    args.push("--bind", workspace, workspace, "--unshare-all", "--die-with-parent", "--new-session", "--chdir", cwd, "--", ...argv);
    return { bin: bwrap, args, env };
  }
  return new Error("Sandbox mode can't run commands on Windows yet. Change Computer access in Settings → Tools & safety to let bots run commands.");
}

/** Kept for tests and callers that pass a shell command. */
function sandboxCommand(command, cwd) {
  return sandboxArgv(process.platform === "darwin" ? ["/bin/zsh", "-c", command] : ["/bin/sh", "-c", command], cwd);
}

function shellFor(command) {
  if (process.platform === "win32") return ["cmd.exe", ["/d", "/s", "/c", command]];
  return [process.env.SHELL || "/bin/zsh", ["-lc", command]];
}

/** Ends a command and anything it left running in its process group. */
function killGroup(child, signal = "SIGKILL") {
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, signal);
  } catch {}
}

/** Commands running now, by the id the app gave them (for Stop and "Stop all bots"). */
const running = new Map();

function stopCommand(id) {
  const child = running.get(id);
  if (!child) return false;
  child.stoppedByUser = true;
  killGroup(child, "SIGTERM");
  setTimeout(() => killGroup(child), 1500).unref?.();
  return true;
}

function stopAllCommands() {
  for (const id of [...running.keys()]) stopCommand(id);
}

/**
 * Commands run in the workspace get a snapshot of it first (bounded: see electron/rewind.cjs), so
 * the turn's changes to its files can be undone. Commands elsewhere can't be covered.
 */
function snapshotWorkspace(turn, conversation, dir, sandboxed) {
  if (!snapshots || !validTurn(turn) || !inWorkspace(dir)) return null;
  try {
    return snapshots.beforeCommand(turn, workspaceDir(), { conversation, confined: sandboxed });
  } catch {
    return null;
  }
}

function finishSnapshot(snap) {
  if (!snap) return;
  try {
    snapshots?.afterCommand(snap);
  } catch (error) {
    console.warn("Couldn't record the command's file changes:", error);
  }
}

function exec({ id, command, cwd, timeoutMs = 120000, turn, conversation }, mode = access.mode) {
  return new Promise((resolve) => {
    let bin;
    let args;
    let env = process.env;
    let dir;
    const sandboxed = mode === "sandbox";
    const limit = Math.max(1000, Math.min(Number(timeoutMs) || 120000, 600000));
    try {
      dir = confine(resolvePath(cwd || "."), mode);
      if (sandboxed) {
        const plan = sandboxCommand(String(command), dir);
        if (plan instanceof Error) return resolve({ code: -1, output: plan.message });
        ({ bin, args, env } = plan);
      } else {
        [bin, args] = shellFor(String(command));
      }
    } catch (error) {
      return resolve({ code: -1, output: String(error.message) });
    }
    const snap = snapshotWorkspace(turn, conversation, dir, sandboxed);
    // Its own process group, so Stop and the time limit end everything it started.
    const child = spawn(bin, args, { cwd: dir, env, detached: process.platform !== "win32" });
    const key = id ? String(id) : `cmd-${child.pid}-${Date.now()}`;
    running.set(key, child);
    let output = "";
    const take = (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child), 1500).unref?.();
      output += `\n[stopped after ${Math.round(limit / 1000)} s]`;
    }, limit);
    child.on("close", (code) => {
      clearTimeout(timer);
      running.delete(key);
      // Sandboxed commands can't leave anything behind; elsewhere, servers a command started on
      // purpose (`npm run dev &`) keep running. Stop and the time limit still end the whole group.
      if (sandboxed) killGroup(child);
      if (child.stoppedByUser) output += "\n[stopped]";
      finishSnapshot(snap);
      resolve({ code, output: output.length >= MAX_OUTPUT ? `${output}\n[output cut]` : output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      running.delete(key);
      finishSnapshot(snap);
      resolve({ code: -1, output: String(error.message) });
    });
  });
}

/** Runs a fixed shell script inside the sandbox, with user values only as arguments. */
function runSandboxed(script, values, { input, cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const plan = sandboxArgv(["/bin/sh", "-c", script, "sh", ...values.map(String)], cwd ?? fs.realpathSync(workspaceDir()));
    if (plan instanceof Error) return reject(plan);
    const child = spawn(plan.bin, plan.args, { cwd: cwd ?? workspaceDir(), env: plan.env, detached: process.platform !== "win32" });
    const out = [];
    let err = "";
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk.toString()));
    const timer = setTimeout(() => killGroup(child), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup(child);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.replace(/^sh: (line \d+: )?/gm, "").trim() || `failed (${code})`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

/*
 * Sandbox-mode file access goes through the OS sandbox too. Checking a path and then opening it
 * is a race: a command the bot started could swap a folder for a symlink in between. Inside the
 * sandbox the kernel checks every open, so no swap can reach outside the workspace.
 */
const READ_SCRIPT = 'wc -c < "$1" | tr -d " " && head -c "$2" "$1"';
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && if [ "$2" = a ]; then cat >> "$1"; else cat > "$1"; fi && wc -c < "$1" | tr -d " "';
const LIST_SCRIPT = `cd -- "$1" || exit 1
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then t=link; n=0; elif [ -d "$f" ]; then t=dir; n=0; else t=file; n=$(wc -c < "$f" 2>/dev/null | tr -d " "); fi
  printf '%s\\t%s\\t%s\\n' "$t" "\${n:-0}" "$f"
done`;

/** Snapshots and undo in Sandbox mode read and write workspace files through the sandbox too. */
const confinedIo = {
  async read(file) {
    const out = await runSandboxed('[ -f "$1" ] || { printf N; exit 0; }; printf Y; cat -- "$1"', [file]);
    return out[0] === 0x59 ? out.subarray(1) : null;
  },
  async write(file, buffer) {
    await runSandboxed(WRITE_SCRIPT, [file, "w"], { input: buffer });
  },
  async remove(file) {
    await runSandboxed('rm -f -- "$1"', [file]);
  },
};

/** What a file held before write_file changes it, when this call belongs to a turn. Undo is best effort: never fails the write. */
async function snapshotBefore(turn, file, mode) {
  if (!snapshots || !validTurn(turn)) return null;
  try {
    return await snapshots.capture(file, mode === "sandbox" && canSandbox() ? confinedIo : plainIo);
  } catch {
    return null;
  }
}

/**
 * Undoes a turn's file changes. In Sandbox mode a bot can only undo inside the workspace (the user
 * can undo anything the list showed them), and workspace files are written through the sandbox.
 */
function restoreTurn({ turn, force = false, by = "user" } = {}, mode = access.mode) {
  if (!snapshots) throw new Error("Undo isn't available.");
  const sandboxed = mode === "sandbox";
  const viaSandbox = (file) => sandboxed && canSandbox() && inWorkspace(file);
  return snapshots.restore(String(turn ?? ""), {
    force: force === true,
    allow: (file) => !(sandboxed && by === "bot") || inWorkspace(file),
    io: {
      read: plainIo.read,
      write: (file, buffer, fileMode) => (viaSandbox(file) ? confinedIo.write(file, buffer) : plainIo.write(file, buffer, fileMode)),
      remove: (file) => (viaSandbox(file) ? confinedIo.remove(file) : plainIo.remove(file)),
    },
  });
}

function toFile(buffer, file, maxBytes) {
  const slice = buffer.subarray(0, maxBytes);
  if (slice.includes(0)) return { path: file, binary: true, size: buffer.length, text: "" };
  return { path: file, binary: false, size: buffer.length, text: slice.toString("utf8"), truncated: buffer.length > maxBytes };
}

async function readFile({ path: p, maxBytes = 400000 } = {}, mode = access.mode) {
  const file = confine(resolvePath(p), mode);
  if (mode === "sandbox" && canSandbox()) {
    const out = await runSandboxed(READ_SCRIPT, [file, maxBytes]);
    const nl = out.indexOf(10);
    const size = Number(out.subarray(0, nl).toString()) || 0;
    const body = out.subarray(nl + 1);
    if (body.subarray(0, maxBytes).includes(0)) return { path: file, binary: true, size, text: "" };
    return { path: file, binary: false, size, text: body.toString("utf8"), truncated: size > maxBytes };
  }
  return toFile(fs.readFileSync(file), file, maxBytes);
}

async function writeFile({ path: p, content = "", append = false, overwrite = false, turn, conversation } = {}, mode = access.mode) {
  const file = confine(resolvePath(p), mode);
  // Replacing a file outside the workspace is destructive: the app asks first only when the bot
  // says so (overwrite), so refuse a silent replace here.
  if (!append && !overwrite && mode !== "sandbox" && !inWorkspace(file) && exists(file)) {
    throw new Error(`${file} already exists. To replace it, call write_file again with overwrite: true (the user will be asked), or use append.`);
  }
  const before = await snapshotBefore(turn, file, mode);
  let result;
  if (mode === "sandbox" && canSandbox()) {
    const out = await runSandboxed(WRITE_SCRIPT, [file, append ? "a" : "w"], { input: String(content) });
    result = { path: file, size: Number(out.toString().trim()) || 0 };
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (append) fs.appendFileSync(file, String(content));
    else fs.writeFileSync(file, String(content));
    result = { path: file, size: fs.statSync(file).size };
  }
  if (before) {
    try {
      snapshots.record(turn, file, before, { conversation, tool: "write_file" });
    } catch (error) {
      console.warn("Couldn't keep the file's earlier version:", error);
    }
  }
  return result;
}

async function listFiles({ path: p } = {}, mode = access.mode) {
  const dir = confine(resolvePath(p), mode);
  if (mode === "sandbox" && canSandbox()) {
    const out = (await runSandboxed(LIST_SCRIPT, [dir])).toString("utf8");
    const entries = out
      .split("\n")
      .filter(Boolean)
      .slice(0, 500)
      .map((line) => {
        const [type, size, ...name] = line.split("\t");
        return { name: name.join("\t"), type, size: Number(size) || 0 };
      });
    return { path: dir, entries };
  }
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
}

/**
 * Opens a web link, or a file or folder with its default app. In Sandbox mode files are only shown
 * in their folder: opening one could start a program (an app, script, installer or shortcut)
 * outside the sandbox.
 */
async function openTarget(shell, target, mode = access.mode) {
  const value = String(target || "").trim();
  if (/^https?:\/\//i.test(value)) {
    await shell.openExternal(value);
    return { opened: value };
  }
  const file = confine(resolvePath(value), mode);
  if (mode === "sandbox") {
    shell.showItemInFolder(file);
    return { revealed: file };
  }
  const problem = await shell.openPath(file);
  if (problem) throw new Error(problem);
  return { opened: file };
}

exports.register = (ctx) => {
  const { ipcMain, shell } = ctx;
  if (ctx.access) access = ctx.access;
  ipcMain.handle("adt:system:access", (_e, { access: mode } = {}) => {
    if (!ACCESS_MODES.has(mode)) throw new Error("Unknown access mode.");
    access.mode = mode;
    return access.mode;
  });
  ipcMain.handle("adt:system:info", () => ({
    workspace: workspaceDir(),
    platform: process.platform,
    arch: process.arch,
    home: os.homedir(),
    user: os.userInfo().username,
    hostname: os.hostname(),
    access: access.mode,
  }));
  ipcMain.handle("adt:system:exec", (_e, payload) => exec(payload ?? {}));
  ipcMain.handle("adt:system:cancel", (_e, { id } = {}) => stopCommand(String(id ?? "")));
  ctx.onStopAll?.(stopAllCommands);
  ipcMain.handle("adt:system:read", (_e, payload) => readFile(payload ?? {}));
  ipcMain.handle("adt:system:write", (_e, payload) => writeFile(payload ?? {}));
  ipcMain.handle("adt:system:list", (_e, payload) => listFiles(payload ?? {}));
  ipcMain.handle("adt:system:open", (_e, { target } = {}) => openTarget(shell, target));
  // Undo ("rewind") for bots' file changes, kept per turn in the app's data folder.
  snapshots = createSnapshots({ dir: path.join(ctx.userData ?? path.join(os.homedir(), ".adt-bot"), "rewind") });
  setTimeout(() => snapshots.prune(true), 30_000).unref?.();
  ipcMain.handle("adt:system:changes", (_e, { turn } = {}) => snapshots.changes(String(turn ?? "")));
  ipcMain.handle("adt:system:change-turns", (_e, { conversation } = {}) => snapshots.turns(String(conversation ?? "")));
  ipcMain.handle("adt:system:rewind", (_e, payload) => restoreTurn(payload ?? {}));
};

exports.stopAllCommands = stopAllCommands;
exports._test = {
  resolvePath, exec, stopCommand, stopAllCommands, workspaceDir, confine, sandboxCommand, openTarget, readFile, writeFile, listFiles, restoreTurn, MAC_PROFILE,
  /** Tests use their own snapshot store. */
  useSnapshots: (store) => (snapshots = store),
};
