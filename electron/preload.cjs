const { contextBridge, ipcRenderer } = require("electron");

// Tells the web app it runs on desktop, so provider calls go through the built-in relay, and gives
// it a narrow bridge to desktop features (electron/features/*.cjs). Only "adt:" channels pass.
const allowed = (channel) => typeof channel === "string" && channel.startsWith("adt:");

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
