// @vitest-environment node
// App connectors against stand-ins for Google, Microsoft, Slack and X (local HTTP servers that answer
// like the real APIs) and a real IMAP/SMTP server on localhost: signing in with PKCE, tokens that
// never go anywhere but the service, refreshing, and every mail, calendar, file, Slack and X operation.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createAccounts } = require("./accounts.cjs");
const { createMail, gmailQuery, outlookSearch } = require("./mail.cjs");
const { createCalendar } = require("./calendar.cjs");
const { createSocial } = require("./social.cjs");
const { addresses } = require("./common.cjs");

/** A fake service: routes by "METHOD /path" (prefix match on the longest key); records requests. */
function fakeService(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw });
      const key = Object.keys(routes)
        .filter((k) => {
          const [m, p] = k.split(" ");
          return m === req.method && url.pathname.startsWith(p);
        })
        .sort((a, b) => b.length - a.length)[0];
      if (!key) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
        return;
      }
      const out = routes[key]({ url, body: raw, headers: req.headers, method: req.method });
      const { status = 200, json, text, headers = {} } = out ?? {};
      res.writeHead(status, { "content-type": json !== undefined ? "application/json" : "text/plain", ...headers });
      res.end(json !== undefined ? JSON.stringify(json) : (text ?? ""));
    });
  });
  return {
    seen,
    server,
    start: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`))),
  };
}

const memoryVault = () => {
  const store = new Map();
  return { getValue: async (ns, key) => store.get(`${ns}/${key}`) ?? "", setValue: async (ns, key, value) => (value ? store.set(`${ns}/${key}`, value) : store.delete(`${ns}/${key}`), { ok: true }), store };
};

/** Plays the browser: follows the sign-in page straight back to the app's loopback address. */
const browser = (code = "the-code") => async (url) => {
  const auth = new URL(url);
  const back = new URL(auth.searchParams.get("redirect_uri"));
  back.searchParams.set("code", code);
  back.searchParams.set("state", auth.searchParams.get("state"));
  browser.last = auth;
  // "localhost" redirect: reach it over IPv4 like most browsers would.
  back.hostname = "127.0.0.1";
  const res = await fetch(back);
  browser.page = await res.text();
};

const RAW = (subject, from = "Alice <alice@example.com>", to = "me@example.com") =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Tue, 21 Oct 2026 10:00:00 +0000\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\n\r\nHello from ${subject}.\r\n`;

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adt-apps-"));
});

describe("Google", () => {
  const tokens = { issued: 0, refreshed: 0 };
  let expiresIn = 3600;
  const drafts = [];
  const sent = [];
  const events = [];
  const google = fakeService({
    "POST /token": ({ body }) => {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "the-code" || !p.get("code_verifier") || p.get("client_secret") !== "s3cret") return { status: 400, json: { error: "invalid_grant" } };
        tokens.issued++;
        return { json: { access_token: `at-${tokens.issued}`, refresh_token: "rt-1", expires_in: expiresIn } };
      }
      tokens.refreshed++;
      return { json: { access_token: `at-r${tokens.refreshed}`, expires_in: 3600 } };
    },
    "GET /oauth2/v3/userinfo": () => ({ json: { email: "me@gmail.com" } }),
    "GET /gmail/v1/users/me/messages/": ({ url }) => {
      const id = url.pathname.split("/").pop();
      if (url.searchParams.get("format") === "raw") {
        const from = id === "spoof" ? '"attacker@evil.example, Bob" <bob@co.example>' : undefined;
        return { json: { id, threadId: "t1", labelIds: ["UNREAD"], raw: Buffer.from(RAW(`Message ${id}`, from)).toString("base64url") } };
      }
      if (id === "selfsent") return { json: { id, labelIds: ["INBOX", "SENT"], payload: { headers: [{ name: "Message-ID", value: "<self@gmail.com>" }] } } };
      return { json: { id, threadId: "t1", internalDate: "1792576800000", snippet: "Hi &amp; bye", labelIds: ["INBOX", "UNREAD"], payload: { headers: [{ name: "From", value: "Alice <alice@example.com>" }, { name: "Subject", value: `Message ${id}` }, { name: "To", value: "me@gmail.com" }] } } };
    },
    "GET /gmail/v1/users/me/messages": () => ({ json: { messages: [{ id: "m1" }, { id: "m2" }] } }),
    "POST /gmail/v1/users/me/drafts": ({ body }) => (drafts.push(JSON.parse(body)), { json: { id: "d1" } }),
    "POST /gmail/v1/users/me/messages/send": ({ body }) => (sent.push(JSON.parse(body)), { json: { id: "s1" } }),
    "GET /gmail/v1/users/me/profile": () => ({ json: { historyId: "100" } }),
    "GET /gmail/v1/users/me/history": ({ url }) => (url.searchParams.get("startHistoryId") === "100" ? { json: { historyId: "105", history: [{ messagesAdded: [{ message: { id: "m3" } }] }] } } : { status: 404, json: { error: { message: "gone" } } }),
    "GET /calendar/v3/calendars/primary/events": () => ({ json: { items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-10-22T09:00:00Z" }, end: { dateTime: "2026-10-22T09:15:00Z" }, attendees: [{ email: "bob@example.com" }] }] } }),
    "POST /calendar/v3/calendars/primary/events": ({ body, url }) => (events.push({ body: JSON.parse(body), notify: url.searchParams.get("sendUpdates") }), { json: { id: "e2", htmlLink: "https://cal/e2" } }),
    "GET /drive/v3/files/doc1/export": () => ({ text: "The plan: ship it." }),
    "GET /drive/v3/files/pdf1": ({ url }) => (url.searchParams.get("alt") === "media" ? { text: "%PDF-1.7 fake", headers: { "content-type": "application/pdf" } } : { json: { id: "pdf1", name: "Report.pdf", mimeType: "application/pdf" } }),
    "GET /drive/v3/files/doc1": () => ({ json: { id: "doc1", name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs/doc1" } }),
    "GET /drive/v3/files": ({ url }) => ({ json: { files: [{ id: "doc1", name: "Plan", mimeType: "application/vnd.google-apps.document", q: url.searchParams.get("q") }] } }),
    "POST /upload/drive/v3/files": ({ body, headers }) => ({ json: { id: "new1", name: /"name":"([^"]+)"/.exec(body)[1], webViewLink: "https://docs/new1", type: headers["content-type"] } }),
  });
  let base;
  let accounts;
  let id;
  beforeAll(async () => {
    base = await google.start();
  });
  afterAll(() => google.server.close());
  const make = () =>
    createAccounts({
      dir,
      vault: memoryVault(),
      openExternal: browser(),
      endpoints: { "https://accounts.google.com": base, "https://oauth2.googleapis.com": base, "https://gmail.googleapis.com": base, "https://www.googleapis.com": base },
    });

  it("signs in with PKCE in the browser and keeps the tokens out of the account list", async () => {
    accounts = make();
    const account = await accounts.connectOAuth({ provider: "google", clientId: "cid.apps.googleusercontent.com", clientSecret: "s3cret", services: ["mail", "calendar", "drive"] });
    id = account.id;
    expect(account).toMatchObject({ provider: "google", label: "me@gmail.com", services: ["mail", "calendar", "drive"] });
    expect(browser.last.searchParams.get("code_challenge_method")).toBe("S256");
    expect(browser.last.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(browser.last.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(browser.last.searchParams.get("access_type")).toBe("offline");
    expect(browser.page).toMatch(/Connected/);
    expect(JSON.stringify(accounts.list())).not.toMatch(/at-1|rt-1|s3cret/);
    expect(fs.readFileSync(path.join(dir, "apps.json"), "utf8")).not.toMatch(/at-1|rt-1|s3cret/);
    // Only the service's own API gets the token.
    await expect(accounts.api(id, "GET", "https://evil.example/steal")).rejects.toThrow(/isn't part of this service's API/);
    await expect(accounts.api(id, "GET", "https://user:pw@www.googleapis.com/x")).rejects.toThrow(/isn't part/);
  });

  it("refuses a sign-in answer that doesn't match the one it started", async () => {
    const accountsBad = createAccounts({
      dir,
      vault: memoryVault(),
      endpoints: { "https://accounts.google.com": base, "https://oauth2.googleapis.com": base },
      openExternal: async (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri"));
        back.searchParams.set("code", "the-code");
        back.searchParams.set("state", "forged");
        expect(await (await fetch(back)).text()).toMatch(/doesn't match/);
        back.searchParams.set("state", new URL(url).searchParams.get("state"));
        back.searchParams.delete("code");
        back.searchParams.set("error", "access_denied");
        await fetch(back);
      },
    });
    await expect(accountsBad.connectOAuth({ provider: "google", clientId: "c", clientSecret: "s3cret", services: ["mail"] })).rejects.toThrow(/cancelled/);
    expect(accountsBad.list()).toEqual([]);
  });

  it("searches, reads, drafts and sends Gmail; finds new mail since last time", async () => {
    const mail = createMail({ accounts });
    expect(gmailQuery({ query: "invoice", from: "bob", unread: true })).toBe("invoice from:(bob) is:unread");
    const found = await mail.search({ account: id, query: "invoice", limit: 5 });
    expect(found.map((m) => m.subject)).toEqual(["Message m1", "Message m2"]);
    expect(found[0]).toMatchObject({ from: "Alice <alice@example.com>", snippet: "Hi & bye", unread: true });
    const full = await mail.read({ account: id, id: "m1" });
    expect(full).toMatchObject({ subject: "Message m1", from: "Alice <alice@example.com>", text: "Hello from Message m1." });
    await mail.draft({ account: id, reply_to: "m1", body: "Thanks!" });
    const draftRaw = Buffer.from(drafts[0].message.raw, "base64url").toString();
    expect(draftRaw).toMatch(/^To: alice@example\.com$/m);
    expect(draftRaw).toMatch(/^Subject: Re: Message m1/m);
    expect(draftRaw).toMatch(/^In-Reply-To: </m);
    expect(drafts[0].message.threadId).toBe("t1");
    // A display name that looks like addresses doesn't add a hidden recipient.
    await mail.draft({ account: id, reply_to: "spoof", body: "Thanks!" });
    const spoofed = Buffer.from(drafts[1].message.raw, "base64url").toString();
    expect(spoofed).toMatch(/^To: bob@co\.example$/m);
    expect(spoofed).not.toMatch(/evil/);
    await mail.send({ account: id, to: "bob@example.com", subject: "Hi", body: "Lunch?" });
    expect(Buffer.from(sent[0].raw, "base64url").toString()).toMatch(/^Subject: Hi/m);
    await expect(mail.send({ account: id, to: "not an address", subject: "x", body: "y" })).rejects.toThrow(/isn't an email address/);
    const first = await mail.arrivals({ account: id });
    expect(first).toEqual({ cursor: "100", messages: [] });
    const next = await mail.arrivals({ account: id, cursor: "100" });
    expect(next.cursor).toBe("105");
    expect(next.messages.map((m) => m.id)).toEqual(["m3"]);
    // A cursor Gmail has forgotten starts over.
    expect(await mail.arrivals({ account: id, cursor: "1" })).toEqual({ cursor: "100", messages: [] });
    // Mail you sent your bot carries Gmail's SENT label; mail from outside doesn't.
    expect(await mail.sentByMe({ account: id, id: "selfsent", to: "me+adt@gmail.com" })).toEqual({ sent: true, copy: "selfsent", messageId: "<self@gmail.com>" });
    expect(await mail.sentByMe({ account: id, id: "m1", to: "me+adt@gmail.com" })).toEqual({ sent: false });
  });

  it("lists and creates calendar events (no invitations unless asked)", async () => {
    const cal = createCalendar({ accounts });
    const list = await cal.events({ account: id, from: "2026-10-22T00:00:00Z", to: "2026-10-23T00:00:00Z" });
    expect(list[0]).toMatchObject({ title: "Standup", attendees: ["bob@example.com"] });
    await cal.createEvent({ account: id, title: "Lunch", start: "2026-10-23T12:00:00+05:30", attendees: "bob@example.com" });
    expect(events[0].notify).toBe("none");
    expect(events[0].body).toMatchObject({ summary: "Lunch", start: { dateTime: "2026-10-23T06:30:00.000Z" }, end: { dateTime: "2026-10-23T07:30:00.000Z" } });
    await expect(cal.createEvent({ account: id, title: "x", start: "tomorrow-ish" })).rejects.toThrow(/isn't a date/);
  });

  it("searches, reads (text or bytes) and creates Drive files", async () => {
    const drive = createCalendar({ accounts });
    const files = await drive.searchFiles({ account: id, query: "it's plan" });
    expect(files[0]).toMatchObject({ id: "doc1", name: "Plan" });
    expect(google.seen.find((r) => r.path === "/drive/v3/files").query.q).toBe("(name contains 'it\\'s plan' or fullText contains 'it\\'s plan') and trashed = false");
    expect(await drive.readFile({ account: id, id: "doc1" })).toMatchObject({ name: "Plan", text: "The plan: ship it." });
    expect(await drive.readFile({ account: id, id: "pdf1" })).toMatchObject({ name: "Report.pdf", base64: Buffer.from("%PDF-1.7 fake").toString("base64") });
    expect(await drive.createFile({ account: id, name: "Notes", content: "hello" })).toMatchObject({ id: "new1", name: "Notes" });
  });

  it("refreshes an expired token, and sends only the token to the service", async () => {
    expiresIn = 1;
    const vault = memoryVault();
    const fresh = createAccounts({ dir, vault, openExternal: browser(), endpoints: { "https://accounts.google.com": base, "https://oauth2.googleapis.com": base, "https://www.googleapis.com": base } });
    const before = tokens.refreshed;
    // The 1-second token is already stale when the profile is read: refreshed once, then reused.
    const account = await fresh.connectOAuth({ provider: "google", clientId: "c", clientSecret: "s3cret", services: ["calendar"] });
    await createCalendar({ accounts: fresh }).events({ account: account.id });
    expect(tokens.refreshed).toBe(before + 1);
    expect(google.seen.at(-1).headers.authorization).toBe(`Bearer at-r${tokens.refreshed}`);
    // An account connected without mail can't be used for mail.
    await expect(createMail({ accounts: fresh }).search({ account: account.id })).rejects.toThrow(/isn't connected for email/);
    expiresIn = 3600;
  });
});

describe("Microsoft", () => {
  const sentMail = [];
  const patched = [];
  const repliesSent = [];
  const ms = fakeService({
    "POST /common/oauth2/v2.0/token": ({ body }) => (new URLSearchParams(body).get("client_secret") ? { status: 400, json: { error: "public client" } } : { json: { access_token: "ms-at", refresh_token: "ms-rt", expires_in: 3600 } }),
    "GET /v1.0/me/mailFolders/inbox/messages": ({ url }) => ({
      json: { value: [{ id: "o1", conversationId: "c1", subject: "Invoice", from: { emailAddress: { name: "Shop", address: "shop@example.com" } }, toRecipients: [], receivedDateTime: "2026-10-21T10:00:00Z", bodyPreview: "Total 10", isRead: false, filter: url.searchParams.get("$filter") }] },
    }),
    "GET /v1.0/me/messages/o1/$value": () => ({ text: RAW("Invoice", "Shop <shop@example.com>") }),
    "GET /v1.0/me/messages": ({ url }) => ({ json: { value: [], search: url.searchParams.get("$search") } }),
    "POST /v1.0/me/sendMail": ({ body }) => (sentMail.push(JSON.parse(body)), { status: 202, text: "" }),
    "GET /v1.0/me/calendarView": () => ({ json: { value: [{ id: "ev", subject: "Review", start: { dateTime: "2026-10-22T09:00:00.0000000" }, end: { dateTime: "2026-10-22T10:00:00.0000000" }, attendees: [] }] } }),
    "GET /v1.0/me/drive/items/f1/content": () => ({ status: 302, headers: { location: "/download/f1" } }),
    "GET /download/f1": ({ headers }) => ({ text: headers.authorization ? "LEAKED" : "file body" }),
    "GET /v1.0/me/drive/items/f1": () => ({ json: { id: "f1", name: "notes.txt", file: { mimeType: "text/plain" } } }),
    "GET /v1.0/me": () => ({ json: { mail: "me@outlook.com" } }),
    "POST /v1.0/me/messages/o1/createReply": () => ({ json: { id: "draft1" } }),
    "PATCH /v1.0/me/messages/draft1": ({ body }) => (patched.push(JSON.parse(body)), { json: { id: "draft1" } }),
    "POST /v1.0/me/messages/draft1/send": () => (repliesSent.push("draft1"), { status: 202, text: "" }),
    "GET /v1.0/me/messages/self1": () => ({ json: { internetMessageId: "<s1@outlook.com>", from: { emailAddress: { address: "Me@Outlook.com" } } } }),
    "GET /v1.0/me/messages/forged1": () => ({ json: { internetMessageId: "<old@outlook.com>", from: { emailAddress: { address: "me@outlook.com" } } } }),
    "GET /v1.0/me/mailFolders/sentitems/messages": ({ url }) => {
      const filter = url.searchParams.get("$filter") ?? "";
      if (filter.includes("<s1@outlook.com>")) return { json: { value: [{ id: "sent-s1", internetMessageId: "<s1@outlook.com>", toRecipients: [{ emailAddress: { address: "me+adt@outlook.com" } }] }] } };
      if (filter.includes("<old@outlook.com>")) return { json: { value: [{ internetMessageId: "<old@outlook.com>", toRecipients: [{ emailAddress: { address: "friend@example.com" } }] }] } };
      return { json: { value: [] } };
    },
  });
  let base;
  beforeAll(async () => {
    base = await ms.start();
  });
  afterAll(() => ms.server.close());

  it("signs in as a public client on localhost and handles Outlook mail, calendar and OneDrive", async () => {
    const accounts = createAccounts({ dir, vault: memoryVault(), openExternal: browser(), endpoints: { "https://login.microsoftonline.com": base, "https://graph.microsoft.com": base } });
    const account = await accounts.connectOAuth({ provider: "microsoft", clientId: "00000000-aaaa", services: ["mail", "calendar", "drive"] });
    expect(account.label).toBe("me@outlook.com");
    expect(browser.last.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/);
    expect(browser.last.searchParams.get("scope")).toBe("offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite");
    const mail = createMail({ accounts });
    expect((await mail.search({ account: account.id, unread: true }))[0]).toMatchObject({ id: "o1", from: "Shop <shop@example.com>", unread: true });
    expect(outlookSearch({ query: 'say "hi"', from: "bob" })).toBe('"say  hi  from:bob"');
    await mail.search({ account: account.id, query: "invoice" });
    expect(ms.seen.find((r) => r.path === "/v1.0/me/messages").query.$search).toBe('"invoice"');
    expect((await mail.read({ account: account.id, id: "o1" })).text).toBe("Hello from Invoice.");
    await mail.send({ account: account.id, to: "a@example.com, B <b@example.com>", subject: "Hi", body: "Yo" });
    expect(sentMail[0].message.toRecipients).toEqual([{ emailAddress: { address: "a@example.com" } }, { emailAddress: { address: "b@example.com" } }]);
    // Sent by you to your bot (a copy in Sent addressed to it), or forged with an old Message-ID of yours.
    expect(await mail.sentByMe({ account: account.id, id: "self1", to: "me+adt@outlook.com" })).toEqual({ sent: true, copy: "sent-s1", messageId: "<s1@outlook.com>" });
    expect(await mail.sentByMe({ account: account.id, id: "forged1", to: "me+adt@outlook.com" })).toEqual({ sent: false });
    // A reply goes to exactly who the approval card said (Outlook's own reply would choose for itself).
    await mail.send({ account: account.id, reply_to: "o1", to: "me@outlook.com", body: "Here's the answer." });
    expect(patched[0]).toEqual({ toRecipients: [{ emailAddress: { address: "me@outlook.com" } }], ccRecipients: [] });
    expect(repliesSent).toEqual(["draft1"]);
    const arrivals = await mail.arrivals({ account: account.id, cursor: "2026-10-21T00:00:00Z" });
    expect(arrivals.cursor).toBe("2026-10-21T10:00:00Z");
    const cal = createCalendar({ accounts });
    expect((await cal.events({ account: account.id }))[0]).toMatchObject({ title: "Review", start: "2026-10-22T09:00:00Z" });
    // A download redirect is followed without the token.
    expect(await cal.readFile({ account: account.id, id: "f1" })).toMatchObject({ name: "notes.txt", text: "file body" });
  });
});

describe("Slack and X", () => {
  const slack = fakeService({
    "POST /api/auth.test": ({ headers }) => ({ json: headers.authorization === "Bearer xoxb-good" ? { ok: true, team: "Acme", user: "adtbot" } : { ok: false, error: "invalid_auth" } }),
    "GET /api/conversations.list": () => ({ json: { ok: true, channels: [{ id: "C0123456", name: "general", is_member: true }] } }),
    "GET /api/users.list": () => ({ json: { ok: true, members: [{ id: "U1", real_name: "Riya" }] } }),
    "GET /api/conversations.history": () => ({ json: { ok: true, messages: [{ ts: "1792576800.0001", user: "U1", text: "Ship it?" }, { ts: "1792576700.0001", subtype: "channel_join", text: "joined" }] } }),
    "POST /api/chat.postMessage": ({ body }) => ({ json: { ok: true, ts: "1.2", echo: JSON.parse(body) } }),
  });
  const x = fakeService({
    "POST /2/oauth2/token": ({ headers }) => (headers.authorization === `Basic ${Buffer.from("xid:xsecret").toString("base64")}` ? { json: { access_token: "x-at", refresh_token: "x-rt", expires_in: 7200 } } : { status: 401, json: { error: "unauthorized_client" } }),
    "GET /2/users/me": () => ({ json: { data: { id: "42", username: "shoubhik" } } }),
    "GET /2/tweets/search/recent": () => ({ json: { data: [{ id: "9", text: "AI news", author_id: "7", created_at: "2026-10-21T10:00:00Z" }], includes: { users: [{ id: "7", username: "newsbot" }] } } }),
    "POST /2/tweets": ({ body }) => ({ json: { data: { id: "77", text: JSON.parse(body).text } } }),
    "GET /2/users/42/mentions": () => ({ json: { data: [{ id: "11", text: "@shoubhik hi", author_id: "7" }], includes: { users: [{ id: "7", username: "riya" }] }, meta: { newest_id: "11" } } }),
    "GET /2/dm_events": () => ({ json: { data: [{ id: "500", event_type: "MessageCreate", text: "hey", sender_id: "7" }, { id: "400", event_type: "MessageCreate", text: "old", sender_id: "42" }], includes: { users: [{ id: "7", username: "riya" }] } } }),
    "GET /2/users/by/username/riya": () => ({ json: { data: { id: "7" } } }),
    "POST /2/dm_conversations/with/7/messages": () => ({ json: { data: { dm_event_id: "501" } } }),
  });
  let slackBase;
  let xBase;
  beforeAll(async () => {
    slackBase = await slack.start();
    xBase = await x.start();
  });
  afterAll(() => {
    slack.server.close();
    x.server.close();
  });

  it("Slack: checks the token, reads a channel by name and posts", async () => {
    const accounts = createAccounts({ dir, vault: memoryVault(), openExternal: () => undefined, endpoints: { "https://slack.com": slackBase } });
    await expect(accounts.connectToken({ provider: "slack", token: "not-a-token" })).rejects.toThrow(/doesn't look like a Slack token/);
    await expect(accounts.connectToken({ provider: "slack", token: "xoxb-bad" })).rejects.toThrow(/invalid_auth/);
    expect(accounts.list()).toEqual([]);
    const account = await accounts.connectToken({ provider: "slack", token: "xoxb-good" });
    expect(account.label).toBe("Acme (adtbot)");
    const social = createSocial({ accounts });
    const read = await social.slackRead({ account: account.id, channel: "#general" });
    expect(read).toEqual({ channel: "C0123456", messages: [{ ts: "1792576800.0001", from: "Riya", text: "Ship it?", date: expect.any(String), thread: undefined }] });
    expect(await social.slackPost({ account: account.id, channel: "general", message: "Yes!" })).toEqual({ channel: "C0123456", ts: "1.2" });
    await expect(social.slackRead({ account: account.id, channel: "#random" })).rejects.toThrow(/No channel called #random/);
  });

  it("X: signs in on the registered callback, searches, posts, reads mentions and messages", async () => {
    const accounts = createAccounts({ dir, vault: memoryVault(), openExternal: browser(), endpoints: { "https://x.com": xBase, "https://api.x.com": xBase } });
    const account = await accounts.connectOAuth({ provider: "x", clientId: "xid", clientSecret: "xsecret", services: ["post", "dms"] });
    expect(account.label).toBe("@shoubhik");
    expect(browser.last.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/callback");
    const social = createSocial({ accounts });
    expect((await social.xSearch({ account: account.id, query: "AI" }))[0]).toMatchObject({ from: "@newsbot", link: "https://x.com/newsbot/status/9" });
    expect(await social.xPost({ account: account.id, message: "Hello" })).toEqual({ id: "77", link: "https://x.com/shoubhik/status/77" });
    expect(await social.xMentions({ account: account.id })).toMatchObject({ newest: "11", posts: [{ from: "@riya" }] });
    const dms = await social.xMessages({ account: account.id, since: "450" });
    expect(dms.messages.map((m) => m.text)).toEqual(["hey"]);
    expect(dms.newest).toBe("500");
    expect(await social.xSendMessage({ account: account.id, to: "@riya", message: "hi back" })).toEqual({ id: "501", to: "@riya" });
  });
});

describe("any email account (IMAP and SMTP)", () => {
  let imapServer;
  let smtpServer;
  const delivered = [];
  beforeAll(async () => {
    const hoodiecrow = require("hoodiecrow-imap");
    imapServer = hoodiecrow({
      plugins: ["id", "special-use", "idle", "uidplus", "literalplus", "unselect", "enable", "condstore", "move"],
      users: { "me@example.com": { password: "app-pass" } },
      storage: {
        INBOX: { messages: [{ raw: RAW("Your receipt", "Shop <shop@example.com>", "me+receipts@example.com"), internaldate: "21-Oct-2026 10:00:00 +0000" }] },
        "": { separator: "/", folders: { Drafts: { "special-use": "\\Drafts", messages: [] }, Sent: { "special-use": "\\Sent", messages: [] } } },
      },
    });
    await new Promise((r) => imapServer.listen(0, "127.0.0.1", r));
    const { SMTPServer } = require("smtp-server");
    smtpServer = new SMTPServer({
      authOptional: false,
      disabledCommands: ["STARTTLS"],
      onAuth: (auth, _s, cb) => (auth.username === "me@example.com" && auth.password === "app-pass" ? cb(null, { user: 1 }) : cb(new Error("bad"))),
      onData: (stream, session, cb) => {
        let raw = "";
        stream.on("data", (d) => (raw += d));
        stream.on("end", () => (delivered.push({ raw, to: session.envelope.rcptTo.map((r) => r.address) }), cb()));
      },
    });
    await new Promise((r) => smtpServer.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    imapServer.close();
    smtpServer.close();
  });

  it("checks the password, then searches, reads, drafts, sends (with a copy in Sent) and sees new mail", async () => {
    const accounts = createAccounts({ dir, vault: memoryVault(), openExternal: () => undefined });
    const mail = createMail({ accounts });
    const config = (password) => ({
      address: "me@example.com",
      password,
      imap: { host: "127.0.0.1", port: imapServer.server?.address?.().port ?? imapServer.address().port, secure: false },
      smtp: { host: "127.0.0.1", port: smtpServer.server.address().port, secure: false },
    });
    await expect(accounts.connectImap(config("wrong"), mail.check)).rejects.toThrow(/refused the password|Couldn't reach/);
    const account = await accounts.connectImap(config("app-pass"), mail.check);
    expect(account).toMatchObject({ provider: "imap", label: "me@example.com", services: ["mail"] });
    expect(JSON.stringify(accounts.list())).not.toMatch(/app-pass/);

    const found = await mail.search({ account: account.id, query: "receipt" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subject: "Your receipt", from: "Shop <shop@example.com>", unread: true });
    expect((await mail.read({ account: account.id, id: found[0].id })).text).toBe("Hello from Your receipt.");

    const cursor = (await mail.arrivals({ account: account.id })).cursor;
    await mail.draft({ account: account.id, reply_to: found[0].id, body: "Thanks" });
    await mail.send({ account: account.id, to: "friend@example.com", subject: "Hello", body: "Hi there" });
    expect(delivered[0].to).toEqual(["friend@example.com"]);
    expect(delivered[0].raw).toMatch(/Subject: Hello/);
    // New mail arrives: only it is reported.
    imapServer.appendMessage?.("INBOX", [], false, RAW("Second receipt", "Shop <shop@example.com>", "me+receipts@example.com"));
    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({ host: "127.0.0.1", port: config().imap.port, secure: false, auth: { user: "me@example.com", pass: "app-pass" }, logger: false });
    await client.connect();
    if (!imapServer.appendMessage) await client.append("INBOX", RAW("Second receipt", "Shop <shop@example.com>", "me+receipts@example.com"));
    const status = { drafts: (await client.status("Drafts", { messages: true })).messages, sent: (await client.status("Sent", { messages: true })).messages };
    await client.logout();
    expect(status).toEqual({ drafts: 1, sent: 1 });
    const fresh = await mail.arrivals({ account: account.id, cursor });
    expect(fresh.messages.map((m) => m.subject)).toEqual(["Second receipt"]);
    expect((await mail.arrivals({ account: account.id, cursor: fresh.cursor })).messages).toEqual([]);
  });

  it("tells mail you sent your bot from forged mail (sentByMe)", async () => {
    const accounts = createAccounts({ dir, vault: memoryVault(), openExternal: () => undefined });
    const mail = createMail({ accounts });
    const port = imapServer.server?.address?.().port ?? imapServer.address().port;
    const account = await accounts.connectImap({ address: "me@example.com", password: "app-pass", imap: { host: "127.0.0.1", port, secure: false }, smtp: { host: "127.0.0.1", port: smtpServer.server.address().port, secure: false } }, mail.check);
    const raw = (id, to, subject) => `From: Me <me@example.com>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.com>\r\nDate: Tue, 21 Oct 2026 12:00:00 +0000\r\n\r\n${subject}\r\n`;
    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({ host: "127.0.0.1", port, secure: false, auth: { user: "me@example.com", pass: "app-pass" }, logger: false });
    await client.connect();
    // Really sent from this account: the copy in Sent was addressed to the bot.
    await client.append("Sent", raw("task1", "me+adt@example.com", "Plan my week"));
    await client.append("INBOX", raw("task1", "me+adt@example.com", "Plan my week"));
    // Forged with a real Message-ID of mail you once sent someone else.
    await client.append("Sent", raw("old2", "friend@example.com", "Old mail"));
    await client.append("INBOX", raw("old2", "me+adt@example.com", "Wire money"));
    // Forged with an id that was never sent.
    await client.append("INBOX", raw("never3", "me+adt@example.com", "Delete files"));
    await client.logout();
    const toBot = await mail.search({ account: account.id, to: "me+adt@example.com" });
    const bySubject = Object.fromEntries(toBot.map((m) => [m.subject, m.id]));
    const check = (subject) => mail.sentByMe({ account: account.id, id: bySubject[subject], to: "me+adt@example.com" });
    const real = await check("Plan my week");
    expect(real).toMatchObject({ sent: true, messageId: "<task1@example.com>" });
    // The task is read from the Sent copy.
    expect(real.copy).toMatch(/^Sent\|/);
    expect((await mail.read({ account: account.id, id: real.copy })).text).toBe("Plan my week");
    expect(await check("Wire money")).toEqual({ sent: false });
    expect(await check("Delete files")).toEqual({ sent: false });
    // The receipt from a shop isn't yours either.
    const receipt = (await mail.search({ account: account.id, query: "Your receipt" }))[0];
    expect(await mail.sentByMe({ account: account.id, id: receipt.id, to: "me+receipts@example.com" })).toEqual({ sent: false });
  });

  it("checks addresses", () => {
    expect(addresses("a@x.com, B <b@y.org>")).toEqual(["a@x.com", "B <b@y.org>"]);
    expect(() => addresses("a@x.com, nope")).toThrow(/"nope" isn't an email address/);
  });
});
