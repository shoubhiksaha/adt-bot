// Shared pieces for app connectors (Gmail, Outlook, any email, calendars, drives, Slack, X): PKCE,
// reading responses within limits, and turning raw email into a plain message and back.
const crypto = require("node:crypto");

const base64url = (buffer) => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE verifier and its S256 challenge. */
function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const MAX_RESPONSE = 20 * 1024 * 1024;

/** A response body as a Buffer, refusing anything over `max` bytes. */
async function readLimited(response, max = MAX_RESPONSE) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > max) throw new Error(`the answer is too large (${Math.round(length / 1e6)} MB)`);
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error(`the answer is too large (over ${Math.round(max / 1e6)} MB)`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Text arguments from the app window: strings only, trimmed to a limit. */
const text = (value, max = 2000) => (typeof value === "string" ? value.slice(0, max) : value === undefined || value === null ? "" : String(value).slice(0, max));

/** A list of email addresses ("a@x.com, B <b@y.com>" or an array), each checked. */
function addresses(value) {
  const list = (Array.isArray(value) ? value : text(value, 4000).split(/[,;]\s*/)).map((a) => text(a, 320).trim()).filter(Boolean);
  for (const a of list) {
    const bare = /<([^>]+)>\s*$/.exec(a)?.[1] ?? a;
    if (!/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(bare)) throw new Error(`"${a}" isn't an email address`);
  }
  return list.slice(0, 50);
}

/** An RFC 822 message (for drafts and sending) from plain fields. */
async function composeMime({ from, to, cc, bcc, subject, text: body, inReplyTo, references }) {
  const MailComposer = require("nodemailer/lib/mail-composer");
  const mail = new MailComposer({
    from: from || undefined,
    to: addresses(to),
    cc: cc ? addresses(cc) : undefined,
    bcc: bcc ? addresses(bcc) : undefined,
    subject: text(subject, 500),
    text: text(body, 200_000),
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  });
  return mail.compile().build();
}

const MAX_BODY = 60_000;

/** A raw email (Buffer or string) as a plain message: who, what, when, the text, attachment names. */
async function parseMime(raw, extra = {}) {
  const { simpleParser } = require("mailparser");
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const list = (field) => (field?.value ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean);
  const body = (mail.text || (typeof mail.html === "string" ? htmlToText(mail.html) : "") || "").trim();
  return {
    ...extra,
    from: list(mail.from)[0] ?? "",
    // The sender's address alone: a display name like "a@evil.com, Bob" is never read as addresses.
    fromAddress: mail.from?.value?.[0]?.address ?? "",
    to: list(mail.to),
    cc: list(mail.cc),
    subject: mail.subject ?? "",
    date: mail.date ? mail.date.toISOString() : "",
    messageId: mail.messageId ?? "",
    references: Array.isArray(mail.references) ? mail.references.join(" ") : (mail.references ?? ""),
    inReplyTo: mail.inReplyTo ?? "",
    text: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[…cut]` : body,
    attachments: (mail.attachments ?? []).map((a) => ({ name: a.filename ?? "attachment", type: a.contentType, size: a.size })),
  };
}

/** The HTML without these elements, found with indexOf (unclosed tags can't make it slow). */
function removeElements(html, tags) {
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    let next = -1;
    let tag = "";
    for (const t of tags) {
      const i = lower.indexOf(`<${t}`, at);
      if (i >= 0 && (next < 0 || i < next) && !/[a-z0-9-]/.test(lower[i + t.length + 1] ?? "")) {
        next = i;
        tag = t;
      }
    }
    if (next < 0) return out + html.slice(at);
    out += html.slice(at, next);
    const end = lower.indexOf(`</${tag}`, next);
    const gt = end < 0 ? -1 : lower.indexOf(">", end);
    if (gt < 0) return out;
    at = gt + 1;
  }
}

/** Rough HTML to text, for mail that only has HTML. */
function htmlToText(html) {
  return removeElements(String(html).slice(0, 2_000_000), ["script", "style", "head"])
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^<>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The bare address in "Name <a@b.c>". */
const bareAddress = (value) => (/<([^>]+)>\s*$/.exec(value ?? "")?.[1] ?? value ?? "").trim().toLowerCase();

module.exports = { base64url, pkce, readLimited, text, addresses, composeMime, parseMime, htmlToText, bareAddress, MAX_RESPONSE };
