/** Connected apps: Settings → Apps (tools register from src/lib/agent/features.ts). */
import { useStore } from "../../lib/store";
import { registerSettingsTab } from "../registry";
import { refreshApps } from "./api";
import { AppsSettings } from "./AppsSettings";

registerSettingsTab({ id: "apps", label: "Apps", order: 38, Component: AppsSettings });

// The account list decides which app tools bots get.
if (typeof window !== "undefined") {
  if (useStore.getState().hydrated) void refreshApps();
  else {
    const off = useStore.subscribe((s) => {
      if (!s.hydrated) return;
      off();
      void refreshApps();
    });
  }
}
