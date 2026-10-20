import { createRoot } from "react-dom/client";
import { registerSettingsTab } from "../registry";
import "./mac-control.css";
import { MacControlBanner } from "./MacControlBanner";
import { MacControlSettings } from "./MacControlSettings";
import { isComputerControlDesktop } from "./store";
import "./tools";

registerSettingsTab({ id: "computer-control", label: "Computer control", platforms: ["desktop"], order: 40, Component: MacControlSettings });

// The banner floats above the whole app, so it gets its own small root (no edits to the app shell).
if (typeof document !== "undefined" && isComputerControlDesktop()) {
  const host = document.createElement("div");
  host.id = "mac-control-banner-root";
  document.body.appendChild(host);
  createRoot(host).render(<MacControlBanner />);
}
