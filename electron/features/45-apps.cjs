// App connectors on desktop: Google (Gmail, Calendar, Drive), Microsoft (Outlook, OneDrive), any
// email account (IMAP/SMTP), Slack and X. The app window asks for operations by name ("mail.search");
// sign-ins, tokens and passwords stay here (electron/apps/accounts.cjs).
const { createAccounts } = require("../apps/accounts.cjs");
const { createCalendar } = require("../apps/calendar.cjs");
const { discoverMail } = require("../apps/discover.cjs");
const { createMail } = require("../apps/mail.cjs");
const { createSocial } = require("../apps/social.cjs");

/** Service addresses pointed elsewhere, for the end-to-end tests' fake Google, Microsoft, Slack and X. */
function testEndpoints() {
  try {
    const value = JSON.parse(process.env.ADT_APPS_TEST_ENDPOINTS || "{}");
    return Object.fromEntries(Object.entries(value).filter(([from, to]) => /^https:\/\//.test(from) && /^http:\/\/127\.0\.0\.1:\d+$/.test(to)));
  } catch {
    return {};
  }
}

/**
 * The app registrations this copy was built with, for one-click "Sign in with Google/Microsoft": set
 * by whoever builds the app (package.json adtbot.signIn, or ADT_GOOGLE_CLIENT_ID,
 * ADT_GOOGLE_CLIENT_SECRET and ADT_MICROSOFT_CLIENT_ID). A desktop app's client secret isn't secret
 * (Google says so for installed apps); PKCE protects the sign-in. Empty: users bring their own.
 */
function builtInSignIn() {
  const config = require("../../package.json").adtbot?.signIn ?? {};
  const pick = (env, value) => String(process.env[env] || value || "").trim();
  return {
    google: { clientId: pick("ADT_GOOGLE_CLIENT_ID", config.google?.clientId), clientSecret: pick("ADT_GOOGLE_CLIENT_SECRET", config.google?.clientSecret) },
    microsoft: { clientId: pick("ADT_MICROSOFT_CLIENT_ID", config.microsoft?.clientId) },
  };
}

/**
 * End-to-end tests only (ADT_APPS_TEST_BROWSER, with the fake services above): instead of opening
 * the browser, follow the fake sign-in page's redirect back to the app, and note the address.
 */
function testBrowser(endpoints) {
  const log = process.env.ADT_APPS_TEST_BROWSER;
  if (!log || !Object.keys(endpoints).length) return null;
  return async (url) => {
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error("Not a test sign-in page.");
    require("node:fs").appendFileSync(log, `${url}\n`);
    await fetch(url, { redirect: "follow" });
  };
}

exports.register = ({ ipcMain, shell, userData, secrets }) => {
  const endpoints = testEndpoints();
  const simulated = testBrowser(endpoints);
  const accounts = createAccounts({
    dir: userData,
    vault: secrets,
    endpoints,
    builtIn: builtInSignIn(),
    // Only the services' own sign-in pages open in the browser.
    openExternal: (url) => {
      if (!/^https?:\/\//.test(url)) throw new Error("Not a sign-in page.");
      return simulated ? simulated(url) : shell.openExternal(url);
    },
  });
  const mail = createMail({ accounts });
  const calendar = createCalendar({ accounts });
  const social = createSocial({ accounts });

  const OPS = {
    "mail.search": mail.search,
    "mail.read": mail.read,
    "mail.draft": mail.draft,
    "mail.send": mail.send,
    "mail.arrivals": mail.arrivals,
    "mail.sentByMe": mail.sentByMe,
    "calendar.events": calendar.events,
    "calendar.create": calendar.createEvent,
    "drive.search": calendar.searchFiles,
    "drive.read": calendar.readFile,
    "drive.create": calendar.createFile,
    "slack.channels": social.slackChannels,
    "slack.read": social.slackRead,
    "slack.post": social.slackPost,
    "x.search": social.xSearch,
    "x.mentions": social.xMentions,
    "x.post": social.xPost,
    "x.messages": social.xMessages,
    "x.send": social.xSendMessage,
  };

  ipcMain.handle("adt:apps:list", () => accounts.list());
  ipcMain.handle("adt:apps:connect", (_event, payload) => accounts.connectOAuth(payload ?? {}));
  ipcMain.handle("adt:apps:sign-in-options", () => accounts.builtInSignIn());
  ipcMain.handle("adt:apps:reconnect", (_event, payload) => accounts.reconnect({ id: String(payload?.id ?? "") }));
  ipcMain.handle("adt:apps:detect-email", (_event, payload) => discoverMail(String(payload?.address ?? "")));
  ipcMain.handle("adt:apps:connect-token", (_event, payload) => accounts.connectToken(payload ?? {}));
  ipcMain.handle("adt:apps:connect-email", (_event, payload) => accounts.connectImap(payload ?? {}, mail.check));
  ipcMain.handle("adt:apps:remove", (_event, payload) => accounts.remove(String(payload?.id ?? "")));
  ipcMain.handle("adt:apps:call", async (_event, payload) => {
    const op = OPS[String(payload?.op ?? "")];
    if (!op) throw new Error("Unknown app operation.");
    const params = payload?.params && typeof payload.params === "object" ? payload.params : {};
    return op(params);
  });
};
