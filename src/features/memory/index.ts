/** Memory: everything the bots remember about you, in one place. */
import { Brain } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";

registerView({ id: "memory", label: "Memory", icon: Brain, order: 32, Component: lazy(() => import("./MemoryView")) });
