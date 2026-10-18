import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * "Allow bots to control this Mac" (off by default, remembered on this device) plus runtime state:
 * how many Mac tools are running right now, for the "ADT Bot is controlling your Mac" banner.
 */
type MacControlState = {
  enabled: boolean;
  active: number;
  /** When the last Mac tool finished (the banner lingers briefly so it doesn't flicker between steps). */
  lastDoneAt: number;
};

export const useMacControl = create<MacControlState>()(
  persist((): MacControlState => ({ enabled: false, active: 0, lastDoneAt: 0 }), {
    name: "adt-mac-control",
    storage: createJSONStorage(() => localStorage),
    partialize: ({ enabled }) => ({ enabled }),
  }),
);

export function setMacControlEnabled(enabled: boolean) {
  useMacControl.setState({ enabled });
}

/** True in the desktop app on macOS. */
export function isMacDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.adtbotDesktop?.invoke) && window.adtbotDesktop?.platform === "darwin";
}

/** Marks a Mac tool as running for the duration of `work` (drives the banner). */
export async function whileControlling<T>(work: () => Promise<T>): Promise<T> {
  useMacControl.setState((s) => ({ active: s.active + 1 }));
  try {
    return await work();
  } finally {
    useMacControl.setState((s) => ({ active: Math.max(0, s.active - 1), lastDoneAt: Date.now() }));
  }
}
