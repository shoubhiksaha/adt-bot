// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See ../agent/vendor/openbot/LICENSE.
/**
 * Rich cards: structured assistant output (an email draft, a message draft, a link) drawn as an
 * actionable card instead of prose. Card contents are model-authored, so parsing is defensive:
 * every string and list is bounded, and link cards only accept http(s) URLs.
 */

export type RichCardSpec =
  | { type: "email"; to: string[]; cc?: string[]; subject: string; body: string }
  | { type: "message"; service: string; channel?: string; to?: string; body: string }
  | { type: "link"; title: string; description?: string; url: string };

const TYPE_ALIASES: Record<string, RichCardSpec["type"]> = {
  email: "email",
  "email-draft": "email",
  mail: "email",
  message: "message",
  "message-draft": "message",
  sms: "message",
  text: "message",
  link: "link",
  url: "link",
};

/**
 * Parse the body of a fenced ```card block. Returns null for anything that is not a JSON object
 * of a known type, so the caller can show the original code block instead.
 */
export function parseCard(raw: string): RichCardSpec | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return toCard(value);
}

export function toCard(value: unknown): RichCardSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  const text = (key: string, max = 20_000): string => {
    const v = card[key];
    return typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "";
  };
  // Each element is truncated as well as the list bounded: one 100k-character "recipient" would
  // otherwise wedge the card and the mailto: URL.
  const list = (key: string, max = 320): string[] => {
    const v = card[key];
    const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
    return items
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, max))
      .filter(Boolean)
      .slice(0, 50);
  };

  const type = TYPE_ALIASES[String(typeof card.type === "string" ? card.type : "").trim().toLowerCase()];
  if (type === "email") {
    const cc = list("cc");
    return { type: "email", to: list("to"), cc: cc.length ? cc : undefined, subject: text("subject", 500).trim(), body: text("body") };
  }
  if (type === "message") {
    return {
      type: "message",
      service: text("service", 100).trim() || "Message",
      channel: text("channel", 200).trim() || undefined,
      to: text("to", 320).trim() || undefined,
      body: text("body"),
    };
  }
  if (type === "link") {
    const url = safeHttpUrl(text("url", 4096).trim());
    if (!url) return null;
    return { type: "link", title: text("title", 500).trim() || url, description: text("description", 2000).trim() || undefined, url };
  }
  return null;
}

/** The URL normalised, or null unless it parses as http(s). */
export function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The host a link really opens. Parsed rather than read off the string:
 * `https://google.com@evil.example/` reads as google.com to a person but its host is evil.example.
 */
export function linkHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * How much of a body a mailto: URL may carry. Mail clients truncate very long URLs silently, so
 * the draft is cut here and the Copy button carries the full text.
 */
export const MAILTO_BODY_MAX = 2000;

/**
 * A mailto: URL with each field percent-encoded per RFC 6068. (URLSearchParams would turn spaces
 * into `+`, which mail clients show literally.)
 */
export function mailtoUrl(spec: Extract<RichCardSpec, { type: "email" }>): string {
  const fields: string[] = [];
  if (spec.subject) fields.push(`subject=${encodeURIComponent(spec.subject)}`);
  if (spec.body) fields.push(`body=${encodeURIComponent(spec.body.slice(0, MAILTO_BODY_MAX))}`);
  if (spec.cc?.length) fields.push(`cc=${spec.cc.map((a) => encodeURIComponent(a)).join(",")}`);
  const to = spec.to.map((address) => encodeURIComponent(address)).join(",");
  return `mailto:${to}${fields.length ? `?${fields.join("&")}` : ""}`;
}

/** Plain text of a card, for the Copy button. */
export function cardText(spec: RichCardSpec): string {
  if (spec.type === "email") {
    const head = [`To: ${spec.to.join(", ")}`, spec.cc?.length ? `Cc: ${spec.cc.join(", ")}` : "", `Subject: ${spec.subject}`].filter(Boolean);
    return `${head.join("\n")}\n\n${spec.body}`;
  }
  if (spec.type === "message") return spec.body;
  return spec.description ? `${spec.title}\n${spec.url}\n${spec.description}` : `${spec.title}\n${spec.url}`;
}
