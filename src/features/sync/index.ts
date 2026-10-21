/** Sync between devices (Settings → Sync), through the user's own ADT Bot server. */
import { useStore } from "../../lib/store";
import { registerSettingsTab } from "../registry";
import { startSync } from "./engine";
import { SyncSettings } from "./SyncSettings";

registerSettingsTab({ id: "sync", label: "Sync & server", order: 36, Component: SyncSettings });

if (typeof window !== "undefined") {
  if (useStore.getState().hydrated) startSync();
  else {
    const off = useStore.subscribe((s) => {
      if (!s.hydrated) return;
      off();
      startSync();
    });
  }
}
