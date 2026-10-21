/** Connected apps (desktop): the account list, connecting, and operations run by the desktop side. */
import { create } from "zustand";
import { desktopInvoke, isDesktop } from "../../lib/desktop";

export type AppProvider = "google" | "microsoft" | "imap" | "slack" | "x";
export type AppService = "mail" | "calendar" | "drive" | "chat" | "post" | "dms";

export type AppAccount = {
  id: string;
  provider: AppProvider;
  /** The email address, @username or workspace. */
  label: string;
  services: AppService[];
  createdAt: number;
  imap?: { address: string; user: string; imap: { host: string; port: number; secure: boolean }; smtp: { host: string; port: number; secure: boolean } };
};

export const useApps = create<{ accounts: AppAccount[]; loaded: boolean }>(() => ({ accounts: [], loaded: false }));

export async function refreshApps(): Promise<AppAccount[]> {
  if (!isDesktop()) return [];
  try {
    const accounts = await desktopInvoke<AppAccount[]>("adt:apps:list");
    useApps.setState({ accounts, loaded: true });
    return accounts;
  } catch {
    useApps.setState({ loaded: true });
    return [];
  }
}

/** Runs an operation ("mail.search") on the desktop side. */
export function appsCall<T>(op: string, params: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) return Promise.reject(new Error("Connected apps need the ADT Bot desktop app."));
  return desktopInvoke<T>("adt:apps:call", { op, params });
}

export async function connectOAuth(provider: "google" | "microsoft" | "x", clientId: string, clientSecret: string, services: AppService[]) {
  const account = await desktopInvoke<AppAccount>("adt:apps:connect", { provider, clientId, clientSecret, services });
  await refreshApps();
  return account;
}

export async function connectSlack(token: string) {
  const account = await desktopInvoke<AppAccount>("adt:apps:connect-token", { provider: "slack", token });
  await refreshApps();
  return account;
}

export async function connectEmail(details: { address: string; user?: string; password: string; imap: { host: string; port: number }; smtp: { host: string; port: number } }) {
  const account = await desktopInvoke<AppAccount>("adt:apps:connect-email", details);
  await refreshApps();
  return account;
}

export async function disconnectApp(id: string) {
  await desktopInvoke("adt:apps:remove", { id });
  await refreshApps();
}

/** Accounts that can do something ("mail"), in the order they were connected. */
export function accountsFor(service: AppService, provider?: AppProvider): AppAccount[] {
  return useApps.getState().accounts.filter((a) => a.services.includes(service) && (!provider || a.provider === provider));
}

/**
 * The account a bot meant: by id, email, @username or service name ("gmail", "outlook"), or the
 * only/first one that can do it.
 */
export function pickAccount(service: AppService, ref: unknown, provider?: AppProvider): AppAccount {
  const list = accountsFor(service, provider);
  const what = { mail: "email", calendar: "calendar", drive: "files", chat: "Slack", post: "X", dms: "X messages" }[service];
  if (!list.length) throw new Error(`No ${what} account is connected. The user can connect one in Settings → Apps.`);
  const key = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (!key) return list[0];
  const alias: Record<string, AppProvider> = { gmail: "google", google: "google", outlook: "microsoft", microsoft: "microsoft", onedrive: "microsoft", drive: "google", imap: "imap", email: "imap", slack: "slack", x: "x", twitter: "x" };
  const found = list.find((a) => a.id === ref || a.label.toLowerCase() === key || a.label.toLowerCase().includes(key)) ?? list.find((a) => alias[key] === a.provider);
  if (!found) throw new Error(`No connected account matches "${ref}". Connected: ${list.map((a) => a.label).join(", ")}.`);
  return found;
}

/** Common email providers' servers, for "any email account". */
export const MAIL_PRESETS: { id: string; label: string; imap: { host: string; port: number }; smtp: { host: string; port: number }; help: string }[] = [
  { id: "gmail", label: "Gmail (app password)", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, help: "https://myaccount.google.com/apppasswords" },
  { id: "icloud", label: "iCloud Mail", imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587 }, help: "https://support.apple.com/102654" },
  { id: "yahoo", label: "Yahoo Mail", imap: { host: "imap.mail.yahoo.com", port: 993 }, smtp: { host: "smtp.mail.yahoo.com", port: 465 }, help: "https://help.yahoo.com/kb/SLN15241.html" },
  { id: "fastmail", label: "Fastmail", imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465 }, help: "https://www.fastmail.help/hc/en-us/articles/360058752854" },
  { id: "zoho", label: "Zoho Mail", imap: { host: "imap.zoho.com", port: 993 }, smtp: { host: "smtp.zoho.com", port: 465 }, help: "https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html" },
  { id: "custom", label: "Other (enter servers)", imap: { host: "", port: 993 }, smtp: { host: "", port: 465 }, help: "" },
];
