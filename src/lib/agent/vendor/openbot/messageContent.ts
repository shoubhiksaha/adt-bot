/** Shim for OpenBOT's messageContent helpers (MIT, see LICENSE). */
export function newCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? ""))).join("");
  return "";
}
