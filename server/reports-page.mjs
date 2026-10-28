// The developer's voice report inbox page (/reports, server/reports.mjs). Everything it shows comes
// from reports anyone could send, so it's only ever put on the page as text, under a strict CSP.
import { createHash } from "node:crypto";

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1f; --muted: #6b6b70; --line: #e2e2e0; --accent: #2563eb; --bad: #c62828; }
@media (prefers-color-scheme: dark) { :root { --bg: #151517; --card: #1f1f22; --text: #ececee; --muted: #9a9aa2; --line: #333338; --accent: #6b9cff; --bad: #ff6b6b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
form, .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
input { font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); min-width: 0; }
input[type=password] { flex: 1 1 260px; }
#search { flex: 1 1 200px; }
button { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.bad { color: var(--bad); }
.layout { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 14px; }
@media (max-width: 760px) { .layout { grid-template-columns: minmax(0, 1fr); } }
#list { display: flex; flex-direction: column; gap: 6px; }
.item { text-align: left; display: block; width: 100%; padding: 10px 12px; }
.item[aria-current=true] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.item .top { display: flex; justify-content: space-between; gap: 8px; }
.item .note { display: block; margin-top: 3px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
#detail { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-height: 200px; }
#detail audio { width: 100%; margin: 10px 0; }
pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 10px 0 0; max-height: 70vh; overflow: auto; }
.error { color: var(--bad); }
[hidden] { display: none !important; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};
const SYSTEMS = { darwin: "macOS", win32: "Windows", linux: "Linux" };
let token = "";
let reports = [];
let current = null;
let audioUrl = "";
try { token = sessionStorage.getItem("adt-reports-token") || ""; } catch {}

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { authorization: "Bearer " + token } });
  if (res.status === 401) { showLogin("That token didn't work."); throw new Error("401"); }
  if (!res.ok && res.status !== 204) throw new Error((await res.json().catch(() => null))?.error || "Error " + res.status);
  return res;
}
function showLogin(message) {
  $("login").hidden = false;
  $("inbox").hidden = true;
  $("login-error").textContent = message || "";
}
function size(bytes) { return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB"; }
function when(at) { return new Date(at).toLocaleString(); }

async function load() {
  $("status").textContent = "Loading…";
  try {
    const data = await (await api("/api/reports")).json();
    reports = data.reports;
    $("login").hidden = true;
    $("inbox").hidden = false;
    $("status").textContent = reports.length + (reports.length === 1 ? " report" : " reports") + " · each is deleted after " + data.keepDays + " days";
    render();
    if (current && !reports.some((r) => r.id === current.id)) clearDetail();
  } catch (e) {
    if (e.message !== "401") $("status").textContent = e.message;
  }
}
function render() {
  const q = $("search").value.trim().toLowerCase();
  const shown = reports.filter((r) => !q || [r.code, r.note, r.version, SYSTEMS[r.platform] || r.platform].join(" ").toLowerCase().includes(q));
  $("list").replaceChildren(...shown.map((r) => {
    const top = el("span", { className: "top" }, el("span", { className: "code", textContent: r.code }), el("span", { className: "small muted", textContent: when(r.at) }));
    const meta = el("span", { className: "small muted", textContent: [r.version && "ADT Bot " + r.version, SYSTEMS[r.platform] || r.platform, r.arch, size(r.size)].filter(Boolean).join(" · ") + " " });
    if (r.voice) meta.append(el("span", { className: "badge", textContent: "voice" }));
    const item = el("button", { type: "button", className: "item" }, top, meta, el("span", { className: "note small", textContent: r.note || "(no description)" }));
    item.setAttribute("aria-current", String(current?.id === r.id));
    item.addEventListener("click", () => open(r));
    return item;
  }));
  $("empty").hidden = shown.length > 0;
}
function clearDetail() {
  current = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = "";
  $("detail").replaceChildren(el("p", { className: "muted", textContent: "Pick a report." }));
}
async function open(r) {
  clearDetail();
  current = r;
  render();
  const head = el("div", { className: "bar" }, el("span", { className: "code", textContent: r.code }), el("span", { className: "small muted", textContent: when(r.at) }));
  const download = el("button", { type: "button", textContent: "Download" });
  const remove = el("button", { type: "button", className: "bad", textContent: "Delete" });
  head.append(download, remove);
  const text = el("pre", { textContent: "Loading…" });
  $("detail").replaceChildren(head, text);
  download.addEventListener("click", async () => {
    const blob = await (await api("/api/reports/" + r.id + "/download")).blob();
    const a = el("a", { href: URL.createObjectURL(blob), download: "ADT Bot voice report " + r.code + (r.zip ? ".zip" : ".txt") });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  remove.addEventListener("click", async () => {
    if (remove.dataset.sure !== "1") { remove.dataset.sure = "1"; remove.textContent = "Delete for good?"; return; }
    await api("/api/reports/" + r.id, { method: "DELETE" });
    clearDetail();
    await load();
  });
  try {
    text.textContent = await (await api("/api/reports/" + r.id + "/report.txt")).text();
    if (r.voice && current?.id === r.id) {
      audioUrl = URL.createObjectURL(await (await api("/api/reports/" + r.id + "/bot-voice.wav")).blob());
      const audio = el("audio", { controls: true, src: audioUrl });
      audio.setAttribute("aria-label", "The bot's voice in this report");
      head.after(audio);
    }
  } catch (e) {
    text.textContent = "";
    text.after(el("p", { className: "error", textContent: e.message }));
  }
}
$("login").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  try { sessionStorage.setItem("adt-reports-token", token); } catch {}
  void load();
});
$("refresh").addEventListener("click", () => void load());
$("signout").addEventListener("click", () => { token = ""; try { sessionStorage.removeItem("adt-reports-token"); } catch {} clearDetail(); showLogin(); });
$("search").addEventListener("input", render);
clearDetail();
if (token) void load(); else showLogin();
`;

const BODY = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Voice Reports</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Voice reports</h1>
<p class="muted small">Sent from ADT Bot's Settings → Voice → Save a voice report. What people said may be in them: keep them to yourself.</p>
<form id="login" hidden>
  <input id="token" type="password" placeholder="Inbox token (ADT_REPORTS_TOKEN)" autocomplete="current-password" aria-label="Inbox token" required>
  <button class="primary" type="submit">Open inbox</button>
  <span id="login-error" class="error small" role="alert"></span>
</form>
<section id="inbox" hidden>
  <div class="bar">
    <input id="search" type="search" placeholder="Find a code or words in the description" aria-label="Find a report">
    <button id="refresh" type="button">Refresh</button>
    <button id="signout" type="button">Lock</button>
  </div>
  <p id="status" class="small muted" role="status"></p>
  <div class="layout">
    <div><div id="list"></div><p id="empty" class="muted" hidden>No reports.</p></div>
    <section id="detail" aria-live="polite"></section>
  </div>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;

const hash = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const PAGE = {
  html: BODY,
  csp: [
    "default-src 'none'",
    `script-src ${hash(SCRIPT)}`,
    `style-src ${hash(STYLE)}`,
    "connect-src 'self'",
    "media-src blob:",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
};

export function inboxPage() {
  return PAGE;
}
