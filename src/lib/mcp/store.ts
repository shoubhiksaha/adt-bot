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
import { buildAgentTools, CONNECTORS_GROUP, type ConnectorConfig, ConnectorManager, type ConnectorStatus, syncAgentTools } from "./connectors";
import type { FetchFn } from "./http";

const STORAGE_KEY = "adtbot-connectors";

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
  onTools: (id, tools) => updateServer(id, { tools }),
});

/** Tokens, header and environment values: in the OS keychain on desktop (src/lib/secrets.ts). */
const keeper = new SecretKeeper("connectors", connectorSecretsCodec);
keeper.onFallback = () => save();

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
  return refreshServer(server);
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
  void get<ConnectorConfig[]>(STORAGE_KEY)
    .then((saved) => keeper.load(Array.isArray(saved) ? saved : [], (blanked) => set(STORAGE_KEY, blanked)))
    .then((servers) => {
      useConnectors.setState({ servers, loaded: true });
      for (const server of useConnectors.getState().servers) {
        if (server.enabled && runnable(server)) void refreshServer(server).catch(() => undefined);
      }
    })
    .catch(() => useConnectors.setState({ loaded: true }));
}
