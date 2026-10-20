// The app window's secrets (keys, tokens, header values, room PINs), kept encrypted with the OS keychain
// (electron/secrets.cjs). The window reads them into memory at start-up and writes them back when they
// change; its own storage (IndexedDB, localStorage) keeps everything else, with the secrets blanked.
const STORES = new Set(["app", "connectors", "rooms"]);

function store(payload) {
  const namespace = payload?.namespace;
  if (!STORES.has(namespace)) throw new Error("Unknown secret store");
  return namespace;
}

exports.register = ({ ipcMain, secrets }) => {
  ipcMain.handle("adt:secrets:status", () => secrets.status());
  ipcMain.handle("adt:secrets:get", (_event, payload) => secrets.get(store(payload)));
  ipcMain.handle("adt:secrets:set", (_event, payload) => secrets.set(store(payload), payload?.value));
  ipcMain.handle("adt:secrets:clear", (_event, payload) => secrets.clear(store(payload)));
};

exports.STORES = STORES;
