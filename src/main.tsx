import { Capacitor } from "@capacitor/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

/** Shown if the whole app fails to display: a way out that doesn't need the broken screen. */
function Crashed({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="app-crashed" role="alert">
      <h1>Something went wrong showing the app</h1>
      <p>{error.message}</p>
      <p>Your chats and settings are safe. Try again; if this keeps happening, open another chat or check Settings → Appearance.</p>
      <button type="button" className="btn primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, reset) => <Crashed error={error} reset={reset} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Offline support and "Add to Home Screen" for the web build. Desktop and mobile apps ship their files.
if (import.meta.env.PROD && location.protocol.startsWith("http") && !Capacitor.isNativePlatform()) {
  void import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
