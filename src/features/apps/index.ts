/** Connected apps: Settings → Apps (tools register from src/lib/agent/features.ts), and bots' email addresses. */
import { useStore } from "../../lib/store";
import { registerSettingsTab } from "../registry";
import { refreshApps } from "./api";
import { AppsSettings } from "./AppsSettings";
import { startBotMail } from "./bot-mail";

registerSettingsTab({ id: "apps", label: "Apps", order: 38, Component: AppsSettings });

// The account list decides which app tools bots get; emailed tasks need the bots and chats loaded.
if (typeof window !== "undefined") {
  const start = () => {
    void refreshApps();
    startBotMail();
  };
  if (useStore.getState().hydrated) start();
  else {
    const off = useStore.subscribe((s) => {
      if (!s.hydrated) return;
      off();
      start();
    });
  }
}
