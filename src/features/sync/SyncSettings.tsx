import { Copy, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Section } from "../../components/settings/controls";
import { updateSettings, useStore } from "../../lib/store";
import { newSyncCode, normaliseCode, syncCodeProblem } from "../../lib/sync";
import { resetSync, syncNow, useSyncStatus } from "./engine";

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
        hint="Your bots, chats, skills, memories and profile, on every device where you use the same sync code. They travel through your own ADT Bot server (npm start, or the Docker image) end-to-end encrypted: the server only stores scrambled data and never sees the code. API keys stay on each device unless you choose to sync them too."
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
                onClick={() => {
                  if (!confirm("Stop syncing this device? Nothing is deleted here or on the server.")) return;
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
    </div>
  );
}
