import { ExternalLink, Loader2, LogIn, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { confirmThen } from "../../components/Confirm";
import { CopyButton } from "../../components/CopyButton";
import { Section } from "../../components/settings/controls";
import { isDesktop } from "../../lib/desktop";
import {
  type AppAccount,
  type AppService,
  cleanAppPassword,
  connectEmail,
  connectOAuth,
  connectSlack,
  detectEmail,
  disconnectApp,
  loadSignInOptions,
  type MailService,
  reconnectApp,
  refreshApps,
  signInWith,
  useApps,
  useSignInOptions,
} from "./api";
import "./apps.css";

const SERVICE_LABEL: Record<AppService, string> = { mail: "Email", calendar: "Calendar", drive: "Files", chat: "Slack", post: "Posts", dms: "Messages" };
const PROVIDER_LABEL: Record<AppAccount["provider"], string> = { google: "Google", microsoft: "Microsoft", imap: "Email", slack: "Slack", x: "X" };
const PROVIDER_GIVES = { google: "Gmail, Google Calendar and Google Drive", microsoft: "Outlook mail and calendar, and OneDrive" };

/** Settings for a new Slack app ("From a manifest"): the bot and the scopes the Slack tools use. */
const SLACK_MANIFEST = JSON.stringify(
  {
    display_information: { name: "ADT Bot" },
    features: { bot_user: { display_name: "ADT Bot", always_online: false } },
    oauth_config: { scopes: { bot: ["channels:read", "channels:history", "groups:read", "groups:history", "chat:write", "users:read"] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  },
  null,
  2,
);

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children} <ExternalLink size={11} />
    </a>
  );
}

/** One way to connect: a title, what it gives the bots, the steps, the fields and a Connect button. */
function Card({ id, title, gives, steps, open, onToggle, children }: { id: string; title: string; gives: string; steps: ReactNode; open: boolean; onToggle: (id: string, open: boolean) => void; children: ReactNode }) {
  return (
    <details className="app-card" id={`app-card-${id}`} open={open} onToggle={(e) => onToggle(id, (e.currentTarget as HTMLDetailsElement).open)}>
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

type Run = (label: string, waiting: string, fn: () => Promise<AppAccount>, done?: (account: AppAccount) => string) => Promise<void>;

function useConnect() {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run: Run = async (label, waiting, fn, done) => {
    setBusy(label);
    setMessage({ ok: true, text: waiting });
    try {
      const account = await fn();
      setMessage({ ok: true, text: done ? done(account) : `Connected ${account.label}.` });
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

/** "Sign in with Google": the app registration this copy was built with, so nothing to set up. */
function SignInButton({ provider, busy, run, services = ["mail", "calendar", "drive"] }: { provider: "google" | "microsoft"; busy: string; run: Run; services?: AppService[] }) {
  const name = PROVIDER_LABEL[provider];
  return (
    <button type="button" className="btn primary" disabled={Boolean(busy) || !services.length} onClick={() => void run(provider, `Sign in with ${name} in your browser…`, () => signInWith(provider, services))}>
      <LogIn size={15} /> Sign in with {name}
    </button>
  );
}

function QuickSignIn({ provider, busy, run }: { provider: "google" | "microsoft"; busy: string; run: Run }) {
  const [services, setServices] = useState<AppService[]>(["mail", "calendar", "drive"]);
  return (
    <div className="app-quick">
      <SignInButton provider={provider} busy={busy} run={run} services={services} />
      <span className="small muted">{PROVIDER_GIVES[provider]}</span>
      <Services options={["mail", "calendar", "drive"]} value={services} onChange={setServices} />
    </div>
  );
}

const looksLikeAddress = (value: string) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim());

/**
 * Email in one place: type the address, and ADT Bot works out the service (from the domain and its
 * DNS) and shows only that service's steps: one-click sign-in, or an app password and its link.
 */
function EmailConnect({ busy, run, signIn, showSteps }: { busy: string; run: Run; signIn: { google: boolean; microsoft: boolean }; showSteps: (card: string) => void }) {
  const [address, setAddress] = useState("");
  const [found, setFound] = useState<MailService | null>(null);
  const [looking, setLooking] = useState(false);
  const [password, setPassword] = useState("");
  const [servers, setServers] = useState({ imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465 });
  const [editServers, setEditServers] = useState(false);
  const [withPassword, setWithPassword] = useState(false);

  useEffect(() => {
    setFound(null);
    setEditServers(false);
    setWithPassword(false);
    if (!looksLikeAddress(address)) return;
    let live = true;
    const timer = setTimeout(() => {
      setLooking(true);
      detectEmail(address.trim())
        .then((service) => {
          if (!live) return;
          setFound(service);
          setServers({ imapHost: service.imap?.host ?? "", imapPort: service.imap?.port ?? 993, smtpHost: service.smtp?.host ?? "", smtpPort: service.smtp?.port ?? 465 });
          setEditServers(service.how === "guess");
        })
        .catch(() => undefined)
        .finally(() => live && setLooking(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
      setLooking(false);
    };
  }, [address]);

  const oneClick = found?.signIn && signIn[found.signIn] && !withPassword;
  const connect = () =>
    void run("email", "Checking your address and password with the mail server…", () =>
      connectEmail({
        address: address.trim(),
        password: cleanAppPassword(found?.service, password),
        imap: { host: servers.imapHost.trim(), port: servers.imapPort },
        smtp: { host: servers.smtpHost.trim(), port: servers.smtpPort },
      }).then((account) => {
        setPassword("");
        setAddress("");
        return account;
      }),
    );

  return (
    <div className="app-email">
      <label className="small" htmlFor="app-email-address">
        Your email address
      </label>
      <div className="input-group" style={{ alignItems: "center" }}>
        <input id="app-email-address" className="input" type="email" autoComplete="email" placeholder="you@example.com" value={address} onChange={(e) => setAddress(e.target.value)} />
        {looking && <Loader2 size={15} className="spin" aria-label="Looking up your email service" />}
      </div>

      {found && (
        <p className="small muted app-email-found">
          {found.service === "other"
            ? found.how === "srv"
              ? `Found ${found.label}'s mail servers.`
              : `ADT Bot doesn't know ${found.label}'s mail servers: check them below against your provider's help pages.`
            : found.how === "mx"
              ? `${found.label.replace(/^Outlook$/, "Microsoft 365")} handles mail for ${address.split("@")[1]}.`
              : `Your email is with ${found.label}.`}
        </p>
      )}

      {found && !found.passwords && (
        <>
          <p className="small">Outlook and Microsoft 365 only let other apps in with Microsoft sign-in, not a password.</p>
          {signIn.microsoft ? (
            <SignInButton provider="microsoft" busy={busy} run={run} />
          ) : (
            <button type="button" className="btn" onClick={() => showSteps("microsoft")}>
              Show the Microsoft steps
            </button>
          )}
        </>
      )}

      {found?.passwords && oneClick && found.signIn && (
        <>
          <SignInButton provider={found.signIn} busy={busy} run={run} />
          <button type="button" className="link-btn small" onClick={() => setWithPassword(true)}>
            Use an app password instead (email only)
          </button>
        </>
      )}

      {found?.passwords && !oneClick && (
        <>
          <ol className="small app-steps">
            {found.service === "gmail" && (
              <>
                {found.twoStep && (
                  <li>
                    Make sure <Link href={found.twoStep}>2-Step Verification</Link> is on (Google only gives app passwords then).
                  </li>
                )}
                <li>
                  <Link href={found.appPasswords ?? "https://myaccount.google.com/apppasswords"}>Create an app password</Link>: name it “ADT Bot” and copy the 16 letters Google shows.
                </li>
                <li>Paste them below. Spaces are fine.</li>
              </>
            )}
            {found.service !== "gmail" && found.appPasswords && (
              <>
                <li>
                  <Link href={found.appPasswords}>Create an app password</Link> for ADT Bot in your {found.label} account.
                </li>
                <li>Paste it below (not your normal password).</li>
              </>
            )}
            {!found.appPasswords && <li>Enter your email password, or an app password if your provider offers them (safer: you can revoke it alone).</li>}
          </ol>
          <input className="input" type="password" autoComplete="off" placeholder={found.appPasswords ? "App password" : "Password"} aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {editServers ? (
            <div className="app-servers">
              <input className="input" placeholder="IMAP server (reading)" aria-label="IMAP server" value={servers.imapHost} onChange={(e) => setServers({ ...servers, imapHost: e.target.value })} />
              <input className="input" type="number" aria-label="IMAP port" value={servers.imapPort} onChange={(e) => setServers({ ...servers, imapPort: Number(e.target.value) })} />
              <input className="input" placeholder="SMTP server (sending)" aria-label="SMTP server" value={servers.smtpHost} onChange={(e) => setServers({ ...servers, smtpHost: e.target.value })} />
              <input className="input" type="number" aria-label="SMTP port" value={servers.smtpPort} onChange={(e) => setServers({ ...servers, smtpPort: Number(e.target.value) })} />
            </div>
          ) : (
            <button type="button" className="link-btn small" onClick={() => setEditServers(true)}>
              Change mail servers
            </button>
          )}
          <button type="button" className="btn primary" disabled={Boolean(busy) || !password || !servers.imapHost.trim() || !servers.smtpHost.trim()} onClick={connect}>
            Connect {address.trim()}
          </button>
          <span className="small muted">ADT Bot signs in to read and to send once before saving, so a wrong password or server shows up now.</span>
        </>
      )}
    </div>
  );
}

export function AppsSettings() {
  const accounts = useApps((s) => s.accounts);
  const signIn = useSignInOptions();
  const desktop = isDesktop();
  const { busy, message, run } = useConnect();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [google, setGoogle] = useState({ id: "", secret: "", services: ["mail", "calendar", "drive"] as AppService[] });
  const [microsoft, setMicrosoft] = useState({ id: "", services: ["mail", "calendar", "drive"] as AppService[] });
  const [x, setX] = useState({ id: "", secret: "", services: ["post", "dms"] as AppService[] });
  const [slack, setSlack] = useState("");
  useEffect(() => {
    void refreshApps();
    void loadSignInOptions();
  }, []);

  if (!desktop) {
    return (
      <div className="settings-pane">
        <Section title="Apps">
          <p className="small muted">Connecting email, calendars, files, Slack and X needs the ADT Bot desktop app (Mac, Windows or Linux).</p>
        </Section>
      </div>
    );
  }

  const toggle = (id: string, value: boolean) => setOpen((o) => (o[id] === value ? o : { ...o, [id]: value }));
  const showSteps = (id: string) => {
    toggle(id, true);
    requestAnimationFrame(() => document.getElementById(`app-card-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const cardProps = (id: string) => ({ id, open: Boolean(open[id]), onToggle: toggle });
  const own = (provider: "google" | "microsoft") => (signIn[provider] ? `${PROVIDER_LABEL[provider]} with your own app registration` : PROVIDER_LABEL[provider]);

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
                  {a.needsSignIn && <span className="small error-text"> · signed out</span>}
                </span>
                {a.needsSignIn && (
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(busy)}
                    onClick={() => void run(`again-${a.id}`, `Sign in to ${a.label} in your browser…`, () => reconnectApp(a.id), (account) => `Signed in to ${account.label} again.`)}
                  >
                    <LogIn size={14} /> Sign in again
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={`Disconnect ${a.label}`} title="Disconnect" onClick={() => confirmThen({ message: `Disconnect ${a.label}?`, confirm: "Disconnect", danger: true }, () => disconnectApp(a.id))}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Nothing connected yet.</p>
        )}
        {message && (
          <p className={`small ${message.ok ? "muted" : "error-text"}`} role="status">
            {busy && <Loader2 size={13} className="spin" />} {message.text}
          </p>
        )}
      </Section>

      <Section title="Connect" hint={signIn.google || signIn.microsoft ? "One click: sign in, allow ADT Bot, and you're back here." : "Type your email address: ADT Bot finds your mail service and shows only the steps it needs."}>
        {signIn.google && <QuickSignIn provider="google" busy={busy} run={run} />}
        {signIn.microsoft && <QuickSignIn provider="microsoft" busy={busy} run={run} />}
        <EmailConnect busy={busy} run={run} signIn={signIn} showSteps={showSteps} />
      </Section>

      <Section title="More ways to connect">
        <Card
          {...cardProps("google")}
          title={own("google")}
          gives="Gmail, Google Calendar, Google Drive"
          steps={
            <>
              <li>
                <Link href="https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com">Create a project and switch on the Gmail, Calendar and Drive APIs</Link> in Google Cloud (any project name). If that page doesn't load, turn them on in <Link href="https://console.cloud.google.com/apis/library">APIs &amp; Services → Library</Link>.
              </li>
              <li>
                In <Link href="https://console.cloud.google.com/auth/audience">Google Auth Platform → Audience</Link>, choose External and add your own Google address as a test user.
              </li>
              <li>
                In <Link href="https://console.cloud.google.com/auth/clients">Clients</Link>, create a client of type <b>Desktop app</b> and copy its client ID and client secret here.
              </li>
              <li>While the app is in testing, Google asks you to sign in again about once a week: the account then shows “Sign in again” here.</li>
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
          {...cardProps("microsoft")}
          title={own("microsoft")}
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
          {...cardProps("slack")}
          title="Slack"
          gives="Read channels and post messages"
          steps={
            <>
              <li>
                <Link href="https://api.slack.com/apps?new_app=1">Create a Slack app</Link>: choose <b>From a manifest</b> and pick your workspace.
              </li>
              <li>
                Replace the example with ADT Bot's settings (<CopyButton text={SLACK_MANIFEST} label="Copy settings" className="link-btn small app-copy" />), then create the app.
              </li>
              <li>Install it to your workspace, and copy the Bot User OAuth Token (xoxb-…, under OAuth &amp; Permissions) here.</li>
              <li>
                Invite it to the channels the bots should use: <code>/invite @ADT Bot</code>.
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
          {...cardProps("x")}
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
      </Section>
    </div>
  );
}
