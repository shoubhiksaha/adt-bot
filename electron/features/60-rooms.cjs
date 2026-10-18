// LAN chat rooms: the host shares a room on the local network; guests join from any browser with
// a PIN. The room server (server/rooms.mjs) runs here in the main process; bots answer from the
// app window (the renderer runs the bot with the host's own providers and streams the reply back).
// Guests never see API keys: only room messages cross the network.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let hubPromise = null;

function hub(ctx) {
  hubPromise ??= import(pathToFileURL(path.join(__dirname, "..", "..", "server", "rooms.mjs")).href).then((m) =>
    m.createRoomHub({ onEvent: (event) => ctx.send("adt:rooms:event", event) }),
  );
  return hubPromise;
}

exports.register = (ctx) => {
  const { ipcMain, app } = ctx;
  const on = (name, fn) => ipcMain.handle(`adt:rooms:${name}`, async (_event, payload) => fn(await hub(ctx), payload ?? {}));

  on("start", (h, config) => h.startRoom(config));
  on("stop", (h, { id }) => h.stopRoom(id));
  on("list", (h) => h.list());
  on("get", (h, { id }) => h.get(id));
  /** Host message, or a bot reply (kind "bot", pending: true while it streams). Returns the message. */
  on("send", (h, { id, ...message }) => h.post(id, message));
  on("update", (h, { id, messageId, text, done }) => h.update(id, messageId, { text, done }));
  on("typing", (h, { id, name }) => h.typing(id, name));
  on("kick", (h, { id, guestId }) => h.kick(id, guestId));
  on("clear", (h, { id }) => h.clear(id));

  app.on("before-quit", () => {
    if (hubPromise) void hubPromise.then((h) => h.close()).catch(() => undefined);
  });
};
