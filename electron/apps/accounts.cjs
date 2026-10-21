// Connected app accounts: Google, Microsoft, X (signing in with OAuth in the user's browser), Slack
// (a bot token) and any email account (IMAP/SMTP with an app password). Account details live in
// apps.json in the app's data folder; tokens and passwords are encrypted with the OS keychain
// (electron/secrets.cjs) and never leave the main process. Requests go only to each service's own
// API addresses.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pkce, readLimited, text } = require("./common.cjs");

const PROVIDERS = {
  google: {
    label: "Google",
    kind: "oauth",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    apis: ["https://gmail.googleapis.com/", "https://www.googleapis.com/"],
    baseScopes: ["openid", "email"],
    scopes: {
      mail: ["https://www.googleapis.com/auth/gmail.modify"],
      calendar: ["https://www.googleapis.com/auth/calendar.events"],
      drive: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
    },
    authParams: { access_type: "offline", prompt: "consent" },
    loopback: "127.0.0.1",
    profileUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    profileName: (j) => j.email,
  },
  microsoft: {
    label: "Microsoft",
    kind: "oauth",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    apis: ["https://graph.microsoft.com/"],
    baseScopes: ["offline_access", "User.Read"],
    scopes: { mail: ["Mail.ReadWrite", "Mail.Send"], calendar: ["Calendars.ReadWrite"], drive: ["Files.ReadWrite"] },
    authParams: { prompt: "select_account" },
    loopback: "localhost",
    profileUrl: "https://graph.microsoft.com/v1.0/me",
    profileName: (j) => j.mail || j.userPrincipalName,
  },
  x: {
    label: "X",
    kind: "oauth",
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    apis: ["https://api.x.com/"],
    baseScopes: ["tweet.read", "users.read", "offline.access"],
    scopes: { post: ["tweet.write"], dms: ["dm.read", "dm.write"] },
    // X only accepts a callback address registered exactly, so it's always this one.
    fixedPort: 53682,
    callbackPath: "/callback",
    loopback: "127.0.0.1",
    basicAuth: true,
    profileUrl: "https://api.x.com/2/users/me",
    profileName: (j) => j.data?.username && `@${j.data.username}`,
  },
  slack: { label: "Slack", kind: "token", apis: ["https://slack.com/api/"] },
  imap: { label: "Email", kind: "password", apis: [] },
};

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const page = (message) =>
  `<!doctype html><meta charset="utf-8"><title>ADT Bot</title><body style="font:16px system-ui;padding:40px;text-align:center"><p>${message}</p></body>`;

/** Waits for the browser to come back to a loopback address with the sign-in answer. */
async function loopback(provider) {
  const servers = [];
  const handlers = new Set();
  const handle = (req, res) => handlers.forEach((h) => h(req, res));
  const listen = (host, port) =>
    new Promise((resolve, reject) => {
      const server = http.createServer(handle);
      server.once("error", reject);
      server.listen(port, host, () => {
        servers.push(server);
        resolve(server.address().port);
      });
    });
  let port;
  try {
    port = await listen("127.0.0.1", provider.fixedPort ?? 0);
  } catch (error) {
    throw new Error(error?.code === "EADDRINUSE" ? `Port ${provider.fixedPort} is busy; close what's using it and try again.` : String(error?.message ?? error));
  }
  // "localhost" may mean ::1 to the browser.
  if (provider.loopback === "localhost") await listen("::1", port).catch(() => undefined);
  return {
    redirectUri: `http://${provider.loopback}:${port}${provider.callbackPath ?? ""}`,
    onRequest: (h) => handlers.add(h),
    close: () => servers.forEach((s) => s.close()),
  };
}

/**
 * @param {{ dir: string, vault: any, fetch?: typeof fetch, openExternal: (url: string) => Promise<void> | void, endpoints?: Record<string, string> }} options
 *   `endpoints` points service addresses elsewhere (tests: a fake Google on localhost).
 */
function createAccounts({ dir, vault, fetch = globalThis.fetch, openExternal, endpoints = {} }) {
  const file = path.join(dir, "apps.json");
  /** @type {any[]} */
  let accounts = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved)) accounts = saved.filter((a) => a && typeof a.id === "string" && PROVIDERS[a.provider]);
  } catch {}
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(accounts, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const rewrite = (url) => {
    for (const [from, to] of Object.entries(endpoints)) if (url.startsWith(from)) return to + url.slice(from.length);
    return url;
  };

  const getSecret = async (id) => {
    const raw = await vault.getValue("apps", id);
    if (!raw) throw new Error("This account's sign-in is missing or the keychain is locked. Connect it again in Settings → Apps.");
    return JSON.parse(raw);
  };
  const setSecret = async (id, secret) => {
    const result = await vault.setValue("apps", id, secret ? JSON.stringify(secret) : "");
    if (!result.ok) throw new Error("Couldn't save the sign-in in the system keychain.");
  };

  async function tokenRequest(provider, params, clientId, clientSecret) {
    const body = new URLSearchParams({ ...params, client_id: clientId });
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (clientSecret) {
      if (provider.basicAuth) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      else body.set("client_secret", clientSecret);
    }
    const response = await fetch(rewrite(provider.tokenUrl), { method: "POST", headers, body });
    const data = JSON.parse((await readLimited(response, 1e6)).toString("utf8") || "{}");
    if (!response.ok || !data.access_token) throw new Error(`${provider.label} refused the sign-in: ${data.error_description || data.error || response.status}`);
    return data;
  }

  const tokensFrom = (data, previous = {}) => ({
    ...previous,
    access: data.access_token,
    refresh: data.refresh_token || previous.refresh || "",
    expires: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });

  async function freshToken(account, force = false) {
    const secret = await getSecret(account.id);
    if (account.provider === "slack") return secret.token;
    if (!force && secret.access && secret.expires - 60_000 > Date.now()) return secret.access;
    if (!secret.refresh) throw new Error(`${PROVIDERS[account.provider].label} sign-in expired. Connect the account again in Settings → Apps.`);
    const provider = PROVIDERS[account.provider];
    const data = await tokenRequest(provider, { grant_type: "refresh_token", refresh_token: secret.refresh }, secret.clientId, secret.clientSecret);
    const next = tokensFrom(data, secret);
    await setSecret(account.id, next);
    return next.access;
  }

  /** One request to a service's API with the account's token (refreshed when needed). */
  async function api(id, method, url, { query, json, body, headers = {}, max } = {}) {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error("That account isn't connected any more.");
    const provider = PROVIDERS[account.provider];
    const target = new URL(url);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== "") target.searchParams.set(key, String(value));
    // The token only ever goes to the service's own API.
    if (target.username || target.password || !provider.apis.some((base) => target.toString().startsWith(base))) throw new Error("That address isn't part of this service's API.");
    const send = async (token) => {
      let address = rewrite(target.toString());
      let verb = method;
      let payload = json ? JSON.stringify(json) : body;
      let auth = token;
      for (let hop = 0; hop < 4; hop++) {
        const response = await fetch(address, {
          method: verb,
          redirect: "manual",
          headers: { accept: "application/json", ...headers, ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(json && payload ? { "content-type": "application/json" } : {}) },
          body: payload,
        });
        // Downloads redirect to a signed address elsewhere: followed without the token.
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          const next = new URL(response.headers.get("location"), address);
          if (next.protocol !== "https:" && !Object.values(endpoints).some((e) => next.toString().startsWith(e))) throw new Error("A download led to an unsafe address.");
          address = next.toString();
          auth = "";
          verb = "GET";
          payload = undefined;
          continue;
        }
        return response;
      }
      throw new Error("Too many redirects.");
    };
    let response = await send(await freshToken(account));
    if (response.status === 401 && account.provider !== "slack") response = await send(await freshToken(account, true));
    const buffer = await readLimited(response, max);
    const type = response.headers.get("content-type") ?? "";
    let data;
    if (type.includes("json")) {
      try {
        data = JSON.parse(buffer.toString("utf8") || "null");
      } catch {}
    }
    if (!response.ok || (account.provider === "slack" && data && data.ok === false)) {
      const reason = data?.error?.message || data?.error_description || data?.detail || data?.title || (typeof data?.error === "string" ? data.error : "") || buffer.toString("utf8").slice(0, 200);
      const error = new Error(`${provider.label} said ${response.status}${reason ? `: ${reason}` : ""}`);
      error.status = response.status;
      throw error;
    }
    return { status: response.status, type, data, buffer };
  }

  const publicView = (a) => ({ id: a.id, provider: a.provider, label: a.label, services: a.services, createdAt: a.createdAt, ...(a.imap ? { imap: { ...a.imap } } : {}) });

  return {
    providers: PROVIDERS,
    list: () => accounts.map(publicView),
    get: (id) => accounts.find((a) => a.id === id),
    api,
    secret: getSecret,
    rewrite,

    /** Signs in through the browser (OAuth with PKCE and a loopback address); returns the new account. */
    async connectOAuth({ provider: name, clientId, clientSecret, services }) {
      const provider = PROVIDERS[name];
      if (!provider || provider.kind !== "oauth") throw new Error("Unknown service.");
      clientId = text(clientId, 300).trim();
      clientSecret = text(clientSecret, 300).trim();
      if (!clientId) throw new Error("Enter the client ID from your app registration (see the steps).");
      const wanted = (Array.isArray(services) ? services : Object.keys(provider.scopes)).filter((s) => provider.scopes[s]);
      if (!wanted.length) throw new Error("Pick at least one thing to connect.");
      const scopes = [...provider.baseScopes, ...wanted.flatMap((s) => provider.scopes[s])];
      const { verifier, challenge } = pkce();
      const state = crypto.randomBytes(16).toString("hex");
      const server = await loopback(provider);
      try {
        const auth = new URL(rewrite(provider.authUrl));
        const params = { client_id: clientId, redirect_uri: server.redirectUri, response_type: "code", scope: scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256", ...provider.authParams };
        for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v);
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Sign-in timed out. Try again.")), SIGN_IN_TIMEOUT_MS);
          server.onRequest((req, res) => {
            const back = new URL(req.url, server.redirectUri);
            if (back.pathname !== (provider.callbackPath ?? "/") || (!back.searchParams.has("code") && !back.searchParams.has("error"))) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (back.searchParams.get("state") !== state) {
              res.end(page("This sign-in doesn't match the one ADT Bot started. Try again from the app."));
              return;
            }
            clearTimeout(timer);
            const error = back.searchParams.get("error");
            if (error) {
              res.end(page("Sign-in was cancelled. You can close this tab."));
              reject(new Error(error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${error}`));
              return;
            }
            res.end(page("Connected. You can close this tab and go back to ADT Bot."));
            resolve(back.searchParams.get("code"));
          });
          Promise.resolve(openExternal(auth.toString())).catch(reject);
        });
        const data = await tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: server.redirectUri, code_verifier: verifier }, clientId, clientSecret);
        const id = crypto.randomUUID();
        const account = { id, provider: name, label: provider.label, services: wanted, createdAt: Date.now() };
        accounts.push(account);
        await setSecret(id, { ...tokensFrom(data), clientId, clientSecret });
        try {
          const profile = await api(id, "GET", provider.profileUrl);
          account.label = text(provider.profileName(profile.data ?? {}), 200) || provider.label;
        } catch {}
        save();
        return publicView(account);
      } catch (error) {
        throw error;
      } finally {
        server.close();
      }
    },

    /** Slack: a bot token from the user's own Slack app, checked before it's saved. */
    async connectToken({ provider: name, token }) {
      if (name !== "slack") throw new Error("Unknown service.");
      token = text(token, 500).trim();
      if (!/^xox[bp]-[\w-]+$/.test(token)) throw new Error("That doesn't look like a Slack token (it starts with xoxb-).");
      const id = crypto.randomUUID();
      const account = { id, provider: "slack", label: "Slack", services: ["chat"], createdAt: Date.now() };
      accounts.push(account);
      try {
        await setSecret(id, { token });
        const check = await api(id, "POST", "https://slack.com/api/auth.test");
        account.label = text(`${check.data.team ?? "Slack"}${check.data.user ? ` (${check.data.user})` : ""}`, 200);
      } catch (error) {
        accounts = accounts.filter((a) => a.id !== id);
        await setSecret(id, null).catch(() => undefined);
        throw error;
      }
      save();
      return publicView(account);
    },

    /** Any email account: IMAP to read, SMTP to send. `check` signs in first (to catch a wrong password). */
    async connectImap({ address, user, password, imap, smtp }, check) {
      address = text(address, 320).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Enter your email address.");
      if (!password) throw new Error("Enter the app password.");
      const server = (s, defaults) => {
        const port = Number(s?.port) || defaults.port;
        // 993 and 465 are TLS from the start; other ports upgrade with STARTTLS (required off this machine).
        return { host: text(s?.host ?? "", 255).trim(), port, secure: typeof s?.secure === "boolean" ? s.secure : port === 993 || port === 465 };
      };
      const config = { address, user: text(user, 320).trim() || address, imap: server(imap, { port: 993 }), smtp: server(smtp, { port: 465 }) };
      if (!config.imap.host || !config.smtp.host) throw new Error("Enter the mail servers (or pick your provider).");
      if (check) await check(config, String(password));
      const id = crypto.randomUUID();
      const account = { id, provider: "imap", label: address, services: ["mail"], createdAt: Date.now(), imap: config };
      accounts.push(account);
      await setSecret(id, { password: String(password).slice(0, 1000) });
      save();
      return publicView(account);
    },

    async remove(id) {
      accounts = accounts.filter((a) => a.id !== id);
      save();
      await setSecret(id, null).catch(() => undefined);
    },
  };
}

module.exports = { createAccounts, PROVIDERS };
