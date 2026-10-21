/** Routines (scheduled bot tasks): the Workspace screen, the scheduler and the desktop tray hook-up. */
import { CalendarClock } from "lucide-react";
import { lazy } from "react";
import { useStore } from "../../lib/store";
import { registerView } from "../registry";
import { listenForNotificationClicks, syncKeepAlive } from "./keep-alive";
import { loadRoutines } from "./routines-store";
import { startScheduler } from "./runner";
import { startTriggers } from "./trigger-runner";
import { startServerRoutines } from "./server-routines";

registerView({ id: "routines", label: "Routines", icon: CalendarClock, order: 30, Component: lazy(() => import("./RoutinesView")) });

function start() {
  void loadRoutines().then(syncKeepAlive);
  listenForNotificationClicks();
  startScheduler();
  startTriggers();
  startServerRoutines();
}

if (typeof window !== "undefined") {
  // Runs need the bots and chats loaded first.
  if (useStore.getState().hydrated) start();
  else {
    const unsubscribe = useStore.subscribe((s) => {
      if (!s.hydrated) return;
      unsubscribe();
      start();
    });
  }
}
