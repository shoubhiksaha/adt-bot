import { createStore, get, set } from "idb-keyval";
import { create } from "zustand";

/** One bot's computer settings. Changing network/shared folder/browser/admin recreates the container (files kept). */
export type ComputerConfig = {
  enabled: boolean;
  /** false = the container gets --network none. */
  network: boolean;
  /** Folder on this machine mounted at /shared (read-only unless sharedWritable). */
  sharedFolder?: string;
  sharedWritable?: boolean;
  /** Use the bigger image with headless Chromium (computer_browse). */
  browser?: boolean;
  /** Lets *you* run root commands (apt-get) from the Computers screen; bots always run as `bot`. */
  admin?: boolean;
};

export const DEFAULT_CONFIG: ComputerConfig = { enabled: false, network: true };

type State = { configs: Record<string, ComputerConfig>; loaded: boolean };

const db = typeof indexedDB === "undefined" ? undefined : createStore("adtbot-computers", "data");
const KEY = "configs";

export const useComputers = create<State>(() => ({ configs: {}, loaded: false }));

let loading: Promise<void> | null = null;

export function loadComputers(): Promise<void> {
  loading ??= (async () => {
    const saved = db ? await get<Record<string, ComputerConfig>>(KEY, db).catch(() => undefined) : undefined;
    useComputers.setState((s) => ({ configs: { ...(saved ?? {}), ...s.configs }, loaded: true }));
  })();
  return loading;
}

export function configFor(botId: string): ComputerConfig {
  return { ...DEFAULT_CONFIG, ...useComputers.getState().configs[botId] };
}

export function hasComputer(botId: string): boolean {
  return Boolean(useComputers.getState().configs[botId]?.enabled);
}

export async function setComputerConfig(botId: string, patch: Partial<ComputerConfig>): Promise<ComputerConfig> {
  const next = { ...configFor(botId), ...patch };
  useComputers.setState((s) => ({ configs: { ...s.configs, [botId]: next } }));
  if (db) await set(KEY, useComputers.getState().configs, db);
  return next;
}

export async function forgetComputer(botId: string): Promise<void> {
  useComputers.setState((s) => {
    const configs = { ...s.configs };
    delete configs[botId];
    return { configs };
  });
  if (db) await set(KEY, useComputers.getState().configs, db);
}
