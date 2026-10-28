const { contextBridge, ipcRenderer } = require("electron");

// Tells the web app it runs on desktop, so provider calls go through the built-in relay, and gives
// it a narrow bridge to desktop features (electron/features/*.cjs). Only "adt:" channels pass.
const allowed = (channel) => typeof channel === "string" && channel.startsWith("adt:");

// While a bot's click, drag or scroll runs (Control this PC on Linux), the page drops pointer input:
// what the desktop delivers here then is the bot's, and must not press ADT Bot's own buttons (an
// Allow, a setting). Main stops keys itself. Not an "adt:" channel, so the page can't reach it.
let shielded = false;
const drop = (event) => {
  if (!shielded) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "wheel", "touchstart", "touchend", "dragstart", "dragenter", "dragover", "drop"]) {
  window.addEventListener(type, drop, { capture: true, passive: false });
}
ipcRenderer.on("adt-shield", (_event, on) => {
  shielded = on === true;
  ipcRenderer.send("adt-shield-ack");
});

contextBridge.exposeInMainWorld("adtbotDesktop", {
  proxyToken: "",
  platform: process.platform,
  version: process.versions.electron,
  invoke: (channel, payload) => {
    if (!allowed(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, listener) => {
    if (!allowed(channel)) throw new Error(`Blocked channel ${channel}`);
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
