import { desktopInvoke, desktopOn, isDesktop } from "../../lib/desktop";
import { showConversation } from "./conversations";
import { useRoutines } from "./routines-store";

/** Tells the desktop shell whether closing the window should keep the app in the tray for routines. */
export async function syncKeepAlive(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await desktopInvoke("adt:routines:keep-alive", { enabled: useRoutines.getState().keepAlive });
  } catch {
    // Older desktop build without the routines feature.
  }
}

/** Clicking a routine notification opens its chat. */
export function listenForNotificationClicks(): () => void {
  return desktopOn<{ conversationId?: string }>("adt:routines:open", (payload) => {
    if (payload?.conversationId) showConversation(payload.conversationId);
  });
}
