import { desktopInvoke, isDesktop } from "../../lib/desktop";
import { showConversation } from "./conversations";

/**
 * Tells the user a routine finished: a native notification on desktop (Electron, via
 * electron/features/30-routines.cjs), the Notification API on web when allowed. Clicking opens the chat.
 */
export async function notify(title: string, body: string, conversationId?: string): Promise<void> {
  if (isDesktop()) {
    try {
      if (await desktopInvoke<boolean>("adt:routines:notify", { title, body, conversationId })) return;
    } catch {
      // An older desktop build without the routines feature: fall through.
    }
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: "./icon-192.png", tag: conversationId });
    n.onclick = () => {
      window.focus();
      if (conversationId) showConversation(conversationId);
      n.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}
