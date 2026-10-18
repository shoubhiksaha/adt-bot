const { contextBridge } = require("electron");

// Tells the web app it runs on desktop, so provider calls go through the built-in relay.
contextBridge.exposeInMainWorld("adtbotDesktop", {
  proxyToken: "",
  platform: process.platform,
  version: process.versions.electron,
});
