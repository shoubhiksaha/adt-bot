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
  /** The service stopped taking the saved sign-in: "Sign in again". */
  needsSignIn?: boolean;
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
export async function appsCall<T>(op: string, params: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error("Connected apps need the ADT Bot desktop app.");
  try {
    return await desktopInvoke<T>("adt:apps:call", { op, params });
  } catch (error) {
    // Electron prefixes main-process errors with "Error invoking remote method …: Error:"; the bot needs only the rest.
    throw new Error(String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ""));
  }
}

export async function connectOAuth(provider: "google" | "microsoft" | "x", clientId: string, clientSecret: string, services: AppService[]) {
  const account = await desktopInvoke<AppAccount>("adt:apps:connect", { provider, clientId, clientSecret, services });
  await refreshApps();
  return account;
}

/** One click: signs in with the app registration this copy of ADT Bot was built with. */
export async function signInWith(provider: "google" | "microsoft", services: AppService[]) {
  const account = await desktopInvoke<AppAccount>("adt:apps:connect", { provider, services, builtIn: true });
  await refreshApps();
  return account;
}

/** Signs in again to an account whose sign-in expired, with nothing to paste. */
export async function reconnectApp(id: string) {
  const account = await desktopInvoke<AppAccount>("adt:apps:reconnect", { id });
  await refreshApps();
  return account;
}

/** Which services this copy can sign in to with one click (its built-in app registrations). */
export const useSignInOptions = create<{ google: boolean; microsoft: boolean }>(() => ({ google: false, microsoft: false }));

export async function loadSignInOptions() {
  if (!isDesktop()) return;
  try {
    useSignInOptions.setState(await desktopInvoke<{ google: boolean; microsoft: boolean }>("adt:apps:sign-in-options"));
  } catch {}
}

/** Where an address's email lives (from the domain and its DNS), and how to connect it. */
export type MailService = {
  service: "gmail" | "microsoft" | "icloud" | "yahoo" | "fastmail" | "zoho" | "other";
  label: string;
  /** "domain", "mx" (a company's mail at Google or Microsoft), "srv" (announced servers) or "guess". */
  how: "domain" | "mx" | "srv" | "guess";
  /** False for Outlook and Microsoft 365: only Microsoft sign-in works. */
  passwords: boolean;
  imap?: { host: string; port: number };
  smtp?: { host: string; port: number };
  signIn?: "google" | "microsoft";
  appPasswords?: string;
  twoStep?: string;
};

export function detectEmail(address: string): Promise<MailService> {
  return desktopInvoke<MailService>("adt:apps:detect-email", { address });
}

/** Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it. */
export function cleanAppPassword(service: MailService["service"] | undefined, password: string): string {
  const joined = password.replace(/\s+/g, "");
  return service === "gmail" && /^[a-z]{16}$/i.test(joined) ? joined : password;
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
  if (!key) return list.find((a) => !a.needsSignIn) ?? list[0];
  const alias: Record<string, AppProvider> = { gmail: "google", google: "google", outlook: "microsoft", microsoft: "microsoft", onedrive: "microsoft", drive: "google", imap: "imap", email: "imap", slack: "slack", x: "x", twitter: "x" };
  const found = list.find((a) => a.id === ref || a.label.toLowerCase() === key || a.label.toLowerCase().includes(key)) ?? list.find((a) => alias[key] === a.provider);
  if (!found) throw new Error(`No connected account matches "${ref}". Connected: ${list.map((a) => a.label).join(", ")}.`);
  return found;
}
