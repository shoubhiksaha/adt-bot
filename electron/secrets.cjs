// Secrets (API keys, tokens, header values, room PINs) encrypted with the operating system's keychain
// through Electron's safeStorage: the macOS Keychain, Windows DPAPI, or GNOME Keyring / KWallet on
// Linux. secrets.json in the app's data folder holds only ciphertext, one entry per store
// ("app", "connectors", "rooms", "updates"). The app window reads its stores back into memory at start-up.
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "secrets.json";
const VERSION = 1;
const MAX_ENTRIES = 2000;
const MAX_VALUE = 64 * 1024;

/** Only plain string values, within sane limits. */
function sanitize(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    if (typeof entry === "string" && entry && key.length <= 1000 && entry.length <= MAX_VALUE) out[key] = entry;
  }
  return out;
}

/**
 * @param {{ dir: string, safeStorage: Electron.SafeStorage, platform?: string }} options
 */
function createVault({ dir, safeStorage, platform = process.platform }) {
  const file = path.join(dir, FILE_NAME);
  let data = null;
  let availability = null;
  let queue = Promise.resolve();

  const read = () => {
    if (data) return data;
    data = { version: VERSION, entries: {} };
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return data;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed?.entries && typeof parsed.entries === "object") {
        for (const [ns, entry] of Object.entries(parsed.entries)) if (typeof entry === "string") data.entries[ns] = entry;
      }
    } catch {
      // Keep a damaged file aside instead of writing over something that might still be recovered.
      try {
        fs.renameSync(file, `${file}.damaged-${Date.now()}`);
      } catch {}
    }
    return data;
  };

  const write = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const backendName = () => {
    if (platform === "darwin") return "keychain";
    if (platform === "win32") return "dpapi";
    try {
      return safeStorage.getSelectedStorageBackend?.() ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  /** Whether real OS encryption is there. Linux without a keyring falls back to a fixed password, which isn't. */
  const available = () => {
    availability ??= (async () => {
      const backend = backendName();
      if (platform === "linux" && (backend === "basic_text" || backend === "unknown")) return { available: false, backend, reason: "no-keyring" };
      try {
        const ok = safeStorage.isAsyncEncryptionAvailable ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
        return ok ? { available: true, backend } : { available: false, backend, reason: "unavailable" };
      } catch {
        return { available: false, backend, reason: "unavailable" };
      }
    })();
    return availability;
  };

  // The async API never blocks the app while the OS keychain asks for permission.
  const encrypt = async (text) => (safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text));
  const decrypt = async (buffer) => {
    if (!safeStorage.decryptStringAsync) return { text: safeStorage.decryptString(buffer), reEncrypt: false };
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buffer);
    return { text: result, reEncrypt: Boolean(shouldReEncrypt) };
  };

  /** One operation at a time, in order, so an older write never lands after a newer one. */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function load(ns) {
    const state = await available();
    const entry = read().entries[ns];
    if (!entry) return { available: state.available, value: null };
    // Stored earlier but unreadable now (keyring locked or gone): report it, never overwrite it.
    if (!state.available) return { available: false, value: null, error: "locked" };
    try {
      const { text, reEncrypt } = await decrypt(Buffer.from(entry, "base64"));
      const value = sanitize(JSON.parse(text));
      if (reEncrypt) {
        data.entries[ns] = (await encrypt(text)).toString("base64");
        write();
      }
      return { available: true, value };
    } catch {
      return { available: true, value: null, error: "locked" };
    }
  }

  async function store(ns, value) {
    const state = await available();
    if (!state.available) return { ok: false, error: "unavailable" };
    const clean = sanitize(value);
    read();
    if (Object.keys(clean).length) data.entries[ns] = (await encrypt(JSON.stringify(clean))).toString("base64");
    else delete data.entries[ns];
    write();
    return { ok: true };
  }

  return {
    file,
    /** { available, backend, reason?, stored: namespaces that have something saved } */
    status: () => serial(async () => ({ ...(await available()), stored: Object.keys(read().entries) })),
    /** { available, value: map | null, error?: "locked" } */
    get: (ns) => serial(() => load(ns)),
    /** Replaces a namespace's map ({} removes it). { ok, error? } */
    set: (ns, value) => serial(() => store(ns, value)),
    clear: (ns) =>
      serial(async () => {
        read();
        if (ns in data.entries) {
          delete data.entries[ns];
          write();
        }
        return { ok: true };
      }),
    /** One value, for the main process's own secrets (the update token). */
    getValue: async (ns, key) => (await serial(() => load(ns))).value?.[key] ?? "",
    /** Sets or (with "") removes one value. Fails while the namespace can't be decrypted, so nothing is lost. */
    setValue: (ns, key, value) =>
      serial(async () => {
        const current = await load(ns);
        if (current.error) return { ok: false, error: current.error };
        const next = { ...(current.value ?? {}) };
        if (value) next[key] = String(value);
        else delete next[key];
        return store(ns, next);
      }),
  };
}

module.exports = { createVault, sanitize, FILE_NAME };
