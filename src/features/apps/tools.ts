/**
 * Bot tools for connected apps: email (Gmail, Outlook, any IMAP account), calendars, files (Google
 * Drive, OneDrive), Slack and X. Everything read is outside content (an email can carry
 * instructions); sending, posting and creating ask first, and after outside content they always ask.
 */
import { registerTool, registerToolGroup, str, type AgentTool } from "../../lib/agent/tools";
import { fileText } from "../../lib/images";
import { accountsFor, appsCall, pickAccount, type AppService } from "./api";

registerToolGroup({ id: "apps", label: "Apps", description: "Email, calendars, files, Slack and X you connected in Settings → Apps.", platforms: ["desktop"] });

type Mail = { id: string; from: string; to: string[]; subject: string; date: string; snippet?: string; unread?: boolean };
type FullMail = Mail & { cc: string[]; text: string; attachments: { name: string; size?: number }[] };
type Event = { id: string; title: string; start: string; end: string; location: string; attendees: string[]; organizer: string; link: string; description: string };
type FileInfo = { id: string; name: string; type: string; modified?: string; link: string; size?: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const quoted = (s: unknown, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const has = (service: AppService) => () => accountsFor(service).length > 0;
const account = { type: "string", description: "Which connected account (email, @username, or gmail/outlook). Default: the first one." } as const;

const tools: AgentTool[] = [
  {
    name: "email_search",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("mail"),
    description: "Search the user's email. With no filters: the newest messages in the inbox. Returns ids for email_read.",
    parameters: {
      type: "object",
      properties: {
        account,
        query: { type: "string", description: "Words to look for (Gmail search syntax also works for Gmail)." },
        from: { type: "string" },
        to: { type: "string", description: "e.g. me+receipts@example.com" },
        subject: { type: "string" },
        unread: { type: "boolean" },
        since: { type: "string", description: "ISO date, e.g. 2026-10-01" },
        limit: { type: "number", description: "Up to 50 (default 10)." },
      },
      required: [],
    },
    async run(args) {
      const a = pickAccount("mail", args.account);
      const list = await appsCall<Mail[]>("mail.search", { ...args, account: a.id });
      if (!list.length) return `No emails found in ${a.label}.`;
      const lines = list.map((m) => `- [${m.id}] ${when(m.date)} · ${m.from} · ${m.subject || "(no subject)"}${m.unread ? " (unread)" : ""}${m.snippet ? ` — ${quoted(m.snippet, 140)}` : ""}`);
      return { content: `Emails in ${a.label}:\n${lines.join("\n")}`, untrustedSource: `emails in ${a.label}` };
    },
  },
  {
    name: "email_read",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("mail"),
    description: "Read one email in full, by the id from email_search.",
    parameters: { type: "object", properties: { account, id: { type: "string" } }, required: ["id"] },
    async run(args) {
      const a = pickAccount("mail", args.account);
      const m = await appsCall<FullMail>("mail.read", { account: a.id, id: str(args, "id") });
      const files = m.attachments.length ? `\nAttachments: ${m.attachments.map((f) => f.name).join(", ")}` : "";
      return {
        content: `From: ${m.from}\nTo: ${m.to.join(", ")}${m.cc.length ? `\nCc: ${m.cc.join(", ")}` : ""}\nDate: ${when(m.date)}\nSubject: ${m.subject}${files}\n\n${m.text}`,
        untrustedSource: `an email from ${m.from || "someone"}`,
      };
    },
  },
  {
    name: "email_draft",
    group: "apps",
    risk: "write",
    platforms: ["desktop"],
    available: has("mail"),
    description: "Save an email as a draft (for the user to check and send). To reply, give reply_to (an email id); to and subject then come from it.",
    parameters: {
      type: "object",
      properties: { account, to: { type: "string", description: "Comma-separated addresses" }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, reply_to: { type: "string" } },
      required: ["body"],
    },
    summary: (args) => `Save a draft${args.to ? ` to ${quoted(args.to)}` : args.reply_to ? " reply" : ""}${args.subject ? `: “${quoted(args.subject)}”` : ""}`,
    async run(args) {
      const a = pickAccount("mail", args.account);
      const d = await appsCall<{ to: string[]; subject: string }>("mail.draft", { ...args, account: a.id });
      const text = `Draft saved in ${a.label}: to ${d.to.join(", ")}, “${d.subject}”. The user can review and send it from their mail app.`;
      // A reply's subject and recipients come from the email it answers.
      return args.reply_to ? { content: text, untrustedSource: "the email being answered" } : text;
    },
  },
  {
    name: "email_send",
    group: "apps",
    risk: "external",
    platforms: ["desktop"],
    available: has("mail"),
    description: "Send an email now. Only when the user clearly asked to send (otherwise use email_draft). To reply, give reply_to.",
    parameters: {
      type: "object",
      properties: { account, to: { type: "string" }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, reply_to: { type: "string" } },
      required: ["body"],
    },
    summary: (args) => `Send an email${args.to ? ` to ${quoted(args.to)}` : " reply"}${args.subject ? `: “${quoted(args.subject)}”` : ""}`,
    async run(args) {
      const a = pickAccount("mail", args.account);
      const d = await appsCall<{ to: string[]; subject: string }>("mail.send", { ...args, account: a.id });
      const text = `Sent from ${a.label} to ${d.to.join(", ")}: “${d.subject}”.`;
      return args.reply_to ? { content: text, untrustedSource: "the email being answered" } : text;
    },
  },
  {
    name: "calendar_events",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("calendar"),
    description: "List calendar events between two times (default: the next 7 days), optionally matching words.",
    parameters: { type: "object", properties: { account, from: { type: "string", description: "ISO date-time" }, to: { type: "string" }, query: { type: "string" } }, required: [] },
    async run(args) {
      const a = pickAccount("calendar", args.account);
      const events = await appsCall<Event[]>("calendar.events", { ...args, account: a.id });
      if (!events.length) return `No events in ${a.label} for that time.`;
      const lines = events.map((e) => `- ${when(e.start)} – ${when(e.end)} · ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.attendees.length ? ` (with ${e.attendees.slice(0, 6).join(", ")})` : ""}${e.link ? ` <${e.link}>` : ""}`);
      return { content: `Calendar (${a.label}):\n${lines.join("\n")}`, untrustedSource: `calendar events in ${a.label}` };
    },
  },
  {
    name: "calendar_create",
    group: "apps",
    risk: "write",
    platforms: ["desktop"],
    available: has("calendar"),
    riskFor: (args) => (args.attendees && args.notify ? "external" : "write"),
    description: "Add an event to the calendar. Attendees get an invitation only if notify is true (only when the user asked to invite them).",
    parameters: {
      type: "object",
      properties: {
        account,
        title: { type: "string" },
        start: { type: "string", description: "ISO date-time with timezone, e.g. 2026-10-22T15:00:00+05:30" },
        end: { type: "string", description: "Default: an hour after the start" },
        attendees: { type: "string", description: "Comma-separated emails" },
        location: { type: "string" },
        description: { type: "string" },
        notify: { type: "boolean" },
      },
      required: ["title", "start"],
    },
    summary: (args) => `Add “${quoted(args.title)}” to the calendar on ${when(String(args.start ?? ""))}${args.notify && args.attendees ? `, inviting ${quoted(args.attendees)}` : ""}`,
    async run(args) {
      const a = pickAccount("calendar", args.account);
      const e = await appsCall<{ title: string; start: string; link: string }>("calendar.create", { ...args, account: a.id });
      return `Added “${e.title}” on ${when(e.start)} to ${a.label}.${e.link ? ` ${e.link}` : ""}`;
    },
  },
  {
    name: "files_search",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("drive"),
    description: "Search the user's Google Drive or OneDrive by name or content (empty: recent files). Returns ids for files_read.",
    parameters: { type: "object", properties: { account, query: { type: "string" }, limit: { type: "number" } }, required: [] },
    async run(args) {
      const a = pickAccount("drive", args.account);
      const files = await appsCall<FileInfo[]>("drive.search", { ...args, account: a.id });
      if (!files.length) return `No files found in ${a.label}.`;
      return { content: `Files in ${a.label}:\n${files.map((f) => `- [${f.id}] ${f.name} (${f.type.split("/").pop()}${f.modified ? `, ${when(f.modified)}` : ""})`).join("\n")}`, untrustedSource: `file names in ${a.label}` };
    },
  },
  {
    name: "files_read",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("drive"),
    description: "Read a file from Google Drive or OneDrive by id (Docs, Sheets as CSV, text, PDF, Word).",
    parameters: { type: "object", properties: { account, id: { type: "string" } }, required: ["id"] },
    timeoutMs: 180_000,
    async run(args) {
      const a = pickAccount("drive", args.account);
      const f = await appsCall<{ name: string; type: string; link?: string; text?: string; base64?: string }>("drive.read", { account: a.id, id: str(args, "id") });
      let text = f.text;
      if (text === undefined && f.base64) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        text = await fileText(new File([bytes], f.name, { type: f.type }));
      }
      const body = (text ?? "").trim();
      return { content: `${f.name}${f.link ? ` <${f.link}>` : ""}:\n\n${body.length > 60_000 ? `${body.slice(0, 60_000)}\n[…cut]` : body || "(no text)"}`, untrustedSource: `the file ${f.name}` };
    },
  },
  {
    name: "files_create",
    group: "apps",
    risk: "write",
    platforms: ["desktop"],
    available: has("drive"),
    description: "Create a document in the user's Google Drive (as a Google Doc) or OneDrive (in an ADT Bot folder).",
    parameters: { type: "object", properties: { account, name: { type: "string" }, content: { type: "string" }, format: { type: "string", enum: ["doc", "text"] } }, required: ["name", "content"] },
    summary: (args) => `Create “${quoted(args.name)}” in your files`,
    async run(args) {
      const a = pickAccount("drive", args.account);
      const f = await appsCall<{ name: string; link: string }>("drive.create", { ...args, account: a.id });
      return `Created “${f.name}” in ${a.label}.${f.link ? ` ${f.link}` : ""}`;
    },
  },
  {
    name: "slack_read",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("chat"),
    description: "Read recent messages in a Slack channel (#name or id). With no channel: lists the channels.",
    parameters: { type: "object", properties: { account, channel: { type: "string" }, limit: { type: "number" } }, required: [] },
    async run(args) {
      const a = pickAccount("chat", args.account, "slack");
      if (!str(args, "channel").trim()) {
        const channels = await appsCall<{ name: string; member: boolean; topic: string }[]>("slack.channels", { account: a.id });
        // Names and topics are set by anyone in the workspace: outside content.
        return {
          content: `Channels in ${a.label}:\n${channels.map((c) => `- ${c.name}${c.member ? "" : " (the app isn't in it)"}${c.topic ? `: ${quoted(c.topic, 80)}` : ""}`).join("\n")}`,
          untrustedSource: "Slack channel names and topics",
        };
      }
      const r = await appsCall<{ messages: { from: string; text: string; date: string; ts: string }[] }>("slack.read", { ...args, account: a.id });
      const lines = [...r.messages].reverse().map((m) => `- ${when(m.date)} ${m.from}: ${m.text}`);
      return { content: lines.length ? lines.join("\n") : "No messages.", untrustedSource: `Slack messages in ${str(args, "channel")}` };
    },
  },
  {
    name: "slack_post",
    group: "apps",
    risk: "external",
    platforms: ["desktop"],
    available: has("chat"),
    description: "Post a message to a Slack channel as the user's Slack app (optionally in a thread).",
    parameters: { type: "object", properties: { account, channel: { type: "string" }, message: { type: "string" }, thread: { type: "string" } }, required: ["channel", "message"] },
    summary: (args) => `Post in Slack ${quoted(args.channel, 30)}: “${quoted(args.message)}”`,
    async run(args) {
      const a = pickAccount("chat", args.account, "slack");
      await appsCall("slack.post", { ...args, account: a.id });
      return `Posted in ${str(args, "channel")}.`;
    },
  },
  {
    name: "x_search",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("post"),
    description: "Search recent posts on X (the last 7 days), with X's search syntax.",
    parameters: { type: "object", properties: { account, query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    async run(args) {
      const a = pickAccount("post", args.account, "x");
      const posts = await appsCall<{ from: string; text: string; date: string; link: string }[]>("x.search", { ...args, account: a.id });
      return { content: posts.length ? posts.map((p) => `- ${p.from} (${when(p.date)}): ${p.text} <${p.link}>`).join("\n") : "No posts found.", untrustedSource: "posts on X" };
    },
  },
  {
    name: "x_mentions",
    group: "apps",
    risk: "read",
    platforms: ["desktop"],
    available: has("post"),
    description: "Recent posts on X that mention the user, and (with dms) their direct messages.",
    parameters: { type: "object", properties: { account, dms: { type: "boolean" } }, required: [] },
    async run(args) {
      const a = pickAccount(args.dms ? "dms" : "post", args.account, "x");
      if (args.dms) {
        const r = await appsCall<{ messages: { from: string; mine: boolean; text: string; date: string }[] }>("x.messages", { account: a.id });
        return { content: r.messages.length ? r.messages.map((m) => `- ${when(m.date)} ${m.mine ? "you" : m.from}: ${m.text}`).join("\n") : "No messages.", untrustedSource: "direct messages on X" };
      }
      const r = await appsCall<{ posts: { from: string; text: string; link: string }[] }>("x.mentions", { account: a.id });
      return { content: r.posts.length ? r.posts.map((p) => `- ${p.from}: ${p.text} <${p.link}>`).join("\n") : "No mentions.", untrustedSource: "posts on X" };
    },
  },
  {
    name: "x_post",
    group: "apps",
    risk: "external",
    platforms: ["desktop"],
    available: has("post"),
    description: "Publish a post on X as the user (optionally as a reply). Only when the user asked to post.",
    parameters: { type: "object", properties: { account, message: { type: "string" }, reply_to: { type: "string", description: "Post id to reply to" } }, required: ["message"] },
    summary: (args) => `Post on X: “${quoted(args.message, 100)}”`,
    async run(args) {
      const a = pickAccount("post", args.account, "x");
      const r = await appsCall<{ link: string }>("x.post", { ...args, account: a.id });
      return `Posted on X as ${a.label}. ${r.link}`;
    },
  },
  {
    name: "x_send_message",
    group: "apps",
    risk: "external",
    platforms: ["desktop"],
    available: has("dms"),
    description: "Send a direct message on X to @username.",
    parameters: { type: "object", properties: { account, to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"] },
    summary: (args) => `Message ${quoted(args.to, 30)} on X: “${quoted(args.message)}”`,
    async run(args) {
      const a = pickAccount("dms", args.account, "x");
      const r = await appsCall<{ to: string }>("x.send", { ...args, account: a.id });
      return `Sent to ${r.to} on X.`;
    },
  },
];

for (const tool of tools) registerTool(tool);
