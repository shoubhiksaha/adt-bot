import { Capacitor } from "@capacitor/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support and "Add to Home Screen" for the web build. Desktop and mobile apps ship their files.
if (import.meta.env.PROD && location.protocol.startsWith("http") && !Capacitor.isNativePlatform()) {
  void import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
