// Routines on desktop: keep ADT Bot running in the menu bar / system tray when the window is closed
// (opt-in, so scheduled routines keep firing) and show a native notification when a routine finishes.
// The scheduler itself runs in the app UI (src/features/automation/runner.ts).
const { Menu, Notification, Tray, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function trayIcon() {
  const candidates = [
    path.join(__dirname, "..", "..", "dist", "icon-192.png"),
    path.join(__dirname, "..", "..", "build", "icon.png"),
    path.join(__dirname, "..", "..", "public", "icon-192.png"),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  const image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  return image.isEmpty() ? image : image.resize({ width: 18, height: 18 });
}

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

exports.register = ({ app, ipcMain, getWindow, send }) => {
  let keepAlive = false;
  let quitting = false;
  let tray = null;
  // Notifications are garbage-collected (and lose their click handler) unless something holds them.
  const live = new Set();

  const showWindow = () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const updateTray = () => {
    if (!keepAlive) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (tray) return;
    tray = new Tray(trayIcon());
    tray.setToolTip("ADT Bot: routines keep running");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open ADT Bot", click: showWindow },
        { label: "Routines run while ADT Bot is here", enabled: false },
        { type: "separator" },
        {
          label: "Quit ADT Bot",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("click", showWindow);
  };

  app.on("before-quit", () => {
    quitting = true;
  });

  // Closing the window hides it instead, while "keep running" is on.
  app.on("browser-window-created", (_event, win) => {
    win.on("close", (event) => {
      if (keepAlive && !quitting) {
        event.preventDefault();
        win.hide();
      }
    });
  });

  // Clicking the dock icon brings a hidden window back.
  app.on("activate", () => {
    const win = getWindow();
    if (win && !win.isVisible()) showWindow();
  });

  ipcMain.handle("adt:routines:keep-alive", (_event, payload) => {
    keepAlive = Boolean(payload?.enabled);
    updateTray();
    // Hidden windows throttle timers; the 30-second scheduler needs to keep ticking.
    getWindow()?.webContents.setBackgroundThrottling(!keepAlive);
    return { enabled: keepAlive };
  });

  ipcMain.handle("adt:routines:notify", (_event, payload) => {
    if (!Notification.isSupported()) return false;
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId.slice(0, 100) : undefined;
    const notification = new Notification({ title: text(payload?.title, 120) || "Routine finished", body: text(payload?.body, 300) });
    live.add(notification);
    const release = () => live.delete(notification);
    notification.on("click", () => {
      release();
      showWindow();
      if (conversationId) send("adt:routines:open", { conversationId });
    });
    notification.on("close", release);
    notification.show();
    // Don't hold on forever if the OS never reports back.
    setTimeout(release, 10 * 60_000).unref?.();
    return true;
  });
};
