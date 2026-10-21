// Routine triggers the desktop app watches: webhooks (a small server on this computer at
// http://127.0.0.1:17345/hook/<secret>) and folders (files added or changed). Events go to the app
// window, which runs the routine (src/features/automation/trigger-runner.ts).
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.ADT_WEBHOOK_PORT) || 17345;
const MAX_BODY = 64 * 1024;
const PER_MINUTE = 30;
const FOLDER_SETTLE_MS = 3000;

exports.register = ({ ipcMain, send }) => {
  /** token → routine id */
  let hooks = new Map();
  /** routine id → { path, watcher, timer, files } */
  const folders = new Map();
  let server = null;
  let listening = false;
  let serverError = "";
  const calls = new Map();

  const startServer = () => {
    if (server) return;
    server = http.createServer((req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      const match = /^\/hook\/([\w-]{20,})$/.exec(new URL(req.url, "http://x").pathname);
      const routineId = match && hooks.get(match[1]);
      if (!routineId) return reply(404, { error: "not found" });
      if (req.method !== "POST") return reply(405, { error: "use POST" });
      const now = Date.now();
      const recent = (calls.get(match[1]) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= PER_MINUTE) return reply(429, { error: "too many calls" });
      calls.set(match[1], [...recent, now]);
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reply(413, { error: "too large (64 KB max)" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (size > MAX_BODY) return;
        send("adt:triggers:event", { routineId, kind: "webhook", body: Buffer.concat(chunks).toString("utf8"), contentType: String(req.headers["content-type"] ?? "").slice(0, 100) });
        reply(202, { ok: true });
      });
    });
    server.on("error", (error) => {
      serverError = error?.code === "EADDRINUSE" ? `Port ${PORT} is in use by another program.` : String(error?.message ?? error);
      listening = false;
      server = null;
    });
    // This computer only. To call it from the internet, put a tunnel in front of it.
    server.listen(PORT, "127.0.0.1", () => {
      listening = true;
      serverError = "";
    });
  };
  const stopServer = () => {
    server?.close();
    server = null;
    listening = false;
  };

  const watchFolder = (routineId, folder) => {
    const resolved = path.resolve(String(folder));
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return `${resolved} doesn't exist.`;
    }
    if (!stat.isDirectory()) return `${resolved} isn't a folder.`;
    if (resolved === path.parse(resolved).root) return "Pick a folder, not the whole disk.";
    const entry = { path: resolved, files: new Set(), timer: null, watcher: null };
    try {
      entry.watcher = fs.watch(resolved, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? "");
        // Hidden files and editors' temporary files aren't news.
        if (!name || name.split(path.sep).some((part) => part.startsWith(".")) || /~$|\.(swp|tmp|crdownload|part)$/i.test(name)) return;
        entry.files.add(name);
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          const files = [...entry.files].slice(0, 50);
          entry.files.clear();
          send("adt:triggers:event", { routineId, kind: "folder", path: resolved, files });
        }, FOLDER_SETTLE_MS);
      });
      entry.watcher.on("error", () => undefined);
    } catch (error) {
      return String(error?.message ?? error);
    }
    folders.set(routineId, entry);
    return "";
  };
  const unwatch = (routineId) => {
    const entry = folders.get(routineId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher?.close();
    folders.delete(routineId);
  };

  ipcMain.handle("adt:triggers:set", (_event, payload) => {
    const webhooks = Array.isArray(payload?.webhooks) ? payload.webhooks : [];
    hooks = new Map(webhooks.filter((w) => /^[\w-]{20,}$/.test(String(w?.token)) && typeof w?.routineId === "string").map((w) => [w.token, w.routineId]));
    if (hooks.size) startServer();
    else stopServer();
    const wanted = new Map((Array.isArray(payload?.folders) ? payload.folders : []).filter((f) => typeof f?.routineId === "string" && typeof f?.path === "string").map((f) => [f.routineId, f.path]));
    const problems = {};
    for (const id of [...folders.keys()]) if (!wanted.has(id) || path.resolve(wanted.get(id)) !== folders.get(id).path) unwatch(id);
    for (const [id, folder] of wanted) if (!folders.has(id)) problems[id] = watchFolder(id, folder) || undefined;
    return { port: PORT, listening: hooks.size ? listening || !serverError : false, error: serverError, problems };
  });
  ipcMain.handle("adt:triggers:pick-folder", async (event) => {
    const { dialog, BrowserWindow } = require("electron");
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ["openDirectory"] });
    return result.canceled ? "" : result.filePaths[0] ?? "";
  });
};
