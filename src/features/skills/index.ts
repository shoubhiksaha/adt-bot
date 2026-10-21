/** Skills: reusable how-tos the bots share (tools register from src/lib/agent/features.ts). */
import { BookOpenCheck } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";

registerView({ id: "skills", label: "Skills", icon: BookOpenCheck, order: 31, Component: lazy(() => import("./SkillsView")) });
