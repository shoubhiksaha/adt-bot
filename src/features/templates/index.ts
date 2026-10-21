/** Bot templates: ready-made bots, and sharing your own as a file. */
import { LayoutTemplate } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";

registerView({ id: "templates", label: "Bot templates", icon: LayoutTemplate, order: 5, Component: lazy(() => import("./TemplatesView")) });
