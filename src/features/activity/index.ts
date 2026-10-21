/** The agent log: every action bots took, in one searchable screen. */
import { ScrollText } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";

registerView({ id: "activity", label: "Agent log", icon: ScrollText, order: 70, Component: lazy(() => import("./ActivityView")) });
