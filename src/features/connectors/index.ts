import { registerSettingsTab } from "../registry";
import { ConnectorsSettings } from "./ConnectorsSettings";

// Settings → Connectors: MCP servers whose tools bots can use (src/lib/mcp).
registerSettingsTab({ id: "connectors", label: "Connectors", order: 40, Component: ConnectorsSettings });
