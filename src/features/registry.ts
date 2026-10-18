import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { create } from "zustand";
import type { Platform } from "../lib/transport";

/**
 * Extension points for feature modules (projects, computers, rooms, routines, connectors…):
 * a full-screen view listed in the sidebar's "Workspace" section, and/or a Settings tab.
 * Features register from src/features/index.ts.
 */
export type FeatureView = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Where the view exists (default: everywhere). */
  platforms?: Platform[];
  order?: number;
  Component: ComponentType;
};

export type FeatureSettingsTab = {
  id: string;
  label: string;
  platforms?: Platform[];
  order?: number;
  Component: ComponentType;
};

type Registry = { views: FeatureView[]; tabs: FeatureSettingsTab[] };

export const useFeatureRegistry = create<Registry>(() => ({ views: [], tabs: [] }));

export function registerView(view: FeatureView) {
  useFeatureRegistry.setState((s) => ({
    views: [...s.views.filter((v) => v.id !== view.id), view].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
  }));
}

export function registerSettingsTab(tab: FeatureSettingsTab) {
  useFeatureRegistry.setState((s) => ({
    tabs: [...s.tabs.filter((t) => t.id !== tab.id), tab].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
  }));
}

/** Which feature view is open (null = the chat). Not persisted. */
export const useNav = create<{ view: string | null }>(() => ({ view: null }));

export function openView(id: string | null) {
  useNav.setState({ view: id });
}
