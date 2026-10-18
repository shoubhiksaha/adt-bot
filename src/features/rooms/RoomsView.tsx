import { Bot as BotIcon, Eraser, Play, Plus, RefreshCw, Send, Square, Trash2, UserX, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "../../components/CopyButton";
import { ToolCalls } from "../../components/ToolCalls";
import { isDesktop } from "../../lib/desktop";
import { useStore } from "../../lib/store";
import { newPin, type RoomTools } from "./logic";
import {
  abortBots,
  clearRoom,
  createRoom,
  deleteRoom,
  hostSay,
  kickGuest,
  type LiveRoom,
  notice,
  type RoomConfig,
  startRoom,
  stopRoom,
  updateRoom,
  useRooms,
} from "./rooms";
import "./rooms.css";

export default function RoomsView() {
  const configs = useRooms((s) => s.configs);
  const selectedId = useRooms((s) => s.selectedId);
  const live = useRooms((s) => s.live);
  if (!isDesktop()) {
    return (
      <div className="empty rooms-empty">
        <Users size={30} />
        <h1>Rooms</h1>
        <p className="muted">
          Rooms let people on your network chat together with your bots from any browser, without installing anything. Hosting a
          room needs the ADT Bot desktop app (it runs a small server on your computer); guests just open the link it shows.
        </p>
      </div>
    );
  }
  const selected = configs.find((c) => c.id === selectedId) ?? configs[0];
  return (
    <div className="rooms">
      <aside className="rooms-list">
        <button type="button" className="btn primary" onClick={() => createRoom()}>
          <Plus size={15} /> New room
        </button>
        {configs.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`rooms-item${selected?.id === c.id ? " active" : ""}`}
            onClick={() => useRooms.setState({ selectedId: c.id })}
          >
            <span className={`rooms-dot${live[c.id] ? " on" : ""}`} aria-label={live[c.id] ? "Running" : "Stopped"} />
            <span className="grow">{c.name}</span>
            {live[c.id] && <span className="small muted">{live[c.id].guests.filter((g) => g.online).length}</span>}
          </button>
        ))}
      </aside>
      <section className="rooms-main">
        {selected ? (
          <RoomDetail key={selected.id} config={selected} live={live[selected.id]} />
        ) : (
          <div className="empty">
            <Users size={30} />
            <h1>Chat rooms on your network</h1>
            <p className="muted">
              Create a room, pick which bots join, then share the link or QR code. People on the same Wi-Fi open it in any browser,
              enter the PIN and chat with each other and your bots. Bots run here, with your keys; guests only see the messages.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function RoomDetail({ config, live }: { config: RoomConfig; live?: LiveRoom }) {
  const bots = useStore((s) => s.bots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = Boolean(live);

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      if (running) await stopRoom(config.id);
      else await startRoom(config);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="room-detail">
      <div className="room-head">
        <input
          className="input room-title"
          value={config.name}
          maxLength={60}
          disabled={running}
          aria-label="Room name"
          onChange={(e) => updateRoom(config.id, { name: e.target.value })}
        />
        <button type="button" className={`btn${running ? "" : " primary"}`} disabled={busy} onClick={toggle}>
          {running ? <Square size={14} /> : <Play size={14} />} {running ? "Stop room" : "Start room"}
        </button>
      </div>
      {error && <p className="status err">{error}</p>}

      {!running && (
        <div className="room-setup">
          <div className="field">
            <span className="field-label">Bots in this room</span>
            <div className="room-bots">
              {bots.map((b) => (
                <label key={b.id} className="toggle compact">
                  <input
                    type="checkbox"
                    checked={config.botIds.includes(b.id)}
                    onChange={(e) =>
                      updateRoom(config.id, { botIds: e.target.checked ? [...config.botIds, b.id] : config.botIds.filter((id) => id !== b.id) })
                    }
                  />
                  <span>{b.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="room-mode">When bots answer</label>
              <select id="room-mode" className="select" value={config.mode} onChange={(e) => updateRoom(config.id, { mode: e.target.value as RoomConfig["mode"] })}>
                <option value="mention">When @mentioned</option>
                <option value="all">Every message (first bot)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="room-tools">Bot tools</label>
              <select id="room-tools" className="select" value={config.tools} onChange={(e) => updateRoom(config.id, { tools: e.target.value as RoomTools })}>
                <option value="none">No tools</option>
                <option value="safe">Safe only (web search, time, calculator)</option>
                <option value="full">Full: guests' requests need my OK</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="room-pin">Room PIN</label>
            <div className="input-group room-pin-group">
              <input
                id="room-pin"
                className="input room-pin"
                inputMode="numeric"
                maxLength={6}
                value={config.pin}
                onChange={(e) => updateRoom(config.id, { pin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              />
              <button type="button" className="btn" title="New PIN" onClick={() => updateRoom(config.id, { pin: newPin() })}>
                <RefreshCw size={14} />
              </button>
            </div>
            {config.pin.length !== 6 && <span className="small muted">A new 6-digit PIN is generated if this isn't 6 digits.</span>}
          </div>
          <p className="small muted">
            Bots answer with your providers and keys on this computer. Their private memory, your profile and knowledge files are not used
            in rooms. The room is only reachable on your local network while it runs.
          </p>
          <div className="btn-row">
            <button type="button" className="btn danger" onClick={() => deleteRoom(config.id)}>
              <Trash2 size={14} /> Delete room
            </button>
          </div>
        </div>
      )}

      {live && <LivePanel config={config} live={live} />}
    </div>
  );
}

function LivePanel({ config, live }: { config: RoomConfig; live: LiveRoom }) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const [, tick] = useState(0);
  const { info } = live;

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [live.messages]);
  useEffect(() => {
    if (!live.typing) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, live.typing.until - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [live.typing]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    try {
      await hostSay(config.id, value);
    } catch (e) {
      notice(config.id, `Not sent: ${(e as Error).message}`);
      setText(value);
    }
  };
  const typing = live.typing && live.typing.until > Date.now() ? live.typing.name : "";
  const online = live.guests.filter((g) => g.online);

  return (
    <div className="room-live">
      <div className="room-share card">
        {info.qr && <img className="room-qr" alt="QR code for the room link" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.qr)}`} />}
        <div className="room-share-text">
          <div className="room-pin-big">
            <span className="small muted">PIN</span> <strong>{info.pin}</strong> <CopyButton text={info.pin} className="icon-btn" />
          </div>
          {!info.lanAvailable && <p className="status err">No local network found: only this computer can open the room. Connect to Wi-Fi or Ethernet and restart the room.</p>}
          <ul className="room-urls">
            {info.urls.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
                <CopyButton text={url} className="icon-btn" />
              </li>
            ))}
          </ul>
          <p className="small muted">People on the same network scan the code or open the link, then enter the PIN. Up to 20 guests.</p>
        </div>
      </div>

      <div className="room-people">
        <span className="small muted">
          {online.length} online{live.guests.length > online.length ? `, ${live.guests.length - online.length} away` : ""}
        </span>
        {live.guests.map((g) => (
          <span key={g.id} className={`room-chip${g.online ? "" : " away"}`}>
            {g.name}
            <button type="button" className="room-kick" title={`Remove ${g.name}`} aria-label={`Remove ${g.name}`} onClick={() => void kickGuest(config.id, g.id)}>
              <UserX size={13} />
            </button>
          </span>
        ))}
      </div>

      {live.notices.length > 0 && (
        <details className="room-notices">
          <summary className="small muted">Room log ({live.notices.length})</summary>
          {live.notices.map((n, i) => (
            <div key={i} className="small muted">
              {n}
            </div>
          ))}
        </details>
      )}

      {live.request && (
        <div className="card room-request">
          <p>
            <strong>{live.request.guestName}</strong> asked <strong>{live.request.botName}</strong>: “{live.request.text.slice(0, 300)}”
          </p>
          <p className="small muted">Let the bot use all its tools for this reply (actions still ask you)? Otherwise it answers with safe tools only.</p>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={() => live.request?.resolve(true)}>
              Allow full tools
            </button>
            <button type="button" className="btn" onClick={() => live.request?.resolve(false)}>
              Safe tools only
            </button>
          </div>
        </div>
      )}
      {live.calls.length > 0 && <ToolCalls calls={live.calls} live={Boolean(live.busy)} />}

      <ol className="room-transcript" ref={listRef}>
        {live.messages.length === 0 && <li className="small muted room-empty">No messages yet.</li>}
        {live.messages.map((m) => (
          <li key={m.id} className={`room-msg ${m.kind}${m.pending ? " pending" : ""}`}>
            <div className="room-meta">
              {m.kind === "bot" && <BotIcon size={12} />}
              <span>{m.kind === "host" ? `${m.author} (you)` : m.author}</span>
              <time>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            <div className="room-bubble">{m.text || (m.pending ? "…" : "")}</div>
          </li>
        ))}
      </ol>
      <div className="room-typing small muted">{typing ? `${typing} is typing…` : live.busy ? `${live.busy} is answering…` : ""}</div>

      <form
        className="room-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="input"
          value={text}
          maxLength={4000}
          placeholder={`Message the room${config.botIds.length ? " (@name asks a bot)" : ""}`}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={!text.trim()} aria-label="Send">
          <Send size={14} />
        </button>
      </form>
      <div className="btn-row room-actions">
        {live.busy && (
          <button type="button" className="btn" onClick={() => abortBots(config.id)}>
            <Square size={14} /> Stop bot
          </button>
        )}
        <button type="button" className="btn" onClick={() => void clearRoom(config.id)}>
          <Eraser size={14} /> Clear history
        </button>
      </div>
    </div>
  );
}
