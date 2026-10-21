import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { confirmThen } from "../../components/Confirm";
import { Section } from "../../components/settings/controls";
import { isDesktop } from "../../lib/desktop";
import { type AppAccount, type AppService, connectEmail, connectOAuth, connectSlack, disconnectApp, MAIL_PRESETS, refreshApps, useApps } from "./api";
import "./apps.css";

const SERVICE_LABEL: Record<AppService, string> = { mail: "Email", calendar: "Calendar", drive: "Files", chat: "Slack", post: "Posts", dms: "Messages" };
const PROVIDER_LABEL: Record<AppAccount["provider"], string> = { google: "Google", microsoft: "Microsoft", imap: "Email", slack: "Slack", x: "X" };

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children} <ExternalLink size={11} />
    </a>
  );
}

/** One way to connect: a title, what it gives the bots, the steps, the fields and a Connect button. */
function Card({ title, gives, steps, children }: { title: string; gives: string; steps: ReactNode; children: ReactNode }) {
  return (
    <details className="app-card">
      <summary>
        <strong>{title}</strong> <span className="small muted">{gives}</span>
      </summary>
      <div className="app-card-body">
        <ol className="small app-steps">{steps}</ol>
        {children}
      </div>
    </details>
  );
}

function useConnect() {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (label: string, waiting: string, fn: () => Promise<AppAccount>) => {
    setBusy(label);
    setMessage({ ok: true, text: waiting });
    try {
      const account = await fn();
      setMessage({ ok: true, text: `Connected ${account.label}.` });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    } finally {
      setBusy("");
    }
  };
  return { busy, message, run };
}

function Services({ options, value, onChange }: { options: AppService[]; value: AppService[]; onChange: (v: AppService[]) => void }) {
  return (
    <div className="tool-groups">
      {options.map((s) => (
        <label key={s} className="toggle compact">
          <input type="checkbox" checked={value.includes(s)} onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))} />
          <span>{SERVICE_LABEL[s]}</span>
        </label>
      ))}
    </div>
  );
}

export function AppsSettings() {
  const accounts = useApps((s) => s.accounts);
  const desktop = isDesktop();
  const { busy, message, run } = useConnect();
  const [google, setGoogle] = useState({ id: "", secret: "", services: ["mail", "calendar", "drive"] as AppService[] });
  const [microsoft, setMicrosoft] = useState({ id: "", services: ["mail", "calendar", "drive"] as AppService[] });
  const [x, setX] = useState({ id: "", secret: "", services: ["post", "dms"] as AppService[] });
  const [slack, setSlack] = useState("");
  const [email, setEmail] = useState({ preset: "gmail", address: "", password: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465 });
  useEffect(() => void refreshApps(), []);

  if (!desktop) {
    return (
      <div className="settings-pane">
        <Section title="Apps">
          <p className="small muted">Connecting email, calendars, files, Slack and X needs the ADT Bot desktop app (Mac, Windows or Linux).</p>
        </Section>
      </div>
    );
  }

  const preset = MAIL_PRESETS.find((p) => p.id === email.preset) ?? MAIL_PRESETS[0];
  return (
    <div className="settings-pane">
      <Section
        title="Apps"
        hint="Let your bots work in your email, calendar, files, Slack and X. What they read there is treated as outside content, and sending, posting or creating anything asks you first. Sign-ins are kept in your system keychain, on this computer only."
      >
        {accounts.length > 0 ? (
          <ul className="app-accounts">
            {accounts.map((a) => (
              <li key={a.id}>
                <span className="badge">{PROVIDER_LABEL[a.provider]}</span>
                <span className="grow">
                  <strong>{a.label}</strong> <span className="small muted">{a.services.map((s) => SERVICE_LABEL[s]).join(", ")}</span>
                </span>
                <button type="button" className="icon-btn" aria-label={`Disconnect ${a.label}`} title="Disconnect" onClick={() => confirmThen({ message: `Disconnect ${a.label}?`, confirm: "Disconnect", danger: true }, () => disconnectApp(a.id))}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Nothing connected yet. Pick a service below.</p>
        )}
        {message && <p className={`small ${message.ok ? "muted" : "error-text"}`}>{busy && <Loader2 size={13} className="spin" />} {message.text}</p>}
      </Section>

      <Card
        title="Google"
        gives="Gmail, Google Calendar, Google Drive"
        steps={
          <>
            <li>
              Open <Link href="https://console.cloud.google.com/projectcreate">Google Cloud</Link> and create a project (any name).
            </li>
            <li>
              In <Link href="https://console.cloud.google.com/apis/library">APIs &amp; Services → Library</Link>, enable the Gmail API, Google Calendar API and Google Drive API.
            </li>
            <li>
              In <Link href="https://console.cloud.google.com/auth/audience">Google Auth Platform → Audience</Link>, choose External and add your own Google address as a test user.
            </li>
            <li>
              In <Link href="https://console.cloud.google.com/auth/clients">Clients</Link>, create a client of type <b>Desktop app</b> and copy its client ID and client secret here.
            </li>
            <li>While the app is in testing, Google asks you to sign in again about once a week.</li>
          </>
        }
      >
        <Services options={["mail", "calendar", "drive"]} value={google.services} onChange={(services) => setGoogle({ ...google, services })} />
        <input className="input" placeholder="Client ID (….apps.googleusercontent.com)" value={google.id} onChange={(e) => setGoogle({ ...google, id: e.target.value })} />
        <input className="input" type="password" placeholder="Client secret" value={google.secret} onChange={(e) => setGoogle({ ...google, secret: e.target.value })} />
        <button
          type="button"
          className="btn primary"
          disabled={Boolean(busy) || !google.id.trim()}
          onClick={() => void run("google", "Sign in with Google in your browser…", () => connectOAuth("google", google.id, google.secret, google.services))}
        >
          Connect Google
        </button>
      </Card>

      <Card
        title="Microsoft"
        gives="Outlook mail and calendar, OneDrive (work, school or personal accounts)"
        steps={
          <>
            <li>
              Open <Link href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">App registrations</Link> and choose New registration.
            </li>
            <li>Supported accounts: "Accounts in any organizational directory and personal Microsoft accounts".</li>
            <li>
              Redirect URI: platform <b>Public client/native (mobile &amp; desktop)</b>, address <code>http://localhost</code>.
            </li>
            <li>Register, then copy the Application (client) ID here. Permissions are asked for when you sign in.</li>
          </>
        }
      >
        <Services options={["mail", "calendar", "drive"]} value={microsoft.services} onChange={(services) => setMicrosoft({ ...microsoft, services })} />
        <input className="input" placeholder="Application (client) ID" value={microsoft.id} onChange={(e) => setMicrosoft({ ...microsoft, id: e.target.value })} />
        <button
          type="button"
          className="btn primary"
          disabled={Boolean(busy) || !microsoft.id.trim()}
          onClick={() => void run("microsoft", "Sign in with Microsoft in your browser…", () => connectOAuth("microsoft", microsoft.id, "", microsoft.services))}
        >
          Connect Microsoft
        </button>
      </Card>

      <Card
        title="Any email account"
        gives="Gmail, iCloud, Yahoo, Fastmail, Zoho or your company's mail, with an app password"
        steps={
          <>
            <li>Turn on two-step verification for your email account if it isn't on.</li>
            <li>{preset.help ? <Link href={preset.help}>Create an app password</Link> : "Create an app password in your email account's security settings"} and paste it below (not your normal password).</li>
            <li>The bots read with IMAP and send with SMTP, always encrypted.</li>
          </>
        }
      >
        <select className="input" value={email.preset} onChange={(e) => setEmail({ ...email, preset: e.target.value })} aria-label="Email provider">
          {MAIL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input className="input" type="email" placeholder="you@example.com" value={email.address} onChange={(e) => setEmail({ ...email, address: e.target.value })} />
        <input className="input" type="password" placeholder="App password" value={email.password} onChange={(e) => setEmail({ ...email, password: e.target.value })} />
        {email.preset === "custom" && (
          <div className="app-servers">
            <input className="input" placeholder="IMAP server" value={email.imapHost} onChange={(e) => setEmail({ ...email, imapHost: e.target.value })} />
            <input className="input" type="number" aria-label="IMAP port" value={email.imapPort} onChange={(e) => setEmail({ ...email, imapPort: Number(e.target.value) })} />
            <input className="input" placeholder="SMTP server" value={email.smtpHost} onChange={(e) => setEmail({ ...email, smtpHost: e.target.value })} />
            <input className="input" type="number" aria-label="SMTP port" value={email.smtpPort} onChange={(e) => setEmail({ ...email, smtpPort: Number(e.target.value) })} />
          </div>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={Boolean(busy) || !email.address || !email.password}
          onClick={() =>
            void run("email", "Checking the password with your mail server…", () =>
              connectEmail({
                address: email.address,
                password: email.password,
                imap: email.preset === "custom" ? { host: email.imapHost, port: email.imapPort } : preset.imap,
                smtp: email.preset === "custom" ? { host: email.smtpHost, port: email.smtpPort } : preset.smtp,
              }).then((a) => (setEmail((e) => ({ ...e, password: "" })), a)),
            )
          }
        >
          Connect email
        </button>
      </Card>

      <Card
        title="Slack"
        gives="Read channels and post messages"
        steps={
          <>
            <li>
              <Link href="https://api.slack.com/apps?new_app=1">Create a Slack app</Link> (from scratch) in your workspace.
            </li>
            <li>
              Under OAuth &amp; Permissions, add bot scopes: <code>channels:read channels:history groups:read groups:history chat:write users:read</code>.
            </li>
            <li>Install it to your workspace and copy the Bot User OAuth Token (xoxb-…) here.</li>
            <li>
              Invite it to the channels the bots should use: <code>/invite @your-app</code>.
            </li>
          </>
        }
      >
        <input className="input" type="password" placeholder="xoxb-…" value={slack} onChange={(e) => setSlack(e.target.value)} />
        <button
          type="button"
          className="btn primary"
          disabled={Boolean(busy) || !slack.trim()}
          onClick={() => void run("slack", "Checking the token…", () => connectSlack(slack).then((a) => (setSlack(""), a)))}
        >
          Connect Slack
        </button>
      </Card>

      <Card
        title="X"
        gives="Search posts, read mentions and messages, post and reply"
        steps={
          <>
            <li>
              In the <Link href="https://console.x.com">X developer console</Link>, open your app (X's API is paid per use).
            </li>
            <li>
              Under User authentication settings, choose Native App, allow read and write (and direct messages), and set the callback URI to <code>http://127.0.0.1:53682/callback</code>.
            </li>
            <li>Copy the OAuth 2.0 client ID here (and the client secret, if X shows one).</li>
          </>
        }
      >
        <Services options={["post", "dms"]} value={x.services} onChange={(services) => setX({ ...x, services })} />
        <input className="input" placeholder="OAuth 2.0 client ID" value={x.id} onChange={(e) => setX({ ...x, id: e.target.value })} />
        <input className="input" type="password" placeholder="Client secret (if you have one)" value={x.secret} onChange={(e) => setX({ ...x, secret: e.target.value })} />
        <button type="button" className="btn primary" disabled={Boolean(busy) || !x.id.trim()} onClick={() => void run("x", "Sign in with X in your browser…", () => connectOAuth("x", x.id, x.secret, x.services))}>
          Connect X
        </button>
      </Card>
    </div>
  );
}
