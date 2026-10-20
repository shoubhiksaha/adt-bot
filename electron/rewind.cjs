// Undo for bots' file changes ("rewind"). Before write_file changes a file, and around a command
// run in the ADT Bot Workspace, the previous versions are kept here per turn (the assistant reply
// that made the change), for 7 days and up to a size cap. Undoing a turn puts those files back and
// deletes the files it created, but never overwrites a file someone changed after the bot did
// unless asked to (the hash it had right after the bot's change no longer matches).
//
// Layout: <dir>/<turn>/manifest.json, plus <dir>/<turn>/<sha256> for each kept version.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DAY = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  /** How long a turn's versions are kept. */
  maxAgeMs: 7 * DAY,
  /** All kept versions together; the oldest turns go first. */
  maxBytes: 1024 * 1024 * 1024,
  /** Bigger files aren't kept (their change is listed, but can't be undone). */
  maxFileBytes: 50 * 1024 * 1024,
  /** Workspace snapshots around commands: skipped for bigger workspaces, so a command never waits long. */
  maxScanFiles: 2000,
  maxScanBytes: 100 * 1024 * 1024,
};
/** Folders a workspace snapshot leaves out: rebuilt by tools, or huge (dependencies, git, the sandbox's home and temp). */
const SKIP_DIRS = new Set(["node_modules", ".git", ".sandbox-home", ".sandbox-tmp"]);

const validTurn = (turn) => typeof turn === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(turn);
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function isInside(dir, file) {
  return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** Plain file access (follows symlinks, like write_file does). Sandbox mode passes its own. */
const plainIo = {
  /** The file's bytes, or null when there's no file. */
  read(file) {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
  },
  write(file, buffer, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    if (mode) fs.chmodSync(file, mode & 0o777);
  },
  remove(file) {
    fs.rmSync(file, { force: true });
  },
};

/**
 * @param {{ dir: string, maxAgeMs?: number, maxBytes?: number, maxFileBytes?: number, maxScanFiles?: number, maxScanBytes?: number, now?: () => number }} options
 */
function createSnapshots(options) {
  const { dir, now = Date.now } = options;
  const limits = { ...DEFAULTS, ...options };
  let prunedAt = 0;

  const turnDir = (turn) => path.join(dir, turn);
  const manifestPath = (turn) => path.join(turnDir(turn), "manifest.json");

  function load(turn) {
    if (!validTurn(turn)) return null;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath(turn), "utf8"));
      return m && typeof m === "object" && m.files && typeof m.files === "object" ? m : null;
    } catch {
      return null;
    }
  }

  function save(turn, manifest) {
    fs.mkdirSync(turnDir(turn), { recursive: true });
    const tmp = `${manifestPath(turn)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    fs.renameSync(tmp, manifestPath(turn));
  }

  function drop(turn) {
    fs.rmSync(turnDir(turn), { recursive: true, force: true });
    used = null;
  }

  /** A file's state, to tell later whether someone changed it: its hash (or size and time when it's huge), or null when it doesn't exist. */
  function fingerprint(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return `other:${st.mode}`;
    if (st.size > limits.maxFileBytes) return `big:${st.size}:${Math.round(st.mtimeMs)}`;
    try {
      return sha(fs.readFileSync(file));
    } catch {
      return `unreadable:${st.size}:${Math.round(st.mtimeMs)}`;
    }
  }

  function turnBytes(manifest) {
    return Object.values(manifest.files).reduce((n, f) => n + (f.blob ? f.size : 0), 0);
  }

  /** Kept turns, oldest first; turns past the time limit are dropped on the way. */
  function liveTurns() {
    let names;
    try {
      names = fs.readdirSync(dir).filter(validTurn);
    } catch {
      return [];
    }
    const turns = [];
    for (const name of names) {
      const m = load(name);
      if (!m || now() - (m.updatedAt ?? 0) > limits.maxAgeMs) drop(name);
      else turns.push({ name, at: m.updatedAt ?? 0, bytes: turnBytes(m) });
    }
    return turns.sort((a, b) => a.at - b.at);
  }

  /** Drops turns older than the time limit, then the oldest ones while everything kept is over the size cap. */
  function prune(force = false) {
    if (!force && now() - prunedAt < 60_000) return;
    prunedAt = now();
    liveTurns();
    makeRoom(0);
  }

  /** Drops the oldest turns (never `keep`) until `bytes` more fit under the size cap. */
  function makeRoom(bytes, keep) {
    if (usedBytes() + bytes <= limits.maxBytes) return true;
    const turns = liveTurns().filter((t) => t.name !== keep);
    let total = usedBytes();
    while (total + bytes > limits.maxBytes && turns.length) {
      const oldest = turns.shift();
      drop(oldest.name);
      total -= oldest.bytes;
    }
    return total + bytes <= limits.maxBytes;
  }

  /** Bytes kept by all turns: counted once, then kept up to date (recounted after anything is dropped). */
  let used = null;
  function usedBytes() {
    if (used === null) {
      used = 0;
      try {
        for (const name of fs.readdirSync(dir).filter(validTurn)) {
          const m = load(name);
          if (m) used += turnBytes(m);
        }
      } catch {}
    }
    return used;
  }

  /**
   * Records one file's change in a turn. `before` is what the file held before the bot changed it:
   * { existed: false } for a new file, or { existed: true, data?: Buffer, size, mode } (no data when
   * it was too big to keep). The first version in a turn is the one undo goes back to.
   */
  function record(turn, file, before, { conversation, tool } = {}) {
    if (!validTurn(turn)) return;
    prune();
    const manifest = load(turn) ?? { turn, conversation: String(conversation ?? ""), createdAt: now(), updatedAt: now(), files: {} };
    const key = path.resolve(file);
    let entry = manifest.files[key];
    if (!entry) {
      entry = { existed: Boolean(before.existed), size: before.size ?? 0, mode: before.mode ?? 0, tool: tool ?? "", at: now() };
      if (before.existed && before.data) {
        const hash = sha(before.data);
        // Older turns make way for it; when it can't fit even then, the change is listed but this version isn't kept.
        const fits = before.data.length <= limits.maxFileBytes && makeRoom(before.data.length, turn);
        if (fits) {
          const blob = path.join(turnDir(turn), hash);
          fs.mkdirSync(turnDir(turn), { recursive: true });
          if (!fs.existsSync(blob)) fs.writeFileSync(blob, before.data);
          entry.blob = hash;
          entry.size = before.data.length;
          used = usedBytes() + entry.size;
        }
        entry.before = hash;
      }
      manifest.files[key] = entry;
    }
    entry.after = fingerprint(key);
    manifest.updatedAt = now();
    save(turn, manifest);
  }

  /** What a file held before a change, for record(). `io.read` returns its bytes or null when there's none. */
  async function capture(file, io = plainIo) {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {}
    if (!st) return { existed: false };
    if (!st.isFile()) return { existed: true, size: st.size, mode: st.mode };
    if (st.size > limits.maxFileBytes) return { existed: true, size: st.size, mode: st.mode };
    const data = await io.read(file);
    return data ? { existed: true, data, size: data.length, mode: st.mode } : { existed: false };
  }

  /** The turn's changes that undo would act on, each with whether someone changed it since and whether it can be put back. */
  function changes(turn) {
    const manifest = load(turn);
    if (!manifest) return { turn, conversation: "", at: 0, files: [] };
    const files = Object.entries(manifest.files)
      .filter(([, f]) => !(f.existed && f.before && f.before === f.after))
      .map(([file, f]) => {
        const current = fingerprint(file);
        return {
          path: file,
          change: !f.existed ? "created" : f.after === null ? "deleted" : "modified",
          changedSince: current !== f.after,
          restorable: !f.existed || Boolean(f.blob),
          tool: f.tool,
        };
      });
    return { turn, conversation: manifest.conversation, at: manifest.updatedAt, files };
  }

  /** Turns of a conversation with file changes, newest first. */
  function turns(conversation) {
    prune();
    let names = [];
    try {
      names = fs.readdirSync(dir).filter(validTurn);
    } catch {}
    return names
      .map(load)
      .filter((m) => m && m.conversation === String(conversation ?? ""))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => changes(m.turn))
      .filter((t) => t.files.length);
  }

  /**
   * Undoes a turn: restores changed and deleted files, deletes created ones. Files changed since the
   * bot changed them are skipped unless `force`. `allow(file)` can refuse a path (e.g. outside the
   * workspace in Sandbox mode); `io` writes and removes (Sandbox mode passes confined ones).
   */
  async function restore(turn, { force = false, io = plainIo, allow = () => true } = {}) {
    const manifest = load(turn);
    const result = { restored: [], removed: [], conflicts: [], refused: [], unsaved: [], failed: [] };
    if (!manifest) return result;
    for (const [file, f] of Object.entries(manifest.files)) {
      if (f.existed && f.before && f.before === f.after) {
        delete manifest.files[file];
        continue;
      }
      if (!allow(file)) {
        result.refused.push(file);
        continue;
      }
      if (f.existed && !f.blob) {
        result.unsaved.push(file);
        continue;
      }
      const current = fingerprint(file);
      if (current !== f.after && !force) {
        result.conflicts.push(file);
        continue;
      }
      try {
        if (!f.existed) {
          if (current !== null) await io.remove(file);
          result.removed.push(file);
        } else {
          const data = fs.readFileSync(path.join(turnDir(turn), f.blob));
          await io.write(file, data, f.mode);
          result.restored.push(file);
        }
      } catch (error) {
        // Stays listed, so it can be tried again.
        result.failed.push(`${file} (${String(error.message ?? error).split("\n")[0]})`);
        continue;
      }
      delete manifest.files[file];
    }
    // What's left (conflicts, refused or too big) stays undoable; a turn with nothing left goes.
    const left = Object.values(manifest.files).filter((f) => f.existed ? Boolean(f.blob) : true);
    if (!left.length) drop(turn);
    else {
      const blobs = new Set(Object.values(manifest.files).map((f) => f.blob).filter(Boolean));
      for (const name of fs.readdirSync(turnDir(turn))) if (/^[0-9a-f]{64}$/.test(name) && !blobs.has(name)) fs.rmSync(path.join(turnDir(turn), name), { force: true });
      save(turn, manifest);
      used = null;
    }
    return result;
  }

  // Workspace snapshots around commands ------------------------------------------------------

  /** Regular files under root (no symlinks, skipping SKIP_DIRS), or null when there are too many or too much. */
  function scan(root) {
    const files = new Map();
    let bytes = 0;
    const walk = (folder) => {
      let entries;
      try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
      } catch {
        return true;
      }
      for (const e of entries) {
        const full = path.join(folder, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          if (!walk(full)) return false;
        } else if (e.isFile()) {
          let st;
          try {
            st = fs.lstatSync(full);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          // Only what gets copied counts (huge files are just compared).
          if (st.size <= limits.maxFileBytes) bytes += st.size;
          files.set(full, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, mode: st.mode });
          if (files.size > limits.maxScanFiles || bytes > limits.maxScanBytes) return false;
        }
      }
      return true;
    };
    return walk(root) ? files : null;
  }

  /**
   * Copies a workspace file for a snapshot, making sure it really is the regular file inside the
   * workspace that the scan saw: a command could swap a folder for a symlink to somewhere else
   * meanwhile, and undo would then write that file's contents into the workspace.
   */
  function copyChecked(file, to, root, seen, clone) {
    if (clone) {
      // Fast path (APFS: no data is copied), checked on both sides of the copy.
      const check = () => {
        const st = fs.lstatSync(file);
        return st.isFile() && st.ino === seen.ino && isInside(root, fs.realpathSync.native(path.dirname(file)));
      };
      if (!check()) return false;
      fs.copyFileSync(file, to, fs.constants.COPYFILE_FICLONE);
      return check();
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.ino !== seen.ino) return false;
      if (!isInside(root, fs.realpathSync.native(path.dirname(file)))) return false;
      const again = fs.lstatSync(file);
      if (again.ino !== st.ino || again.dev !== st.dev) return false;
      fs.writeFileSync(to, fs.readFileSync(fd));
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Before a command: keeps a copy of the workspace's files (APFS clones outside Sandbox mode, so
   * it's quick and takes no space until a file changes). Returns a token for afterCommand, or
   * { skipped } when the workspace is too big to snapshot quickly.
   */
  function beforeCommand(turn, root, { conversation, confined = false } = {}) {
    if (!validTurn(turn)) return null;
    prune();
    const realRoot = fs.realpathSync(root);
    const files = scan(realRoot);
    if (!files) return { skipped: `the workspace has more than ${limits.maxScanFiles} files or ${Math.round(limits.maxScanBytes / 1024 / 1024)} MB` };
    const staging = path.join(dir, `.staging-${turn}-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    const kept = new Map();
    let n = 0;
    for (const [file, seen] of files) {
      // Files too big to keep are only compared (their change is listed but can't be undone).
      if (seen.size > limits.maxFileBytes) {
        kept.set(file, seen);
        continue;
      }
      const to = path.join(staging, String(n++));
      try {
        if (copyChecked(file, to, realRoot, seen, !confined)) kept.set(file, { ...seen, copy: to });
      } catch {}
    }
    return { turn, root: realRoot, staging, seen: files, kept, conversation };
  }

  /** After a command: records what it changed, created and deleted in the workspace, then drops the rest of the snapshot. */
  function afterCommand(token, { tool = "run_command" } = {}) {
    if (!token || token.skipped || token.done) return { changed: 0 };
    token.done = true;
    let changed = 0;
    try {
      // Past the scan limits now (e.g. the command installed packages): compare the files seen before.
      const later = scan(token.root) ?? scanKnown(token.seen);
      const meta = { conversation: token.conversation, tool };
      for (const [file, seen] of token.kept) {
        const current = later.get(file);
        if (current && current.size === seen.size && current.mtimeMs === seen.mtimeMs && current.ino === seen.ino) continue;
        if (seen.size > limits.maxFileBytes) {
          record(token.turn, file, { existed: true, size: seen.size, mode: seen.mode }, meta);
        } else {
          const data = fs.readFileSync(seen.copy);
          if (current && fingerprint(file) === sha(data)) continue;
          record(token.turn, file, { existed: true, data, size: data.length, mode: seen.mode }, meta);
        }
        changed++;
      }
      for (const file of later.keys()) {
        if (token.seen.has(file)) continue;
        record(token.turn, file, { existed: false }, meta);
        changed++;
      }
    } finally {
      fs.rmSync(token.staging, { recursive: true, force: true });
    }
    return { changed };
  }

  /** The current state of files a scan saw before (those that still exist). */
  function scanKnown(seen) {
    const out = new Map();
    for (const file of seen.keys()) {
      try {
        const st = fs.lstatSync(file);
        if (st.isFile()) out.set(file, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, mode: st.mode });
      } catch {}
    }
    return out;
  }

  return { record, capture, changes, turns, restore, prune, beforeCommand, afterCommand, fingerprint, limits };
}

module.exports = { createSnapshots, validTurn, plainIo, SKIP_DIRS };
