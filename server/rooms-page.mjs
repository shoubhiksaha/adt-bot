// The guest web page for LAN rooms: plain HTML/CSS/JS, no build step, no external requests.
// Everything people type is rendered with textContent, never as HTML.

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** @param {{ roomName: string, brand: string, missing?: boolean }} options */
export function guestHtml({ roomName, brand, missing = false }) {
  const body = missing
    ? `<main class="center"><section class="card"><h1>Room not found</h1><p class="muted">This room has closed or the link is wrong. Ask the host for a new link.</p></section></main>`
    : `<header class="top">
  <div class="titles"><span class="brand">${esc(brand)}</span><h1 id="room-name">${esc(roomName)}</h1></div>
  <button type="button" id="leave" class="ghost" hidden>Leave</button>
</header>
<main id="join-view" class="center">
  <form id="join-form" class="card" autocomplete="off" novalidate>
    <h2>Join the room</h2>
    <p class="muted">You're joining <strong>${esc(roomName)}</strong> on this network. Ask the host for the PIN.</p>
    <label for="name">Your name</label>
    <input id="name" name="name" maxlength="32" required autocomplete="nickname" enterkeyhint="next">
    <label for="pin">Room PIN</label>
    <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autocomplete="one-time-code" enterkeyhint="go">
    <p id="join-error" class="error" role="alert" hidden></p>
    <button type="submit" id="join-btn" class="primary">Join</button>
  </form>
</main>
<main id="chat-view" class="chat" hidden>
  <div id="people" class="people" aria-label="People in the room"></div>
  <div id="status" class="status" role="status" hidden></div>
  <ol id="messages" class="messages" aria-live="polite"></ol>
  <div id="typing" class="typing" aria-live="polite"></div>
  <form id="send-form" class="composer">
    <textarea id="text" rows="1" placeholder="Message the room" maxlength="2000" enterkeyhint="send" aria-label="Message"></textarea>
    <button type="submit" class="primary" id="send-btn">Send</button>
  </form>
  <p id="hint" class="hint muted"></p>
  <p id="send-error" class="error" role="alert" hidden></p>
</main>
<main id="ended-view" class="center" hidden>
  <section class="card"><h2 id="ended-title">Room closed</h2><p id="ended-text" class="muted"></p><button type="button" id="rejoin" class="primary">Join again</button></section>
</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(roomName)} · ${esc(brand)}</title>
<link rel="stylesheet" href="/room-assets/room.css">
<script src="/room-assets/room.js" defer></script>
</head>
<body>
${body}
</body>
</html>`;
}

export const guestCss = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#18181a;--card:#fff;--muted:#6b6b70;--line:#e2e2de;--me:#e8eefc;--bot:#f1f1ee;--accent:#1f6feb;--accent-fg:#fff;--error:#c42b2b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--fg:#ececee;--card:#17181b;--muted:#8d8d93;--line:#26282d;--me:#1d2a44;--bot:#1d1e22;--accent:#4c8dff;--accent-fg:#0b0c0e;--error:#ff6b6b}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;-webkit-text-size-adjust:100%}
[hidden]{display:none!important}
.top{display:flex;align-items:center;gap:12px;padding:10px 16px;padding-top:max(10px,env(safe-area-inset-top));border-bottom:1px solid var(--line);background:var(--card)}
.titles{flex:1;min-width:0}
.brand{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
h1{font-size:18px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
h2{margin:0 0 6px;font-size:20px}
.center{flex:1;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:8px}
.muted{color:var(--muted)}
label{font-size:14px;font-weight:600;margin-top:6px}
input,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
#pin{letter-spacing:.3em;font-variant-numeric:tabular-nums}
button{font:inherit;border-radius:10px;padding:10px 16px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
button.ghost{padding:6px 12px;font-size:14px}
button:disabled{opacity:.6;cursor:default}
.error{color:var(--error);margin:4px 0 0;font-size:14px}
.chat{flex:1;display:flex;flex-direction:column;min-height:0;width:100%;max-width:820px;margin:0 auto}
.people{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px 0}
.chip{font-size:13px;border:1px solid var(--line);border-radius:999px;padding:2px 10px;background:var(--card);display:inline-flex;align-items:center;gap:6px}
.chip.bot{cursor:pointer}
.chip .dot{width:7px;height:7px;border-radius:50%;background:#3fb950}
.chip.away .dot{background:var(--muted)}
.tag{font-size:10px;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line);border-radius:4px;padding:0 4px;color:var(--muted)}
.status{margin:8px 16px 0;padding:6px 10px;border-radius:8px;background:var(--bot);font-size:14px;color:var(--muted)}
.messages{list-style:none;margin:0;padding:12px 16px;flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}
.msg{max-width:85%;align-self:flex-start;display:flex;flex-direction:column;gap:2px}
.msg.mine{align-self:flex-end;align-items:flex-end}
.msg.system{align-self:center;color:var(--muted);font-size:13px}
.meta{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}
.bubble{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.mine .bubble{background:var(--me);border-color:transparent}
.bot .bubble{background:var(--bot)}
.pending .bubble:empty::after{content:"…";animation:blink 1s infinite}
@keyframes blink{50%{opacity:.3}}
.typing{min-height:20px;font-size:13px;color:var(--muted);padding:0 16px}
.composer{display:flex;gap:8px;padding:8px 16px;align-items:flex-end}
.composer textarea{resize:none;max-height:160px;min-height:44px}
.hint{font-size:12px;margin:0;padding:0 16px max(10px,env(safe-area-inset-bottom))}
`;

export const guestJs = `"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "r" || !parts[1] || !$("join-form")) return;
  const roomId = parts[1];
  const base = "/r/" + encodeURIComponent(roomId);
  const KEY = "adt-room:" + roomId;
  let token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch {}
  let me = null;
  let room = null;
  let source = null;
  let messages = new Map();
  const typing = new Map();
  let msgLimit = 2000;

  const show = (view) => {
    for (const v of ["join-view", "chat-view", "ended-view"]) $(v).hidden = v !== view;
    $("leave").hidden = view !== "chat-view";
  };
  const setError = (id, text) => { const el = $(id); el.textContent = text || ""; el.hidden = !text; };
  const saveToken = (value) => { token = value; try { value ? sessionStorage.setItem(KEY, value) : sessionStorage.removeItem(KEY); } catch {} };
  try { $("name").value = localStorage.getItem("adt-room-name") || ""; } catch {}

  async function post(path, body) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body || {}), cache: "no-store" });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("name").value.trim();
    const pin = $("pin").value.replace(/\\s+/g, "");
    if (!name) return setError("join-error", "Enter your name.");
    if (!/^\\d{6}$/.test(pin)) return setError("join-error", "The PIN has 6 digits.");
    $("join-btn").disabled = true;
    setError("join-error", "");
    try {
      const { ok, data } = await post("/join", { name, pin });
      if (!ok) {
        let text = data.error || "Couldn't join.";
        if (typeof data.attemptsLeft === "number" && data.attemptsLeft > 0) text += " " + data.attemptsLeft + " tries left.";
        setError("join-error", text);
        return;
      }
      try { localStorage.setItem("adt-room-name", name); } catch {}
      saveToken(data.token);
      $("pin").value = "";
      connect();
    } catch {
      setError("join-error", "Can't reach the room. Are you on the same network?");
    } finally {
      $("join-btn").disabled = false;
    }
  });

  function status(text) { const el = $("status"); el.textContent = text || ""; el.hidden = !text; }

  function connect() {
    if (source) source.close();
    show("chat-view");
    status("Connecting…");
    source = new EventSource(base + "/events?token=" + encodeURIComponent(token));
    source.addEventListener("hello", (e) => {
      const data = JSON.parse(e.data);
      me = data.me; room = data.room; msgLimit = (room.limits && room.limits.message) || 2000;
      $("text").maxLength = msgLimit;
      $("room-name").textContent = room.name;
      $("messages").textContent = "";
      messages = new Map();
      for (const m of data.history) addMessage(m);
      renderPeople(data.guests);
      renderHint();
      status("");
      scrollDown(true);
    });
    source.addEventListener("message", (e) => { const m = JSON.parse(e.data); typing.delete(m.author); renderTyping(); addMessage(m); scrollDown(m.authorId === (me && me.id)); });
    source.addEventListener("update", (e) => {
      const d = JSON.parse(e.data);
      const el = messages.get(d.id);
      if (!el) return;
      const near = nearBottom();
      el.querySelector(".bubble").textContent = d.text;
      el.classList.toggle("pending", !d.done);
      if (near) scrollDown(true);
    });
    source.addEventListener("presence", (e) => renderPeople(JSON.parse(e.data).guests));
    source.addEventListener("typing", (e) => {
      const d = JSON.parse(e.data);
      typing.set(d.name, Date.now() + 4000);
      renderTyping();
      setTimeout(renderTyping, 4100);
    });
    source.addEventListener("cleared", () => { $("messages").textContent = ""; messages = new Map(); });
    source.addEventListener("kicked", () => end("Removed from the room", "The host removed you from this room.", false));
    source.addEventListener("bye", () => end("You left the room", "", true));
    source.addEventListener("closed", (e) => end("Room closed", JSON.parse(e.data).reason || "The host closed the room.", false));
    source.onerror = () => {
      if (!source) return;
      if (source.readyState === EventSource.CLOSED) {
        source.close(); source = null;
        saveToken("");
        show("join-view");
        setError("join-error", "Please join again.");
      } else status("Connection lost. Reconnecting…");
    };
  }

  function end(title, text, canRejoin) {
    if (source) { source.close(); source = null; }
    saveToken("");
    $("ended-title").textContent = title;
    $("ended-text").textContent = text;
    $("rejoin").hidden = !canRejoin;
    show("ended-view");
  }
  $("rejoin").addEventListener("click", () => show("join-view"));
  $("leave").addEventListener("click", async () => { try { await post("/leave"); } catch {} end("You left the room", "", true); });

  function nearBottom() { const list = $("messages"); return list.scrollHeight - list.scrollTop - list.clientHeight < 120; }
  function scrollDown(force) { const list = $("messages"); if (force || nearBottom()) list.scrollTop = list.scrollHeight; }

  function addMessage(m) {
    if (messages.has(m.id)) return;
    const li = document.createElement("li");
    li.className = "msg " + m.kind + (me && m.authorId === me.id ? " mine" : "") + (m.pending ? " pending" : "");
    li.dataset.id = m.id;
    if (m.kind !== "system") {
      const meta = document.createElement("div");
      meta.className = "meta";
      const who = document.createElement("span");
      who.textContent = me && m.authorId === me.id ? "You" : m.author;
      meta.append(who);
      if (m.kind === "bot" || m.kind === "host") { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = m.kind; meta.append(tag); }
      const time = document.createElement("time");
      time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      meta.append(time);
      li.append(meta);
    }
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;
    li.append(bubble);
    $("messages").append(li);
    messages.set(m.id, li);
    while (messages.size > 400) { const [first, el] = messages.entries().next().value; el.remove(); messages.delete(first); }
  }

  function chip(text, cls, tag) {
    const el = document.createElement(cls.includes("bot") ? "button" : "span");
    if (el.tagName === "BUTTON") el.type = "button";
    el.className = "chip " + cls;
    const dot = document.createElement("span"); dot.className = "dot";
    const label = document.createElement("span"); label.textContent = text;
    el.append(dot, label);
    if (tag) { const t = document.createElement("span"); t.className = "tag"; t.textContent = tag; el.append(t); }
    return el;
  }

  function renderPeople(guests) {
    const box = $("people");
    box.textContent = "";
    if (room) {
      box.append(chip(room.hostName, "host", "host"));
      for (const bot of room.bots) {
        const el = chip(bot.name, "bot", "bot");
        el.title = "Ask " + bot.name;
        el.addEventListener("click", () => { const t = $("text"); t.value = ("@" + bot.name + " " + t.value).slice(0, msgLimit); t.focus(); });
        box.append(el);
      }
    }
    for (const g of guests) box.append(chip(me && g.id === me.id ? g.name + " (you)" : g.name, g.online ? "" : "away"));
  }

  function renderHint() {
    const bots = (room && room.bots) || [];
    $("hint").textContent = bots.length ? "Type @" + bots[0].name + " to ask a bot. Enter sends, Shift+Enter adds a line." : "Enter sends, Shift+Enter adds a line.";
  }

  function renderTyping() {
    const now = Date.now();
    const names = [];
    for (const [name, until] of typing) { if (until > now) names.push(name); else typing.delete(name); }
    $("typing").textContent = names.length ? names.slice(0, 3).join(", ") + (names.length === 1 ? " is typing…" : " are typing…") : "";
  }

  let lastTyping = 0;
  const text = $("text");
  text.addEventListener("input", () => {
    text.style.height = "auto";
    text.style.height = Math.min(text.scrollHeight, 160) + "px";
    const now = Date.now();
    if (text.value && now - lastTyping > 2500) { lastTyping = now; post("/typing").catch(() => {}); }
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("send-form").requestSubmit(); }
  });
  $("send-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    $("send-btn").disabled = true;
    setError("send-error", "");
    try {
      const { ok, status: code, data } = await post("/send", { text: value });
      if (ok) { text.value = ""; text.style.height = "auto"; }
      else if (code === 401) { saveToken(""); show("join-view"); setError("join-error", "Please join again."); }
      else setError("send-error", data.error || "Not sent.");
    } catch {
      setError("send-error", "Not sent: the room can't be reached.");
    } finally {
      $("send-btn").disabled = false;
      text.focus();
    }
  });

  if (token) connect(); else show("join-view");
})();
`;
