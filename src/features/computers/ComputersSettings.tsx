import { FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { BotAvatar } from "../../components/Avatar";
import { Section } from "../../components/settings/controls";
import { useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { computers, type EngineStatus } from "./api";
import { type ComputerConfig, DEFAULT_CONFIG, loadComputers, setComputerConfig, useComputers } from "./store";
import "./computers.css";

/** Settings → Computers: which bots get their own Docker computer, and how it is set up. */
export function ComputersSettings() {
  const bots = useStore((s) => s.bots);
  const loaded = useComputers((s) => s.loaded);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  useEffect(() => {
    void loadComputers();
    computers.status().then(setEngine, () => setEngine(null));
  }, []);

  return (
    <div className="computers-settings">
      <p className="small muted">
        Give a bot its own small Linux computer: a Docker container on this machine with its own files in <code>/workspace</code>. The bot can run
        commands, write code and keep files there without touching your computer. Each one is limited to 1 CPU, 1 GB of memory and 512 processes,
        and runs as a normal user with no special privileges. Commands that change things still ask you first, according to your approval settings.
      </p>
      <EngineLine engine={engine} />
      <Section title="Bots" hint="Bots also need the “Own computer” tool group switched on (it is, unless you picked specific groups for the bot).">
        {!loaded && <p className="small muted">Loading…</p>}
        {loaded && bots.map((bot) => <BotComputerSettings key={bot.id} bot={bot} />)}
      </Section>
    </div>
  );
}

export function EngineLine({ engine, onRefresh }: { engine: EngineStatus | null; onRefresh?: () => void }) {
  if (!engine) return <p className="small muted">Checking for Docker…</p>;
  if (engine.running) {
    return (
      <p className="small computers-engine ok">
        <span className="computers-dot" /> {engine.runtime} {engine.version ? `(engine ${engine.version})` : ""} is running.
      </p>
    );
  }
  return (
    <div className="computers-help">
      <strong>{engine.installed ? "Docker is installed but not running." : "Bot computers need Docker."}</strong>
      {engine.hints.map((h) => (
        <span key={h}>{renderHint(h)}</span>
      ))}
      {engine.error && <span className="small muted">{engine.error}</span>}
      {onRefresh && (
        <button type="button" className="btn" onClick={onRefresh}>
          Check again
        </button>
      )}
    </div>
  );
}

/** `code` spans in setup hints. */
function renderHint(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>));
}

function BotComputerSettings({ bot }: { bot: Bot }) {
  const saved = useComputers((s) => s.configs[bot.id]);
  const config: ComputerConfig = { ...DEFAULT_CONFIG, ...saved };
  const [error, setError] = useState("");
  const update = (patch: Partial<ComputerConfig>) => void setComputerConfig(bot.id, patch);
  const restartNote = config.enabled ? " Takes effect the next time the computer starts (files are kept)." : "";

  return (
    <div className={`computers-bot${config.enabled ? " on" : ""}`}>
      <label className="computers-bot-head">
        <BotAvatar bot={bot} size="mini" />
        <span className="grow">
          <strong>{bot.name}</strong>
          <br />
          <span className="small muted">Give this bot its own computer</span>
        </span>
        <span className="computers-switch">
          <input type="checkbox" checked={config.enabled} onChange={(e) => update({ enabled: e.target.checked })} aria-label={`Give ${bot.name} its own computer`} />
          <span />
        </span>
      </label>
      {config.enabled && (
        <div className="computers-bot-options">
          <label className="toggle compact">
            <input type="checkbox" checked={!config.network} onChange={(e) => update({ network: !e.target.checked })} />
            <span>
              No network <span className="small muted">— nothing inside can reach the internet or your network.{restartNote}</span>
            </span>
          </label>
          <label className="toggle compact">
            <input type="checkbox" checked={Boolean(config.browser)} onChange={(e) => update({ browser: e.target.checked })} />
            <span>
              Web browser <span className="small muted">— headless Chromium for computer_browse (bigger image, about 400 MB more).{restartNote}</span>
            </span>
          </label>
          <label className="toggle compact">
            <input type="checkbox" checked={Boolean(config.admin)} onChange={(e) => update({ admin: e.target.checked })} />
            <span>
              Let me install system packages <span className="small muted">— a root terminal for you on the Computers screen (apt-get). The bot still runs as a normal user.{restartNote}</span>
            </span>
          </label>
          <div className="computers-shared">
            <span className="small">
              Shared folder:{" "}
              {config.sharedFolder ? <code>{config.sharedFolder}</code> : <span className="muted">none</span>}
              {config.sharedFolder && <span className="muted"> → /shared{config.sharedWritable ? "" : " (read-only)"}</span>}
            </span>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setError("");
                  computers.pickFolder().then((r) => r.path && update({ sharedFolder: r.path }), (e: Error) => setError(e.message));
                }}
              >
                <FolderOpen size={14} /> {config.sharedFolder ? "Change" : "Choose folder"}
              </button>
              {config.sharedFolder && (
                <>
                  <label className="toggle compact computers-inline">
                    <input type="checkbox" checked={Boolean(config.sharedWritable)} onChange={(e) => update({ sharedWritable: e.target.checked })} />
                    <span className="small">Bot may change files there</span>
                  </label>
                  <button type="button" className="btn" onClick={() => update({ sharedFolder: undefined, sharedWritable: false })}>
                    <X size={14} /> Stop sharing
                  </button>
                </>
              )}
            </div>
            {error && <div className="small error-text">{error}</div>}
          </div>
          <p className="small muted">Manage it (start, stop, terminal, files) on the Computers screen in the sidebar.</p>
        </div>
      )}
    </div>
  );
}
