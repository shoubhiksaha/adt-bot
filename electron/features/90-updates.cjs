// Updates for the installed desktop app, from GitHub Releases (electron-updater). It checks once a day
// and only tells you; nothing downloads or installs until you press "Download and restart" in
// Settings → About. Every update manifest must carry ADT Bot's release signature
// (electron/update-signature.cjs), on top of electron-updater's SHA-512 check of each download.
//
// While the repository is private, GitHub needs a token to list releases. You paste one in Settings →
// About; it's kept in the OS keychain (electron/secrets.cjs) and never built into the app.
// For testing, ADT_UPDATE_FEED=<url> points the updater at a folder served over http(s) in
// electron-builder's "generic" layout (latest-mac.yml next to the files). Its manifests must be signed too.
const { Notification } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { verifyManifest } = require("../update-signature.cjs");

const OWNER = "shoubhiksaha";
const REPO = "adt-bot";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TOKEN_KEY = "githubToken";
/** Classic (ghp_…), fine-grained (github_pat_…) and app tokens. */
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

/** Why this copy can't update itself, or null when it can. */
function unsupportedReason({ packaged, platform, env, execPath, resourcesPath, exists = fs.existsSync }) {
  if (env.ADT_UPDATE_FEED) return null;
  if (!packaged) return "dev";
  if (platform === "win32" && env.PORTABLE_EXECUTABLE_DIR) return "portable";
  if (platform === "linux" && !env.APPIMAGE && !exists(path.join(resourcesPath ?? "", "package-type"))) return "linux-package";
  if (platform === "darwin" && execPath.startsWith("/Volumes/")) return "disk-image";
  if (platform === "darwin" && execPath.includes("/AppTranslocation/")) return "translocated";
  return null;
}

/** A short, plain-English reason for a failed check or download. Never includes the token. */
function explain(error, { token = "", custom = false } = {}) {
  let message = String(error?.message ?? error ?? "Unknown error");
  if (token) message = message.split(token).join("•••");
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET/.test(message)) {
    return "Couldn't reach the update server. Check your internet connection and try again.";
  }
  if (/\b401\b|Bad credentials/i.test(message)) return "GitHub didn't accept the token. Paste a new one below.";
  if (/rate limit|\b403\b/i.test(message)) return "GitHub refused the request (too many requests, or the token can't read this repository). Try again later.";
  if (/\b404\b|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_ASSET_NOT_FOUND/.test(message)) {
    if (custom) return "The update feed has nothing for this computer.";
    return token
      ? "No release for this computer was found with that token. Check that it can read the repository's contents."
      : "Couldn't read ADT Bot's releases. While the repository is private, add a GitHub token below.";
  }
  if (/sha512 checksum mismatch/i.test(message)) return "The download didn't match the signed release, so it wasn't installed.";
  if (/code ?sign|did not pass validation|designated requirement/i.test(message)) {
    return "macOS refused the update because its code signature didn't match this app's. Download the new version from the releases page instead.";
  }
  if (/EROFS|read-only/i.test(message)) return "ADT Bot can't replace itself where it is. Move it to the Applications folder and try again.";
  return message.split("\n")[0].slice(0, 300);
}

exports.register = (ctx) => {
  const { app, ipcMain, secrets, send, getWindow } = ctx;
  const prefsFile = path.join(ctx.userData, "updates.json");
  const custom = Boolean(process.env.ADT_UPDATE_FEED);
  const live = new Set();

  let prefs = { autoCheck: true, lastCheck: 0, lastAttempt: 0, notified: "" };
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile, "utf8")) };
  } catch {}
  const savePrefs = () => {
    try {
      fs.writeFileSync(prefsFile, JSON.stringify(prefs));
    } catch {}
  };

  let state = { status: "idle", version: "", percent: 0, error: "" };
  // Without a keyring the token is kept only until the app quits.
  let sessionToken = "";
  let tokenWhere = null;
  let keychain = false;
  /** The manifest that passed the signature check; downloads only ever use this exact object. */
  let verifiedInfo = null;
  let checking = null;
  let updater = null;

  const reason = () =>
    unsupportedReason({ packaged: app.isPackaged, platform: process.platform, env: process.env, execPath: process.execPath, resourcesPath: process.resourcesPath });

  const snapshot = () => ({
    appVersion: app.getVersion(),
    unsupported: reason(),
    source: custom ? "feed" : "github",
    ...state,
    checkedAt: prefs.lastCheck,
    autoCheck: prefs.autoCheck,
    token: tokenWhere,
    keychain,
  });

  const update = (patch) => {
    state = { ...state, ...patch };
    send("adt:updates:changed", snapshot());
    return snapshot();
  };

  const readToken = async () => sessionToken || (await secrets.getValue("updates", TOKEN_KEY).catch(() => ""));

  const refreshToken = async () => {
    keychain = Boolean((await secrets.status().catch(() => null))?.available);
    tokenWhere = sessionToken ? "session" : (await readToken()) ? "keychain" : null;
  };

  function getUpdater() {
    if (updater) return updater;
    const { autoUpdater } = require("electron-updater");
    // Nothing downloads on its own: the signature is checked first, and you choose when.
    autoUpdater.autoDownload = false;
    autoUpdater.allowDowngrade = false;
    let shown = -1;
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.floor(progress?.percent ?? 0);
      if (percent !== shown && state.status === "downloading") update({ percent: (shown = percent) });
    });
    // Errors also reject the promise that caused them; this keeps unhandled ones out of the console.
    autoUpdater.on("error", () => undefined);
    updater = autoUpdater;
    return updater;
  }

  async function configure(u) {
    const feed = process.env.ADT_UPDATE_FEED;
    if (feed) {
      if (!app.isPackaged) {
        // A development run has no app-update.yml, which electron-updater still reads for its download cache.
        const devConfig = path.join(ctx.userData, "dev-app-update.yml");
        fs.writeFileSync(devConfig, `provider: generic\nurl: ${JSON.stringify(feed)}\nupdaterCacheDirName: adt-bot-updater-dev\n`);
        u.updateConfigPath = devConfig;
        u.forceDevUpdateConfig = true;
      }
      u.setFeedURL({ provider: "generic", url: feed });
      return "";
    }
    const token = await readToken();
    u.setFeedURL({ provider: "github", owner: OWNER, repo: REPO, ...(token ? { token } : {}) });
    return token;
  }

  async function check() {
    if (reason()) return update({ status: "unsupported" });
    if (state.status === "downloading" || state.status === "ready") return snapshot();
    checking ??= (async () => {
      const u = getUpdater();
      update({ status: "checking", error: "" });
      prefs.lastAttempt = Date.now();
      savePrefs();
      let token = "";
      try {
        token = await configure(u);
        const result = await u.checkForUpdates();
        prefs.lastCheck = Date.now();
        savePrefs();
        if (!result?.isUpdateAvailable) {
          verifiedInfo = null;
          return update({ status: "current", version: "" });
        }
        const info = u.updateInfoAndProvider?.info ?? result.updateInfo;
        const verdict = verifyManifest(info);
        if (!verdict.ok) {
          verifiedInfo = null;
          return update({
            status: "error",
            version: "",
            error: `Version ${info?.version ?? "?"} was found, but it isn't signed with ADT Bot's release key, so it won't be installed.`,
          });
        }
        verifiedInfo = info;
        return update({ status: "available", version: String(info.version), error: "" });
      } catch (error) {
        return update({ status: "error", error: explain(error, { token, custom }) });
      }
    })().finally(() => (checking = null));
    await checking;
    return snapshot();
  }

  function restart() {
    // Silent: the Windows installer runs without its wizard. Force-run: the app reopens once installed.
    getUpdater().quitAndInstall(true, true);
  }

  async function install() {
    if (state.status === "ready") {
      restart();
      return snapshot();
    }
    if (state.status !== "available") return snapshot();
    const u = getUpdater();
    // Check the exact manifest electron-updater will download from, right before it does.
    const info = u.updateInfoAndProvider?.info;
    if (!info || info !== verifiedInfo || !verifyManifest(info).ok) {
      return update({ status: "error", error: "That update couldn't be verified. Check for updates again." });
    }
    update({ status: "downloading", percent: 0, error: "" });
    try {
      await u.downloadUpdate();
      update({ status: "ready", percent: 100 });
      setTimeout(restart, 1200);
    } catch (error) {
      update({ status: "error", error: explain(error, { token: await readToken(), custom }) });
    }
    return snapshot();
  }

  async function setToken(value) {
    const token = String(value ?? "").trim();
    if (token && !TOKEN_PATTERN.test(token)) throw new Error("That doesn't look like a GitHub token.");
    sessionToken = "";
    if (!token) await secrets.clear("updates");
    else if (!(await secrets.setValue("updates", TOKEN_KEY, token)).ok) sessionToken = token;
    await refreshToken();
    if (state.status === "error") state = { ...state, status: "idle", error: "" };
    return update({});
  }

  function showWindow() {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function notify(version) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: `ADT Bot ${version} is available`,
      body: "Open Settings → About to download it and restart. Nothing is installed until you do.",
    });
    live.add(notification);
    const release = () => live.delete(notification);
    notification.on("click", () => {
      release();
      showWindow();
      send("adt:updates:open", {});
    });
    notification.on("close", release);
    notification.show();
    setTimeout(release, 10 * 60_000).unref?.();
  }

  // Once a day (retrying after 6 hours if a check failed); only tells you, once per version.
  async function autoCheck() {
    if (!prefs.autoCheck || reason()) return;
    const now = Date.now();
    if (now - prefs.lastCheck < DAY || now - prefs.lastAttempt < 6 * HOUR) return;
    await check();
    if (state.status === "available" && prefs.notified !== state.version) {
      prefs.notified = state.version;
      savePrefs();
      notify(state.version);
    }
  }

  ipcMain.handle("adt:updates:state", async () => {
    await refreshToken();
    return snapshot();
  });
  ipcMain.handle("adt:updates:check", () => check());
  ipcMain.handle("adt:updates:install", () => install());
  ipcMain.handle("adt:updates:auto", (_event, payload) => {
    prefs.autoCheck = Boolean(payload?.enabled);
    savePrefs();
    return update({});
  });
  ipcMain.handle("adt:updates:token", (_event, payload) => setToken(payload?.token));

  app.whenReady().then(() => {
    void refreshToken();
    setTimeout(() => void autoCheck(), 60_000).unref?.();
    setInterval(() => void autoCheck(), HOUR).unref?.();
  });
};

exports._test = { unsupportedReason, explain, TOKEN_PATTERN };
