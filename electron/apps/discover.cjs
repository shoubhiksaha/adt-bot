// Which email service an address belongs to, so connecting needs only the address and a password:
// first by the domain (gmail.com), then by the domain's mail servers in DNS (a company on Google
// Workspace or Microsoft 365), then by the servers the domain announces (RFC 6186 SRV records).
// Only the domain goes to the system's DNS resolver; the address itself isn't sent anywhere.
const dns = require("node:dns");

/** Services with an app password to make, and Microsoft, whose mail needs its own sign-in. */
const SERVICES = [
  {
    id: "gmail",
    label: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    mx: /(^|\.)(google|googlemail)\.com$/i,
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 465 },
    signIn: "google",
    appPasswords: "https://myaccount.google.com/apppasswords",
    twoStep: "https://myaccount.google.com/signinoptions/twosv",
  },
  {
    id: "microsoft",
    label: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com", "outlook.in", "hotmail.co.uk", "live.co.uk", "outlook.co.uk", "hotmail.fr", "live.in"],
    mx: /\.(mail|olc)\.protection\.outlook\.com$/i,
    signIn: "microsoft",
    // Outlook.com and Microsoft 365 no longer take passwords from other apps: only Microsoft sign-in.
    passwords: false,
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    mx: /\.mail\.icloud\.com$/i,
    imap: { host: "imap.mail.me.com", port: 993 },
    smtp: { host: "smtp.mail.me.com", port: 587 },
    appPasswords: "https://account.apple.com/account/manage",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.in", "yahoo.fr", "yahoo.de"],
    mx: /\.yahoodns\.net$/i,
    imap: { host: "imap.mail.yahoo.com", port: 993 },
    smtp: { host: "smtp.mail.yahoo.com", port: 465 },
    appPasswords: "https://login.yahoo.com/account/security/app-passwords",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    mx: /\.messagingengine\.com$/i,
    imap: { host: "imap.fastmail.com", port: 993 },
    smtp: { host: "smtp.fastmail.com", port: 465 },
    appPasswords: "https://app.fastmail.com/settings/security/apps",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com", "zoho.in", "zohomail.in", "zoho.eu"],
    mx: /(^|\.)zoho(mail)?\.(com|in|eu)$/i,
    imap: { host: "imap.zoho.com", port: 993 },
    smtp: { host: "smtp.zoho.com", port: 465 },
    appPasswords: "https://accounts.zoho.com/home#security/app_password",
  },
];

/** Zoho runs a separate data centre per region: the domain or its mail servers say which. */
function zohoRegion(service, host) {
  const region = /zoho(?:mail)?\.(in|eu)$/i.exec(host)?.[1];
  if (service.id !== "zoho" || !region) return service;
  return { ...service, imap: { host: `imap.zoho.${region}`, port: 993 }, smtp: { host: `smtp.zoho.${region}`, port: 465 }, appPasswords: `https://accounts.zoho.${region}/home#security/app_password` };
}

const view = (service, how) => ({
  service: service.id,
  label: service.label,
  how,
  passwords: service.passwords !== false,
  ...(service.imap ? { imap: service.imap, smtp: service.smtp } : {}),
  ...(service.signIn ? { signIn: service.signIn } : {}),
  ...(service.appPasswords ? { appPasswords: service.appPasswords } : {}),
  ...(service.twoStep ? { twoStep: service.twoStep } : {}),
});

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/**
 * @param {string} address
 * @param {{ resolver?: { resolveMx: (d: string) => Promise<{ exchange: string, priority: number }[]>, resolveSrv: (d: string) => Promise<{ name: string, port: number, priority: number }[]> }, timeoutMs?: number }} [options]
 */
async function discoverMail(address, { resolver, timeoutMs = 4000 } = {}) {
  const domain = /^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(address ?? "").trim())?.[1]?.toLowerCase();
  if (!domain) throw new Error("Enter your full email address.");
  const known = SERVICES.find((s) => s.domains.includes(domain));
  if (known) return view(zohoRegion(known, domain), "domain");

  const dnsResolver = resolver ?? new dns.promises.Resolver({ timeout: Math.min(timeoutMs, 3000), tries: 1 });
  const ask = (fn) => withTimeout(fn().catch(() => null), timeoutMs);
  const [mx, imaps, submission] = await Promise.all([
    ask(() => dnsResolver.resolveMx(domain)),
    ask(() => dnsResolver.resolveSrv(`_imaps._tcp.${domain}`)),
    ask(() => dnsResolver.resolveSrv(`_submission._tcp.${domain}`)),
  ]);
  const exchanges = (mx ?? []).sort((a, b) => a.priority - b.priority).map((m) => String(m.exchange).toLowerCase().replace(/\.$/, ""));
  for (const host of exchanges) {
    const service = SERVICES.find((s) => s.mx.test(host));
    if (service) return view(zohoRegion(service, host), "mx");
  }
  const best = (records) => (records ?? []).filter((r) => r.name && r.name !== ".").sort((a, b) => a.priority - b.priority)[0];
  const imap = best(imaps);
  const smtp = best(submission);
  if (imap && smtp) {
    return { service: "other", label: domain, how: "srv", passwords: true, imap: { host: imap.name.replace(/\.$/, ""), port: imap.port }, smtp: { host: smtp.name.replace(/\.$/, ""), port: smtp.port } };
  }
  // A guess: shown in the server fields, to check against the provider's help pages.
  return { service: "other", label: domain, how: "guess", passwords: true, imap: { host: `imap.${domain}`, port: 993 }, smtp: { host: `smtp.${domain}`, port: 465 } };
}

module.exports = { discoverMail, SERVICES };
