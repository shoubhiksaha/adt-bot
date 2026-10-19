/** Computers: each bot can get its own Docker container (desktop app). Screen, settings tab and tools. */
import { Monitor } from "lucide-react";
import { lazy } from "react";
import { isDesktop } from "../../lib/desktop";
import { registerSettingsTab, registerView } from "../registry";
import { ComputersSettings } from "./ComputersSettings";
import { loadComputers } from "./store";

registerView({ id: "computers", label: "Computers", icon: Monitor, order: 35, platforms: ["desktop"], Component: lazy(() => import("./ComputersView")) });
registerSettingsTab({ id: "computers", label: "Computers", order: 45, platforms: ["desktop"], Component: ComputersSettings });

if (isDesktop()) void loadComputers();
