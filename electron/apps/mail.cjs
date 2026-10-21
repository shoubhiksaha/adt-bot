// Email for the bots, the same way for Gmail, Outlook and any IMAP/SMTP account: search, read,
// draft, send, and "what's new since last time" (for routines that run when an email arrives).
const { addresses, bareAddress, base64url, composeMime, parseMime, text } = require("./common.cjs");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;

const clampLimit = (n, max = 50) => Math.min(Math.max(Math.round(Number(n)) || 10, 1), max);

const decode = (s) => String(s ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Search terms in Gmail's syntax. */
function gmailQuery(p) {
  const terms = [p.query, p.from && `from:(${p.from})`, p.to && `to:(${p.to})`, p.subject && `subject:(${p.subject})`, p.unread && "is:unread"];
  const since = p.since ? Date.parse(p.since) : NaN;
  if (Number.isFinite(since)) terms.push(`after:${Math.floor(since / 1000)}`);
  return terms.filter(Boolean).join(" ") || "in:inbox";
}

/** Search terms in Outlook's (KQL), quoted for $search. */
function outlookSearch(p) {
  const quote = (s) => String(s).replace(/["\\]/g, " ");
  const terms = [p.query && quote(p.query), p.from && `from:${quote(p.from)}`, p.to && `to:${quote(p.to)}`, p.subject && `subject:${quote(p.subject)}`].filter(Boolean);
  return terms.length ? `"${terms.join(" ")}"` : "";
}

const outlookAddress = (a) => (a?.emailAddress ? (a.emailAddress.name ? `${a.emailAddress.name} <${a.emailAddress.address}>` : a.emailAddress.address) : "");
const outlookMessage = (m) => ({
  id: m.id,
  threadId: m.conversationId,
  from: outlookAddress(m.from),
  to: (m.toRecipients ?? []).map(outlookAddress),
  subject: m.subject ?? "",
  date: m.receivedDateTime ?? "",
  snippet: m.bodyPreview ?? "",
  unread: m.isRead === false,
});
const OUTLOOK_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";
const recipients = (list) => list.map((a) => ({ emailAddress: { address: /<([^>]+)>\s*$/.exec(a)?.[1] ?? a } }));

function createMail({ accounts, ImapFlow = () => require("imapflow").ImapFlow, nodemailer = () => require("nodemailer") }) {
  const account = (id) => {
    const a = accounts.get(id);
    if (!a) throw new Error("That account isn't connected any more.");
    if (!a.services?.includes("mail")) throw new Error(`${a.label} isn't connected for email. Connect it again with email ticked.`);
    return a;
  };

  // IMAP ------------------------------------------------------------------------------------

  /** `pass`: a password to try before the account is saved (check()). */
  async function withImap(a, fn, pass) {
    const password = pass ?? (await accounts.secret(a.id)).password;
    const { imap, user } = a.imap;
    const local = LOOPBACK.test(imap.host);
    const Client = ImapFlow();
    const client = new Client({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user, pass: password },
      logger: false,
      // Never send a password in the clear to another machine: STARTTLS is required unless it's this one.
      doSTARTTLS: imap.secure ? undefined : local ? undefined : true,
      tls: local ? { rejectUnauthorized: false } : undefined,
      socketTimeout: 60_000,
    });
    client.on("error", () => undefined);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  const imapId = (folder, validity, uid) => `${folder}|${validity}|${uid}`;
  const parseImapId = (id) => {
    const [folder, validity, uid] = String(id).split("|");
    if (!folder || !uid || !/^\d+$/.test(uid)) throw new Error("That message id isn't from this account.");
    return { folder, validity, uid };
  };
  const envelopeMessage = (folder, validity, m) => ({
    id: imapId(folder, validity, m.uid),
    from: (m.envelope?.from ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address))[0] ?? "",
    to: (m.envelope?.to ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)),
    subject: m.envelope?.subject ?? "",
    date: (m.internalDate ?? m.envelope?.date)?.toISOString?.() ?? "",
    unread: !(m.flags ?? new Set()).has("\\Seen"),
  });

  async function imapFetch(client, folder, uids) {
    if (!uids.length) return [];
    const validity = String(client.mailbox?.uidValidity ?? "");
    const out = [];
    for await (const m of client.fetch(uids.join(","), { envelope: true, uid: true, internalDate: true, flags: true }, { uid: true })) out.push(envelopeMessage(folder, validity, m));
    return out.sort((x, y) => (y.date > x.date ? 1 : -1));
  }

  const folderByUse = async (client, use, pattern) => {
    const list = await client.list();
    return (list.find((f) => f.specialUse === use) ?? list.find((f) => pattern.test(f.path)))?.path;
  };

  // Gmail -----------------------------------------------------------------------------------

  async function gmailMeta(id, messageId) {
    const url = `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
    const { data } = await accounts.api(id, "GET", url);
    const header = (name) => data.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    return {
      id: data.id,
      threadId: data.threadId,
      from: header("from"),
      to: header("to") ? header("to").split(/,\s*/) : [],
      subject: header("subject"),
      date: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : "",
      snippet: decode(data.snippet),
      unread: (data.labelIds ?? []).includes("UNREAD"),
    };
  }

  // Operations ------------------------------------------------------------------------------

  async function search(params) {
    const a = account(params.account);
    const limit = clampLimit(params.limit);
    const p = { query: text(params.query, 500), from: text(params.from, 320), to: text(params.to, 320), subject: text(params.subject, 300), unread: Boolean(params.unread), since: text(params.since, 40) };
    if (a.provider === "google") {
      const { data } = await accounts.api(a.id, "GET", `${GMAIL}/messages`, { query: { q: gmailQuery(p), maxResults: limit } });
      return Promise.all((data?.messages ?? []).map((m) => gmailMeta(a.id, m.id)));
    }
    if (a.provider === "microsoft") {
      const searchTerms = outlookSearch(p);
      const filters = [p.unread && "isRead eq false", p.since && Number.isFinite(Date.parse(p.since)) && `receivedDateTime ge ${new Date(p.since).toISOString()}`].filter(Boolean);
      const query = searchTerms
        ? { $search: searchTerms, $top: limit, $select: OUTLOOK_FIELDS }
        : { $top: limit, $select: OUTLOOK_FIELDS, $orderby: "receivedDateTime desc", ...(filters.length ? { $filter: filters.join(" and ") } : {}) };
      const { data } = await accounts.api(a.id, "GET", searchTerms ? `${GRAPH}/messages` : `${GRAPH}/mailFolders/inbox/messages`, { query });
      return (data?.value ?? []).map(outlookMessage);
    }
    const folder = text(params.folder, 200) || "INBOX";
    return withImap(a, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const criteria = {};
        if (p.query) criteria.or = [{ subject: p.query }, { from: p.query }, { body: p.query }];
        if (p.from) criteria.from = p.from;
        if (p.to) criteria.to = p.to;
        if (p.subject) criteria.subject = p.subject;
        if (p.unread) criteria.seen = false;
        if (p.since && Number.isFinite(Date.parse(p.since))) criteria.since = new Date(p.since);
        const uids = (await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true })) || [];
        return imapFetch(client, folder, uids.slice(-limit));
      } finally {
        lock.release();
      }
    });
  }

  async function read(params) {
    const a = account(params.account);
    const id = text(params.id, 500);
    if (a.provider === "google") {
      const { data } = await accounts.api(a.id, "GET", `${GMAIL}/messages/${encodeURIComponent(id)}`, { query: { format: "raw" } });
      return parseMime(Buffer.from(String(data.raw ?? ""), "base64url"), { id: data.id, threadId: data.threadId, unread: (data.labelIds ?? []).includes("UNREAD") });
    }
    if (a.provider === "microsoft") {
      const { buffer } = await accounts.api(a.id, "GET", `${GRAPH}/messages/${encodeURIComponent(id)}/$value`);
      return parseMime(buffer, { id });
    }
    const { folder, uid } = parseImapId(id);
    return withImap(a, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const message = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!message?.source) throw new Error("That message isn't there any more.");
        return parseMime(message.source, { id });
      } finally {
        lock.release();
      }
    });
  }

  /** The fields of a new message, or of a reply to one (subject, recipients and threading filled in). */
  async function prepare(a, params) {
    const out = { to: params.to ? addresses(params.to) : [], cc: params.cc ? addresses(params.cc) : [], subject: text(params.subject, 500), text: text(params.body, 200_000) };
    const replyTo = text(params.reply_to, 500);
    if (replyTo) {
      const original = await read({ account: a.id, id: replyTo });
      out.reply = original;
      if (!out.to.length) out.to = addresses(original.from);
      if (!out.subject) out.subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    }
    if (!out.to.length) throw new Error("Say who it's to.");
    if (!out.text.trim()) throw new Error("Write the message.");
    return out;
  }

  const fromAddress = (a) => (a.provider === "imap" ? a.imap.address : a.label);

  async function rawMessage(a, m) {
    return composeMime({
      from: fromAddress(a),
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      text: m.text,
      inReplyTo: m.reply?.messageId,
      references: m.reply ? [m.reply.references, m.reply.messageId].filter(Boolean).join(" ") : undefined,
    });
  }

  async function draft(params) {
    const a = account(params.account);
    const m = await prepare(a, params);
    if (a.provider === "google") {
      const { data } = await accounts.api(a.id, "POST", `${GMAIL}/drafts`, { json: { message: { raw: base64url(await rawMessage(a, m)), ...(m.reply?.threadId ? { threadId: m.reply.threadId } : {}) } } });
      return { id: data.id, to: m.to, subject: m.subject };
    }
    if (a.provider === "microsoft") {
      if (m.reply) {
        const { data } = await accounts.api(a.id, "POST", `${GRAPH}/messages/${encodeURIComponent(m.reply.id)}/createReply`, { json: { comment: m.text } });
        return { id: data.id, to: m.to, subject: m.subject };
      }
      const { data } = await accounts.api(a.id, "POST", `${GRAPH}/messages`, {
        json: { subject: m.subject, body: { contentType: "Text", content: m.text }, toRecipients: recipients(m.to), ccRecipients: recipients(m.cc) },
      });
      return { id: data.id, to: m.to, subject: m.subject };
    }
    const raw = await rawMessage(a, m);
    return withImap(a, async (client) => {
      const drafts = (await folderByUse(client, "\\Drafts", /drafts?$/i)) ?? "Drafts";
      const result = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
      return { id: imapId(drafts, result?.uidValidity ?? "", result?.uid ?? 0), to: m.to, subject: m.subject };
    });
  }

  async function send(params) {
    const a = account(params.account);
    const m = await prepare(a, params);
    if (a.provider === "google") {
      const { data } = await accounts.api(a.id, "POST", `${GMAIL}/messages/send`, { json: { raw: base64url(await rawMessage(a, m)), ...(m.reply?.threadId ? { threadId: m.reply.threadId } : {}) } });
      return { id: data.id, to: m.to, subject: m.subject };
    }
    if (a.provider === "microsoft") {
      if (m.reply) await accounts.api(a.id, "POST", `${GRAPH}/messages/${encodeURIComponent(m.reply.id)}/reply`, { json: { comment: m.text } });
      else {
        await accounts.api(a.id, "POST", `${GRAPH}/sendMail`, {
          json: { message: { subject: m.subject, body: { contentType: "Text", content: m.text }, toRecipients: recipients(m.to), ccRecipients: recipients(m.cc) }, saveToSentItems: true },
        });
      }
      return { to: m.to, subject: m.subject };
    }
    const { password } = await accounts.secret(a.id);
    const { smtp, user } = a.imap;
    const local = LOOPBACK.test(smtp.host);
    const transport = nodemailer().createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure && !local,
      auth: { user, pass: password },
      tls: local ? { rejectUnauthorized: false } : undefined,
    });
    const raw = await rawMessage(a, m);
    const info = await transport.sendMail({ envelope: { from: a.imap.address, to: [...m.to, ...m.cc].map(bareAddress) }, raw });
    // Gmail keeps a copy itself; elsewhere it goes in Sent.
    if (!/gmail\.com$|googlemail\.com$/i.test(smtp.host)) {
      await withImap(a, async (client) => {
        const sent = await folderByUse(client, "\\Sent", /sent/i);
        if (sent) await client.append(sent, raw, ["\\Seen"]);
      }).catch(() => undefined);
    }
    return { id: info.messageId, to: m.to, subject: m.subject };
  }

  /**
   * New mail in the inbox since `cursor` (from the last call). The first call only returns a
   * cursor: routines react to mail that arrives after they're set up, not to the whole inbox.
   */
  async function arrivals({ account: id, cursor }) {
    const a = account(id);
    if (a.provider === "google") {
      const start = async () => ({ cursor: String((await accounts.api(a.id, "GET", `${GMAIL}/profile`)).data.historyId), messages: [] });
      if (!cursor) return start();
      let history;
      try {
        history = (await accounts.api(a.id, "GET", `${GMAIL}/history`, { query: { startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX", maxResults: 100 } })).data;
      } catch (error) {
        if (error.status === 404) return start();
        throw error;
      }
      const ids = [...new Set((history.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id)))].slice(-20);
      return { cursor: String(history.historyId ?? cursor), messages: await Promise.all(ids.map((m) => gmailMeta(a.id, m))) };
    }
    if (a.provider === "microsoft") {
      if (!cursor) return { cursor: new Date().toISOString(), messages: [] };
      const { data } = await accounts.api(a.id, "GET", `${GRAPH}/mailFolders/inbox/messages`, {
        query: { $filter: `receivedDateTime gt ${cursor}`, $orderby: "receivedDateTime asc", $top: 25, $select: OUTLOOK_FIELDS },
      });
      const messages = (data?.value ?? []).map(outlookMessage);
      return { cursor: messages.at(-1)?.date ?? cursor, messages };
    }
    return withImap(a, async (client) => {
      const status = await client.status("INBOX", { uidNext: true, uidValidity: true });
      const now = `${status.uidValidity}:${status.uidNext}`;
      const [validity, next] = String(cursor ?? "").split(":");
      if (!cursor || validity !== String(status.uidValidity)) return { cursor: now, messages: [] };
      if (Number(next) >= Number(status.uidNext)) return { cursor: now, messages: [] };
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = ((await client.search({ uid: `${next}:*` }, { uid: true })) || []).filter((u) => u >= Number(next)).slice(-20);
        return { cursor: now, messages: (await imapFetch(client, "INBOX", uids)).reverse() };
      } finally {
        lock.release();
      }
    });
  }

  /** Signs in to a new IMAP/SMTP account once, so a wrong password shows up straight away. */
  async function check(config, password) {
    const temp = { id: "check", provider: "imap", label: config.address, services: ["mail"], imap: config };
    try {
      await withImap(temp, async (client) => client.status("INBOX", { messages: true }), password);
    } catch (error) {
      const reason = String(error?.responseText || error?.message || error);
      throw new Error(/auth|login|credential|password/i.test(reason) ? "The mail server refused the password. Use an app password (see the steps)." : `Couldn't reach the mail server: ${reason}`);
    }
  }

  return { search, read, draft, send, arrivals, check };
}

module.exports = { createMail, gmailQuery, outlookSearch };
