import { TerminalSquare } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";

registerView({
  id: "coding-agents",
  label: "Coding agents",
  icon: TerminalSquare,
  platforms: ["desktop"],
  order: 40,
  Component: lazy(() => import("./CodingAgentsView")),
});
