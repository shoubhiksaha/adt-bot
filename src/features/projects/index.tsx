import { SquareKanban } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";

/** Projects with kanban boards. The board tools register from src/lib/agent/features.ts. */
registerView({
  id: "projects",
  label: "Projects",
  icon: SquareKanban,
  order: 10,
  Component: lazy(() => import("./ProjectsView")),
});
