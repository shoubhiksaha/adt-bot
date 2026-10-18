// Adapted from OpenBOT (github.com/ashhart/OpenBot), MIT, (c) 2026 OpenBOT contributors. See src/lib/agent/vendor/openbot/LICENSE.
import { ExternalLink, Link2, Mail, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { cardText, linkHost, mailtoUrl, type RichCardSpec } from "../../lib/visualize/cards";
import { CopyButton } from "../CopyButton";
import "./viz.css";

/*
 * Card contents are model-authored (and a model repeats what it has read), so every card says it
 * came from the bot and that nothing is sent until the user acts, and the frame is shaped like
 * quoted prose rather than like one of the app's own panels.
 */
const ORIGIN_NOTE = "Drafted by the bot. Nothing is sent or opened until you do it.";

function CardShell({ kind, icon, title, actions, children }: { kind: string; icon: ReactNode; title: string; actions: ReactNode; children?: ReactNode }) {
  return (
    <article className="rich-card">
      <header>
        <span className="rich-card-kind">
          {icon}
          {kind}
        </span>
        <strong className="rich-card-title">{title}</strong>
      </header>
      {children}
      <p className="rich-card-origin">{ORIGIN_NOTE}</p>
      <footer className="rich-card-actions">{actions}</footer>
    </article>
  );
}

/** One address per line with a count: an extra recipient appended by the model must be countable. */
function Recipients({ label, addresses }: { label: string; addresses: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {addresses.length === 0 ? (
          <span className="muted">Not set</span>
        ) : (
          <ul className="rich-card-people">
            {addresses.map((address, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: addresses may repeat
              <li key={`${i}-${address}`}>{address}</li>
            ))}
          </ul>
        )}
      </dd>
    </>
  );
}

export function RichCard({ spec }: { spec: RichCardSpec }): ReactNode {
  if (spec.type === "email") {
    // Copy is primary: "Open in Mail" only hands the draft to the mail app, it doesn't send.
    const actions = (
      <>
        <CopyButton className="btn primary rich-card-btn" text={cardText(spec)} label="Copy" />
        <a className="btn rich-card-btn" href={mailtoUrl(spec)}>
          <Mail size={14} /> Open in Mail
        </a>
      </>
    );
    return (
      <CardShell kind="Email draft" icon={<Mail size={12} />} title={spec.subject || "(no subject)"} actions={actions}>
        <dl className="rich-card-fields">
          <Recipients label="To" addresses={spec.to} />
          {spec.cc?.length ? <Recipients label="Cc" addresses={spec.cc} /> : null}
        </dl>
        {spec.body ? <p className="rich-card-body">{spec.body}</p> : null}
      </CardShell>
    );
  }

  if (spec.type === "message") {
    const where = [spec.channel, spec.to].filter(Boolean).join(" · ");
    return (
      <CardShell
        kind={`${spec.service} draft`}
        icon={<MessageSquare size={12} />}
        title={where || "Ready to review"}
        actions={<CopyButton className="btn primary rich-card-btn" text={spec.body} label="Copy message" />}
      >
        <p className="rich-card-body">{spec.body}</p>
      </CardShell>
    );
  }

  // A card that cannot say where it goes does not offer to go there.
  const host = linkHost(spec.url);
  const actions = (
    <>
      {host ? (
        <a className="btn primary rich-card-btn" href={spec.url} target="_blank" rel="noreferrer noopener" title={spec.url}>
          <ExternalLink size={14} /> Open link
        </a>
      ) : null}
      <CopyButton className="btn rich-card-btn" text={spec.url} label="Copy link" />
    </>
  );
  return (
    <CardShell kind="Link" icon={<Link2 size={12} />} title={spec.title} actions={actions}>
      <p className="rich-card-host" title={spec.url}>
        {host ?? "This address can't be read, so the link isn't offered."}
      </p>
      {spec.description ? <p className="rich-card-body">{spec.description}</p> : null}
    </CardShell>
  );
}
