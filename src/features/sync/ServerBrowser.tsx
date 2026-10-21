import { ArrowLeft, ArrowDown, ArrowUp, Globe, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { call, problem } from "../automation/server-routines";
import "./sync.css";

/** The server's browser page is this size; clicks on the picture are scaled to it. */
const PAGE = { width: 1280, height: 900 };

async function input(body: Record<string, unknown>): Promise<{ url?: string; title?: string }> {
  const res = await call("/api/agent/browser/input", { method: "POST", body });
  if (!res.ok) throw await problem(res);
  return res.json();
}

/**
 * Settings → Sync & server → Server browser: your always-on server's browser, to sign in to sites
 * routines use (they stay signed in). A picture of the page; clicks, typing and keys go to it.
 */
export function ServerBrowser() {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState("");
  const [address, setAddress] = useState("");
  const [title, setTitle] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shotRef = useRef("");

  const refresh = useCallback(async () => {
    try {
      const res = await call("/api/agent/browser/screen");
      if (!res.ok) throw await problem(res);
      const url = URL.createObjectURL(await res.blob());
      if (shotRef.current) URL.revokeObjectURL(shotRef.current);
      shotRef.current = url;
      setShot(url);
    } catch (e) {
      // A picture that didn't come doesn't hide what the last action said.
      setError((current) => current || (e as Error).message);
    }
  }, []);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const where = await input(body);
      if (where.url) setAddress(where.url === "about:blank" ? "" : where.url);
      setTitle(where.title ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const res = await call("/api/agent/browser");
        if (!res.ok) throw await problem(res);
        const where = (await res.json()) as { url?: string; title?: string };
        setAddress(where.url && where.url !== "about:blank" ? where.url : "");
        setTitle(where.title ?? "");
      } catch (e) {
        setError((e as Error).message);
      }
      void refresh();
    })();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => () => void (shotRef.current && URL.revokeObjectURL(shotRef.current)), []);

  if (!open) {
    return (
      <div className="server-browser-closed">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          <Globe size={14} /> Open the server browser
        </button>
        <span className="small muted">
          Sign in to sites your routines use (shops, dashboards, accounts); they stay signed in on the server. Bots never type passwords themselves.
        </span>
      </div>
    );
  }

  return (
    <div className="server-browser">
      <form
        className="input-group"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void act({ action: "open", url: address.trim() });
        }}
      >
        <button type="button" className="btn" title="Back" aria-label="Back" onClick={() => void act({ action: "back" })}>
          <ArrowLeft size={14} />
        </button>
        <input className="input" aria-label="Address" placeholder="https://…" value={address} onChange={(e) => setAddress(e.target.value)} />
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : "Go"}
        </button>
        <button type="button" className="btn" title="Close" aria-label="Close the server browser" onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </form>
      {title && <div className="small muted ellipsis">{title}</div>}
      <div className="server-browser-screen">
        {shot ? (
          <img
            src={shot}
            alt="The server browser's page. Click to click there."
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              void act({ action: "click", x: Math.round(((e.clientX - box.left) * PAGE.width) / box.width), y: Math.round(((e.clientY - box.top) * PAGE.height) / box.height) });
            }}
          />
        ) : (
          <div className="small muted">Starting the browser…</div>
        )}
      </div>
      <form
        className="input-group"
        onSubmit={(e) => {
          e.preventDefault();
          if (!typed) return;
          void act({ action: "type", text: typed });
          setTyped("");
        }}
      >
        <input className="input" aria-label="Text to type" placeholder="Click a field above, then type here (passwords too)" type="password" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        <button type="submit" className="btn">
          Type
        </button>
        {["Enter", "Tab", "Backspace"].map((key) => (
          <button key={key} type="button" className="btn" onClick={() => void act({ action: "key", key })}>
            {key}
          </button>
        ))}
        <button type="button" className="btn" title="Scroll up" aria-label="Scroll up" onClick={() => void act({ action: "scroll", dy: -600 })}>
          <ArrowUp size={14} />
        </button>
        <button type="button" className="btn" title="Scroll down" aria-label="Scroll down" onClick={() => void act({ action: "scroll", dy: 600 })}>
          <ArrowDown size={14} />
        </button>
      </form>
      {error && <p className="small error-text">{error}</p>}
      <p className="small muted">What you type goes to the server as you send it. Use the server over HTTPS when it's not on your own network.</p>
    </div>
  );
}
