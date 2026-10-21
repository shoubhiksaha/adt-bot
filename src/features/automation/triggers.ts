/**
 * Routines that run when something happens instead of on a schedule: an email arrives (optionally
 * at a plus-address like you+receipts@…), a Slack message, a mention or message on X, a new item in
 * an RSS/Atom feed (blogs, news, GitHub releases), a web page changes, a webhook is called, or files
 * change in a folder. What arrived goes to the bot as outside content, so Full access still asks
 * before changes. Pure parts here; the checking loop is in trigger-runner.ts.
 */

export type Trigger =
  | { type: "email"; account: string; from?: string; to?: string; subject?: string }
  | { type: "slack"; account: string; channel: string; contains?: string }
  | { type: "x"; account: string; what: "mentions" | "messages" }
  | { type: "feed"; url: string }
  | { type: "page"; url: string }
  | { type: "webhook"; token: string }
  | { type: "folder"; path: string };

/** Where a trigger left off: a cursor (mail, Slack, X), the feed items seen, the page as last read. */
export type TriggerState = {
  cursor?: string;
  seen?: string[];
  hash?: string;
  text?: string;
  checkedAt?: number;
  /** The last check's problem, shown in the list. */
  error?: string;
  /** When runs started in the last hour (rate limit). */
  runs?: number[];
};

/** Something that happened, for the bot: a headline, the details (outside content) and where from. */
export type TriggerEvent = { title: string; details: string; source: string };

/** How often each kind is checked. Webhooks and folders are pushed by the desktop app. */
export const POLL_MS: Record<Trigger["type"], number> = {
  email: 2 * 60_000,
  slack: 2 * 60_000,
  x: 5 * 60_000,
  feed: 15 * 60_000,
  page: 15 * 60_000,
  webhook: 0,
  folder: 0,
};
/** A routine runs at most this often from events; more events wait for the next allowed run. */
export const MAX_EVENT_RUNS_PER_HOUR = 12;
/** Events handed to one run at most. */
export const MAX_EVENTS_PER_RUN = 10;
/** Kinds that need the desktop app. */
export const DESKTOP_TRIGGERS = new Set<Trigger["type"]>(["email", "slack", "x", "webhook", "folder"]);

const isHttp = (url: string) => {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
};

export function validateTrigger(t: Trigger | undefined): string | null {
  if (!t) return null;
  switch (t.type) {
    case "email":
      return t.account ? null : "Pick the email account to watch.";
    case "slack":
      return !t.account ? "Pick the Slack workspace." : !t.channel?.trim() ? "Say which channel to watch." : null;
    case "x":
      return t.account ? null : "Pick the X account.";
    case "feed":
    case "page":
      return isHttp(t.url ?? "") ? null : "Enter a web address starting with https://";
    case "webhook":
      return /^[\w-]{20,}$/.test(t.token ?? "") ? null : "The webhook needs a token.";
    case "folder":
      return !t.path?.trim() ? "Pick a folder." : t.path.trim() === "/" ? "Pick a folder, not the whole disk." : null;
    default:
      return "Unknown trigger.";
  }
}

/** "When an email arrives at you+receipts@… from @shop.com", for lists and the bot's run message. */
export function describeTrigger(t: Trigger, accountLabel = ""): string {
  switch (t.type) {
    case "email": {
      const filters = [t.to && `at ${t.to}`, t.from && `from ${t.from}`, t.subject && `about "${t.subject}"`].filter(Boolean).join(" ");
      return `When an email arrives${accountLabel ? ` in ${accountLabel}` : ""}${filters ? ` ${filters}` : ""}`;
    }
    case "slack":
      return `When someone writes in ${t.channel.startsWith("#") ? t.channel : `#${t.channel}`}${t.contains ? ` mentioning "${t.contains}"` : ""}`;
    case "x":
      return t.what === "messages" ? `When you get a message on X${accountLabel ? ` (${accountLabel})` : ""}` : `When someone mentions ${accountLabel || "you"} on X`;
    case "feed":
      return `When ${host(t.url)} posts something new`;
    case "page":
      return `When ${host(t.url)} changes`;
    case "webhook":
      return "When its webhook is called";
    case "folder":
      return `When files change in ${t.path}`;
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const lower = (s: string | undefined) => (s ?? "").toLowerCase();
const bare = (s: string) => (/<([^>]+)>\s*$/.exec(s)?.[1] ?? s).trim().toLowerCase();

/**
 * Whether an email matches the trigger's filters (each "contains", any case). Mail the account sent
 * itself never matches, so a routine that emails can't set itself off.
 */
export function matchesEmail(t: Extract<Trigger, { type: "email" }>, m: { from: string; to: string[]; subject: string }, own: string): boolean {
  if (own && bare(m.from) === own.toLowerCase()) return false;
  if (t.from && !lower(m.from).includes(lower(t.from))) return false;
  if (t.to && !m.to.some((to) => lower(to).includes(lower(t.to)))) return false;
  if (t.subject && !lower(m.subject).includes(lower(t.subject))) return false;
  return true;
}

export type FeedItem = { id: string; title: string; link: string; date: string; summary: string };

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Items of an RSS or Atom feed, newest first as the feed lists them. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.slice(0, 100).map((block) => {
    const tag = (name: string) => {
      const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
      return m ? decodeXml(m[1]) : "";
    };
    const atomLink = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ?? /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)?.[1];
    const link = atomLink ?? tag("link");
    const title = tag("title");
    const id = tag("guid") || tag("id") || link || title;
    const summary = (tag("description") || tag("summary") || tag("content") || tag("content:encoded")).slice(0, 600);
    return { id, title, link, date: tag("pubDate") || tag("updated") || tag("published") || tag("dc:date"), summary };
  });
}

/** What's new on a page: lines it didn't have before, up to `max` characters ("" when nothing new). */
export function pageChange(before: string, after: string, max = 1500): string {
  const old = new Set(before.split(/\n|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean));
  const added = after
    .split(/\n|(?<=[.!?])\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && !old.has(l));
  const text = added.join("\n");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A short, stable fingerprint of a page's text (whitespace and digits-only lines like clocks ignored). */
export async function fingerprint(text: string): Promise<string> {
  const clean = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^[\d\s:.,/-]+$/.test(l))
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new webhook secret: 32 random bytes, URL-safe. */
export function newWebhookToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Run times still inside the last hour, and whether another run is allowed now. */
export function rateCheck(runs: number[] | undefined, now: number): { recent: number[]; allowed: boolean } {
  const recent = (runs ?? []).filter((t) => now - t < 3600_000);
  return { recent, allowed: recent.length < MAX_EVENT_RUNS_PER_HOUR };
}
