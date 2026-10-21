import { Loader2, Play, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BotAvatar } from "../../components/Avatar";
import { askConfirm, confirmThen } from "../../components/Confirm";
import { useStore } from "../../lib/store";
import type { Bot } from "../../lib/types";
import { type ComputerInfo, computers, type EngineStatus, onBuild } from "./api";
import { ComputerTerminal } from "./ComputerTerminal";
import { EngineLine } from "./ComputersSettings";
import { FileBrowser } from "./FileBrowser";
import { DEFAULT_CONFIG, forgetComputer, loadComputers, setComputerConfig, useComputers } from "./store";
import "./computers.css";

const STATE_LABEL: Record<string, string> = { running: "Running", exited: "Stopped", created: "Stopped", paused: "Paused", restarting: "Restarting", dead: "Broken", missing: "Not created yet" };

export default function ComputersView() {
  const bots = useStore((s) => s.bots);
  const configs = useComputers((s) => s.configs);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [list, setList] = useState<ComputerInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [buildLog, setBuildLog] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    const status = await computers.status().catch(() => null);
    setEngine(status);
    if (status?.running) setList(await computers.list().catch(() => []));
  }, []);

  useEffect(() => {
    void loadComputers();
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    const off = onBuild((e) => setBuildLog((log) => `${log}${e.chunk}`.slice(-20_000)));
    return () => {
      clearInterval(timer);
      off();
    };
  }, [refresh]);

  // Bots with a computer switched on, plus containers left behind by bots that no longer have one.
  const rows = useMemo(() => {
    const enabled = bots.filter((b) => configs[b.id]?.enabled).map((bot) => ({ botId: bot.id, bot, info: list.find((c) => c.botId === bot.id) }));
    const orphans = list.filter((c) => !enabled.some((r) => r.botId === c.botId)).map((info) => ({ botId: info.botId, bot: bots.find((b) => b.id === info.botId), info }));
    return [...enabled, ...orphans];
  }, [bots, configs, list]);

  const current = rows.find((r) => r.botId === selected && r.bot && configs[r.botId]?.enabled);

  return (
    <div className="computers">
      <p className="small muted">
        Each bot can have its own Linux computer (a Docker container on this machine). Switch it on per bot in Settings → Computers.
      </p>
      <div className="computers-engine-row">
        <div className="grow">
          <EngineLine engine={engine} onRefresh={() => void refresh()} />
        </div>
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={15} />
        </button>
      </div>

      {buildLog && (
        <details className="computers-build" open>
          <summary className="small">Image build log</summary>
          <pre>{buildLog}</pre>
          <button type="button" className="btn computers-link" onClick={() => setBuildLog("")}>
            Hide
          </button>
        </details>
      )}

      {engine?.running && !rows.length && (
        <div className="computers-empty">
          <h2>No bot computers yet</h2>
          <p className="muted small">Open Settings → Computers and switch on "Give this bot its own computer" for a bot.</p>
        </div>
      )}

      {engine?.running && (
        <ul className="computers-list">
          {rows.map((row) => (
            <ComputerCard
              key={row.botId}
              botId={row.botId}
              bot={row.bot}
              info={row.info}
              enabled={Boolean(configs[row.botId]?.enabled)}
              selected={selected === row.botId}
              onSelect={() => setSelected(row.botId)}
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      )}

      {engine?.running && current?.bot && (
        <section className="cframe">
          <div className="cframe-head">
            <h3>
              {current.bot.name}'s computer
              <span className={`cframe-badge ${current.info?.state === "running" ? "" : "off"}`}>{STATE_LABEL[current.info?.state ?? "missing"] ?? current.info?.state}</span>
            </h3>
          </div>
          <div className="computers-panels">
            <ComputerTerminal
              botId={current.botId}
              botName={current.bot.name}
              admin={Boolean({ ...DEFAULT_CONFIG, ...configs[current.botId] }.admin)}
              onRan={() => {
                setRefreshKey((n) => n + 1);
                void refresh();
              }}
            />
            <FileBrowser botId={current.botId} refreshKey={refreshKey} />
          </div>
        </section>
      )}
    </div>
  );
}

function ComputerCard({
  botId,
  bot,
  info,
  enabled,
  selected,
  onSelect,
  onChanged,
}: {
  botId: string;
  bot?: Bot;
  info?: ComputerInfo;
  enabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const state = info?.state ?? "missing";
  const running = state === "running";

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const name = bot?.name ?? "Deleted bot";
  return (
    <li className={`computers-card${selected ? " selected" : ""}`}>
      <div className="computers-card-top">
        {bot ? <BotAvatar bot={bot} /> : <span className="avatar" aria-hidden />}
        <div className="grow">
          <div className="computers-card-name">
            <strong>{name}</strong>
            <span className={`computers-chip ${running ? "on" : ""}`}>{STATE_LABEL[state] ?? state}</span>
            {!enabled && <span className="computers-chip">Switched off</span>}
          </div>
          <div className="small muted">
            {running && info?.cpu ? `CPU ${info.cpu} · Memory ${info.memory ?? "?"}` : info ? info.status : "Starts the first time the bot (or you) uses it."}
          </div>
          {error && <div className="small error-text">{error}</div>}
        </div>
      </div>
      <div className="btn-row">
        {enabled && bot && (
          <button type="button" className="btn primary" onClick={onSelect} disabled={selected}>
            Open
          </button>
        )}
        {enabled && !running && (
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void act("start", () => computers.start(botId))}>
            {busy === "start" ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Start
          </button>
        )}
        {running && (
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void act("stop", () => computers.stop(botId))}>
            {busy === "stop" ? <Loader2 size={14} className="spin" /> : <Square size={14} />} Stop
          </button>
        )}
        {enabled && info && (
          <button
            type="button"
            className="btn"
            disabled={Boolean(busy)}
            title="A fresh computer from the image; files in /workspace are kept"
            onClick={() => void act("reset", () => computers.reset(botId, false))}
          >
            {busy === "reset" ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} Reset
          </button>
        )}
        {enabled && info && (
          <button
            type="button"
            className="btn danger"
            disabled={Boolean(busy)}
            onClick={() => {
              confirmThen({ message: `Wipe ${name}'s computer?`, detail: "Everything in /workspace is deleted and it starts fresh.", confirm: "Wipe", danger: true }, () => act("wipe", () => computers.reset(botId, true)));
            }}
          >
            {busy === "wipe" ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} Wipe
          </button>
        )}
        {(info || enabled) && (
          <button
            type="button"
            className="btn danger"
            disabled={Boolean(busy)}
            onClick={async () => {
              const detail = enabled ? "The bot's computer will also be switched off." : undefined;
              if (!(await askConfirm({ message: `Delete ${name}'s computer and all its files?`, detail, confirm: "Delete", danger: true }))) return;
              void act("delete", async () => {
                await computers.remove(botId, true);
                if (bot) await setComputerConfig(botId, { enabled: false });
                else await forgetComputer(botId);
              });
            }}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}
