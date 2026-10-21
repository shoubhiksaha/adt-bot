import { Copy, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { askConfirm } from "../../components/Confirm";
import { ServerBrowser } from "./ServerBrowser";
import { Section } from "../../components/settings/controls";
import { updateSettings, useStore } from "../../lib/store";
import { newSyncCode, normaliseCode, syncCodeProblem } from "../../lib/sync";
import { resetSync, syncNow, useSyncStatus } from "./engine";
import { testServer } from "../automation/server-routines";

const defaultDevice = () => {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /Linux/.test(ua) ? "Linux" : "This device";
};

/** Settings → Sync: your devices share bots, chats, skills and memory through your own server. */
export function SyncSettings() {
  const sync = useStore((s) => s.settings.sync);
  const status = useSyncStatus();
  const [server, setServer] = useState(sync.server || (typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.origin : ""));
  const [code, setCode] = useState(sync.code);
  const [error, setError] = useState("");
  const set = (patch: Partial<typeof sync>) => updateSettings({ sync: { ...sync, ...patch } });

  const start = () => {
    setError("");
    const problem = syncCodeProblem(code);
    if (problem) return setError(problem);
    if (!/^https?:\/\/[^\s/]+/.test(server.trim())) return setError("Enter your ADT Bot server's address, e.g. https://adtbot.example.com");
    resetSync();
    set({ enabled: true, server: server.trim().replace(/\/+$/, ""), code: normaliseCode(code), device: sync.device || defaultDevice() });
    void syncNow();
  };

  return (
    <div className="settings-pane">
      <Section
        title="Sync between your devices"
        hint="Your bots, chats, skills, memories and profile, on every device where you use the same sync code. They travel through your own ADT Bot server (npm start with ADT_SYNC=1) end-to-end encrypted: the server only stores scrambled data and never sees the code. API keys stay on each device unless you choose to sync them too."
      >
        {sync.enabled ? (
          <>
            <p className="small">
              Syncing with <code>{sync.server}</code> as “{sync.device}”.{" "}
              {status.state === "syncing" ? (
                <>
                  <Loader2 size={13} className="spin" /> Syncing…
                </>
              ) : status.state === "error" ? (
                <span className="error-text">{status.error}</span>
              ) : status.lastSync ? (
                `Last synced ${new Date(status.lastSync).toLocaleTimeString()}.`
              ) : null}
            </p>
            <div className="field">
              <label>Your sync code (enter it on your other devices)</label>
              <div className="input-group">
                <input className="input mono" readOnly value={sync.code.match(/.{1,5}/g)?.join("-") ?? ""} />
                <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(sync.code.match(/.{1,5}/g)?.join("-") ?? "")}>
                  <Copy size={14} /> Copy
                </button>
              </div>
              <span className="small muted">Anyone with this code and your server's address can read and change your synced data. Keep it like a password.</span>
            </div>
            <label className="toggle compact">
              <input type="checkbox" checked={sync.keys} onChange={(e) => set({ keys: e.target.checked })} />
              <span className="small">Also sync API keys (encrypted like everything else)</span>
            </label>
            <div className="btn-row">
              <button type="button" className="btn" disabled={status.state === "syncing"} onClick={() => void syncNow()}>
                <RefreshCw size={14} /> Sync now
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (!(await askConfirm({ message: "Stop syncing this device?", detail: "Nothing is deleted here or on the server.", confirm: "Stop syncing", danger: true }))) return;
                  resetSync();
                  set({ enabled: false });
                }}
              >
                Stop syncing
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="sync-server">Your ADT Bot server</label>
              <input id="sync-server" className="input" placeholder="https://adtbot.example.com" value={server} onChange={(e) => setServer(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sync-code">Sync code</label>
              <div className="input-group">
                <input id="sync-code" className="input mono" placeholder="Paste the code from your other device" value={code} onChange={(e) => setCode(e.target.value)} />
                <button type="button" className="btn" onClick={() => setCode(newSyncCode())}>
                  New code
                </button>
              </div>
              <span className="small muted">First device: press New code. Other devices: enter the same code.</span>
            </div>
            {error && <p className="small error-text">{error}</p>}
            <button type="button" className="btn primary" onClick={start}>
              Start syncing
            </button>
          </>
        )}
      </Section>
      <AlwaysOnServer />
    </div>
  );
}

/** The always-on server for routines (ADT_AGENT_TOKEN on the server). */
function AlwaysOnServer() {
  const server = useStore((s) => s.settings.server);
  const syncServer = useStore((s) => s.settings.sync.server);
  const [url, setUrl] = useState(server.url || syncServer);
  const [token, setToken] = useState(server.token);
  const [state, setState] = useState<{ busy?: boolean; ok?: string; error?: string }>({});
  const save = async () => {
    setState({ busy: true });
    updateSettings({ server: { url: url.trim().replace(/\/+$/, ""), token: token.trim() } });
    try {
      const count = await testServer();
      setState({ ok: `Connected. The server has ${count} routine${count === 1 ? "" : "s"}.` });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return (
    <Section
      title="Always-on server"
      hint="Your ADT Bot server can run routines while your computers are off: on a schedule, when a feed posts or a page changes, or when its webhook is called from anywhere. Start it with ADT_AGENT_TOKEN set (24+ random characters) and enter the same token here; then tick “Run on my always-on server” on a routine."
    >
      <div className="field">
        <label htmlFor="agent-url">Server address</label>
        <input id="agent-url" className="input" placeholder="https://adtbot.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="agent-token">Server token (ADT_AGENT_TOKEN)</label>
        <input id="agent-token" className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
      </div>
      {state.ok && <p className="small muted">{state.ok}</p>}
      {state.error && <p className="small error-text">{state.error}</p>}
      <div className="btn-row">
        <button type="button" className="btn primary" disabled={state.busy || !url.trim() || token.trim().length < 24} onClick={() => void save()}>
          {state.busy && <Loader2 size={14} className="spin" />} Save and test
        </button>
        {server.url && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              updateSettings({ server: { url: "", token: "" } });
              setToken("");
              setState({});
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      {server.url && server.token && <ServerBrowser />}
    </Section>
  );
}
