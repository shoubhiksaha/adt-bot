// Connectors: local MCP servers (stdio). This side only runs the process and moves
// newline-delimited JSON-RPC messages between it and the app; the MCP client lives in the app
// (src/lib/mcp). Servers are added by the user in Settings → Connectors.
const { spawn } = require("node:child_process");
const os = require("node:os");

const STDERR_TAIL = 4000;

/** POSIX shell quoting for one argument. */
function quote(arg) {
  const s = String(arg);
  return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** "~" and "~/path" mean the home folder, as they would in a terminal. */
const expandHome = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/**
 * Apps opened from the Finder/Dock don't get the user's shell PATH, so "npx" or "uvx" would not be
 * found. On macOS/Linux the command runs through a login shell with `exec`, so the shell is replaced
 * by the server process (signals reach it directly).
 */
function spawnArgs(command, rawArgs) {
  const args = rawArgs.map(expandHome);
  if (process.platform === "win32") return [command, args, { shell: true, windowsHide: true }];
  const shell = process.env.SHELL || "/bin/sh";
  return [shell, ["-lc", `exec ${[command, ...args].map(quote).join(" ")}`], {}];
}

/**
 * @param {{ send: (channel: string, payload: unknown) => void }} options
 */
function createManager({ send }) {
  /** @type {Map<string, { child: import("node:child_process").ChildProcess, session: number, stderr: string }>} */
  const procs = new Map();
  let nextSession = 1;

  function stop(id) {
    const entry = procs.get(id);
    if (!entry) return false;
    procs.delete(id);
    const { child } = entry;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const term = setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 1500);
    const kill = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    return true;
  }

  function start({ id, command, args = [], env = {}, cwd } = {}) {
    if (!id || !command || typeof command !== "string") throw new Error("A command is required.");
    stop(id);
    const session = nextSession++;
    const [bin, argv, extra] = spawnArgs(command.trim(), Array.isArray(args) ? args.map(String) : []);
    const child = spawn(bin, argv, {
      cwd: cwd ? expandHome(String(cwd)) : undefined,
      env: { ...process.env, ...Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, String(v)])) },
      stdio: ["pipe", "pipe", "pipe"],
      ...extra,
    });
    const entry = { child, session, stderr: "" };
    procs.set(id, entry);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // Login-shell banners or stray prints: keep them for diagnostics, don't break the protocol.
          entry.stderr = (entry.stderr + line + "\n").slice(-STDERR_TAIL);
          continue;
        }
        send("adt:mcp:message", { id, session, message });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      entry.stderr = (entry.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => undefined);
    const exited = (code, signal, error) => {
      if (procs.get(id)?.session === session) procs.delete(id);
      send("adt:mcp:exit", { id, session, code, signal, error, stderr: entry.stderr.trim() });
    };
    child.on("error", (error) => exited(null, null, String(error.message)));
    child.on("exit", (code, signal) => exited(code, signal));
    return { session, pid: child.pid };
  }

  function write({ id, session, message } = {}) {
    const entry = procs.get(id);
    if (!entry || (session && entry.session !== session)) throw new Error("The connector's process isn't running.");
    entry.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  function stopAll() {
    for (const id of [...procs.keys()]) stop(id);
  }

  return { start, write, stop, stopAll, running: () => [...procs.keys()] };
}

exports.createManager = createManager;

exports.register = ({ ipcMain, app, send }) => {
  const manager = createManager({ send });
  ipcMain.handle("adt:mcp:start", (_e, payload) => manager.start(payload ?? {}));
  ipcMain.handle("adt:mcp:send", (_e, payload) => manager.write(payload ?? {}));
  ipcMain.handle("adt:mcp:stop", (_e, { id } = {}) => manager.stop(id));
  app.on("will-quit", () => manager.stopAll());
};
