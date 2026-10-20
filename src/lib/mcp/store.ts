/**
 * App wiring for connectors: the saved server list (IndexedDB, this device only), live status,
 * the shared connection manager, and keeping agent tools in sync with both.
 */
import { get, set } from "idb-keyval";
import { create } from "zustand";
import { registerToolGroup } from "../agent/tools";
import { isDesktop } from "../desktop";
import { connectorSecretsCodec, SecretKeeper } from "../secrets";
import { useStore } from "../store";
import { providerFetch } from "../transport";
import {
  buildAgentTools,
  CONNECTORS_GROUP,
  type ConnectorConfig,
  ConnectorManager,
  type ConnectorStatus,
  launchApproved,
  syncAgentTools,
} from "./connectors";
import type { FetchFn } from "./http";
import { approveTools, launchKey } from "./security";

const STORAGE_KEY = "adtbot-connectors";
/** Set once existing servers were marked as approved (see startConnectors). */
const TRUST_KEY = "adtbot-connectors-trust";

type State = { loaded: boolean; servers: ConnectorConfig[]; status: Record<string, ConnectorStatus> };

export const useConnectors = create<State>(() => ({ loaded: false, servers: [], status: {} }));

/**
 * Remote servers go through the app's relay (desktop, self-hosted web) so CORS never blocks them.
 * A public web server only relays to approved hosts; then the request is retried straight from the
 * browser, which works for servers that allow CORS.
 */
function fetchFor(config: ConnectorConfig): FetchFn {
  return async (url, init) => {
    const useProxy = !config.direct && useStore.getState().settings.useProxy;
    const res = await providerFetch(url, init, useProxy);
    if (useProxy && res.status === 403 && !res.headers.get("mcp-session-id")) {
      const text = await res
        .clone()
        .text()
        .catch(() => "");
      if (/relay (is not allowed|only accepts)/i.test(text)) return providerFetch(url, init, false);
    }
    return res;
  };
}

export const connectorManager = new ConnectorManager({
  fetchFor,
  onStatus: (id, status) => useConnectors.setState((s) => ({ status: { ...s.status, [id]: status } })),
  // The first listing after the user adds a server is what they approved; later changes wait for review.
  onTools: (id, tools) => {
    const server = getServer(id);
    updateServer(id, server && !server.approvedTools ? { tools, approvedTools: approveTools(undefined, tools) } : { tools });
  },
  onEra: (id, protocolEra) => updateServer(id, { protocolEra }),
});

/** Tokens, header and environment values: in the OS keychain on desktop (src/lib/secrets.ts). */
const keeper = new SecretKeeper("connectors", connectorSecretsCodec);
keeper.onFallback = () => save();

/** Erase all data: every connector, its saved tools and its keys. */
export async function eraseConnectors() {
  await connectorManager.disconnectAll().catch(() => undefined);
  useConnectors.setState({ servers: [], status: {} });
  await Promise.allSettled([set(STORAGE_KEY, []), set(TRUST_KEY, 0), keeper.clear()]);
}

/** The user reviewed changed or new tools and accepts them as they are now (all of them without names). */
export function approveToolChanges(id: string, names?: string[]) {
  const server = getServer(id);
  if (server) updateServer(id, { approvedTools: approveTools(server.approvedTools, server.tools, names) });
}

/** The user confirmed a local server's command (shown in full) on this device. */
export function approveLaunch(id: string) {
  const server = getServer(id);
  if (server) updateServer(id, { approvedLaunch: launchKey(server) });
}

function save() {
  const { servers, loaded } = useConnectors.getState();
  if (loaded) void set(STORAGE_KEY, keeper.forDisk(servers)).catch(() => undefined);
}

export function getServer(id: string) {
  return useConnectors.getState().servers.find((s) => s.id === id);
}

export function addServer(config: Omit<ConnectorConfig, "id" | "disabledTools"> & Partial<Pick<ConnectorConfig, "disabledTools">>): ConnectorConfig {
  const server: ConnectorConfig = { disabledTools: [], ...config, id: crypto.randomUUID() };
  useConnectors.setState((s) => ({ servers: [...s.servers, server] }));
  save();
  return server;
}

export function updateServer(id: string, patch: Partial<ConnectorConfig>) {
  useConnectors.setState((s) => ({ servers: s.servers.map((server) => (server.id === id ? { ...server, ...patch, id } : server)) }));
  save();
}

export async function removeServer(id: string) {
  useConnectors.setState((s) => {
    const status = { ...s.status };
    delete status[id];
    return { servers: s.servers.filter((server) => server.id !== id), status };
  });
  save();
  await connectorManager.disconnect(id, false);
}

/** Switches a server on (connects and lists tools) or off (disconnects; its tools disappear). */
export async function setServerEnabled(id: string, enabled: boolean) {
  updateServer(id, { enabled });
  const server = getServer(id);
  if (!server) return;
  if (enabled) await refreshServer(server).catch(() => undefined);
  else await connectorManager.disconnect(id);
}

/** Connects (or reconnects) and refreshes the tool list. Throws with a readable message. */
export async function refreshServer(server: ConnectorConfig) {
  return connectorManager.listTools(server);
}

/** "Test connection": a fresh connection, handshake and tool listing. */
export async function testServer(server: ConnectorConfig) {
  await connectorManager.disconnect(server.id, false);
  return connectorManager.listTools(server, undefined, true);
}

const runnable = (server: ConnectorConfig) => server.transport === "http" || isDesktop();

function syncTools() {
  const { servers } = useConnectors.getState();
  syncAgentTools(buildAgentTools(servers.filter(runnable), connectorManager, getServer));
}

let started = false;

/** Loads saved servers, registers their tools from the last listing, then refreshes them in the background. */
export function startConnectors() {
  if (started || typeof indexedDB === "undefined") return;
  started = true;
  registerToolGroup({
    id: CONNECTORS_GROUP,
    label: "Connectors (MCP)",
    description: "Tools from the MCP servers you added in Settings → Connectors.",
  });
  useConnectors.subscribe((state, previous) => {
    if (state.servers !== previous.servers) syncTools();
  });
  void Promise.all([get<ConnectorConfig[]>(STORAGE_KEY), get<number>(TRUST_KEY)])
    .then(([saved, trusted]) =>
      keeper.load(Array.isArray(saved) ? saved : [], (blanked) => set(STORAGE_KEY, blanked)).then((servers) => ({ servers, trusted })),
    )
    .then(({ servers: loaded, trusted }) => {
      let servers = loaded;
      if (!trusted) {
        // Once, for servers saved before these checks existed (added by the user in Settings, the
        // only way to add one): their command and their last tool list count as approved. After
        // this, a server that arrives any other way waits for the user's confirmation.
        servers = servers.map((s) => ({
          ...s,
          approvedLaunch: s.transport === "stdio" && s.approvedLaunch === undefined ? launchKey(s) : s.approvedLaunch,
          approvedTools: s.approvedTools ?? (s.tools?.length ? approveTools(undefined, s.tools) : undefined),
        }));
        void set(TRUST_KEY, 1).catch(() => undefined);
      }
      useConnectors.setState({ servers, loaded: true });
      if (!trusted) save();
      for (const server of useConnectors.getState().servers) {
        if (server.enabled && runnable(server) && launchApproved(server)) void refreshServer(server).catch(() => undefined);
      }
    })
    .catch(() => useConnectors.setState({ loaded: true }));
}
