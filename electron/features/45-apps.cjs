// App connectors on desktop: Google (Gmail, Calendar, Drive), Microsoft (Outlook, OneDrive), any
// email account (IMAP/SMTP), Slack and X. The app window asks for operations by name ("mail.search");
// sign-ins, tokens and passwords stay here (electron/apps/accounts.cjs).
const { createAccounts } = require("../apps/accounts.cjs");
const { createCalendar } = require("../apps/calendar.cjs");
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

exports.register = ({ ipcMain, shell, userData, secrets }) => {
  const accounts = createAccounts({
    dir: userData,
    vault: secrets,
    endpoints: testEndpoints(),
    // Only the services' own sign-in pages open in the browser.
    openExternal: (url) => {
      if (!/^https?:\/\//.test(url)) throw new Error("Not a sign-in page.");
      return shell.openExternal(url);
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
