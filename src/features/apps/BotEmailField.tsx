import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { isDesktop } from "../../lib/desktop";
import type { Bot } from "../../lib/types";
import { refreshApps, useApps } from "./api";
import { botAddress, CHECK_MS, loadBotMail, ownAddress, patchBotMail, tagFor, useBotMail, validTag } from "./bot-mail";
import { showConversation } from "../automation/conversations";
import "./apps.css";

const when = (at: number) => new Date(at).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });

/** Bot settings → "Email this bot": its own address on a connected email account. */
export default function BotEmailField({ bot }: { bot: Bot }) {
  const accounts = useApps((s) => s.accounts).filter((a) => a.services.includes("mail"));
  const config = useBotMail((s) => s.bots[bot.id]);
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void loadBotMail();
    void refreshApps();
  }, []);
  if (!isDesktop()) return null;

  if (!accounts.length) {
    return (
      <div className="field">
        <label>Email this bot</label>
        <span className="small muted">
          Connect an email account in Settings → Apps, then give {bot.name} its own address (yours with “+{tagFor(bot.name)}”) and email it tasks from your
          phone.
        </span>
      </div>
    );
  }

  const account = accounts.find((a) => a.id === config?.account) ?? accounts[0];
  const tag = config?.tag ?? tagFor(bot.name);
  const own = ownAddress(account);
  const address = botAddress(own, tag);
  const at = own.lastIndexOf("@");
  const save = (patch: { account?: string; tag?: string; enabled?: boolean }) =>
    patchBotMail(bot.id, (c) => {
      const next = { account: account.id, tag, enabled: false, ...c, ...patch };
      // Another account or address: start watching from now, not from where the old one was.
      return next.account !== c?.account || next.tag !== c?.tag ? { ...next, cursor: undefined, checkedAt: undefined, error: undefined } : next;
    });
  const draft = tagDraft ?? tag;

  return (
    <div className="bot-email">
      <label className="toggle">
        <input type="checkbox" checked={Boolean(config?.enabled)} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>
          <strong>Email this bot</strong>
          <br />
          <span className="small muted">
            Email {address || "its address"} from your own account (your phone, another computer, or forward something) and {bot.name} does the task and
            emails you the answer. Mail from anyone else is ignored, and what you forward is treated as information, not instructions. Checked every{" "}
            {CHECK_MS / 60_000} minutes while ADT Bot is open. Your email service must support “+” addresses (Gmail, Outlook and Fastmail do).
          </span>
        </span>
      </label>
      {accounts.length > 1 && (
        <div className="field">
          <label htmlFor="bot-email-account">Account</label>
          <select id="bot-email-account" className="select" value={account.id} onChange={(e) => void save({ account: e.target.value })}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {ownAddress(a)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="bot-email-tag">{bot.name}'s address</label>
        <div className="input-group bot-email-address">
          <span className="bot-email-part" aria-hidden="true">
            {own.slice(0, at)}+
          </span>
          <input
            id="bot-email-tag"
            className="input"
            aria-label="The part after the +"
            value={draft}
            aria-invalid={!validTag(draft)}
            onChange={(e) => setTagDraft(e.target.value.toLowerCase())}
            onBlur={() => {
              if (validTag(draft) && draft !== tag) void save({ tag: draft });
              setTagDraft(null);
            }}
          />
          <span className="bot-email-part" aria-hidden="true">
            {own.slice(at)}
          </span>
          <button
            type="button"
            className="btn"
            disabled={!address}
            onClick={() => {
              void navigator.clipboard.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy size={14} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {!validTag(draft) && <span className="small error-text">Letters, numbers and dashes only.</span>}
      </div>
      {config?.enabled && (
        <span className="small muted bot-email-status">
          {config.error
            ? `Couldn't check: ${config.error}`
            : config.checkedAt
              ? `Last checked ${when(config.checkedAt)}.`
              : "Starts watching within a couple of minutes; mail sent before then isn't picked up."}
          {config.ignored ? ` Ignored ${config.ignored} email${config.ignored === 1 ? "" : "s"} from other people.` : ""}
          {config.last && (
            <>
              {" "}
              Last task: “{config.last.subject || "(no subject)"}”, {when(config.last.at)}
              {config.last.ok ? " (answered)" : ` (${config.last.note ?? "didn't finish"})`}.{" "}
              {config.last.conversationId && (
                <button type="button" className="link-btn" onClick={() => config.last?.conversationId && showConversation(config.last.conversationId)}>
                  Open the chat
                </button>
              )}
            </>
          )}
        </span>
      )}
    </div>
  );
}
