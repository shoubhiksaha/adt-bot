/**
 * Local (stdio) MCP servers, desktop only. The Electron side (electron/features/40-mcp.cjs) runs
 * the process and relays newline-delimited JSON-RPC; this transport speaks to it over IPC.
 */
import { desktopInvoke, desktopOn } from "../desktop";
import type { McpTransport } from "./client";
import { type JsonRpcMessage, McpClosedError } from "./protocol";

export type StdioStartPayload = { id: string; command: string; args: string[]; env: Record<string, string>; cwd?: string };
type MessageEvent = { id: string; session: number; message: JsonRpcMessage };
type ExitEvent = { id: string; session: number; code: number | null; signal: string | null; error?: string; stderr?: string };

/** The IPC surface (swappable in tests). */
export type StdioBridge = {
  start(payload: StdioStartPayload): Promise<{ session: number }>;
  send(payload: { id: string; session: number; message: JsonRpcMessage }): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  onMessage(listener: (event: MessageEvent) => void): () => void;
  onExit(listener: (event: ExitEvent) => void): () => void;
};

export const desktopStdioBridge: StdioBridge = {
  start: (payload) => desktopInvoke("adt:mcp:start", payload),
  send: (payload) => desktopInvoke("adt:mcp:send", payload),
  stop: (id) => desktopInvoke("adt:mcp:stop", { id }),
  onMessage: (listener) => desktopOn("adt:mcp:message", listener),
  onExit: (listener) => desktopOn("adt:mcp:exit", listener),
};

export function exitMessage(event: Pick<ExitEvent, "code" | "signal" | "error" | "stderr">): string {
  const why = event.error
    ? `couldn't start: ${event.error}`
    : event.signal
      ? `was stopped (${event.signal})`
      : `exited with code ${event.code ?? "?"}`;
  const tail = (event.stderr ?? "").split("\n").slice(-6).join("\n").trim();
  return `The server process ${why}.${tail ? `\n${tail.slice(-800)}` : ""}`;
}

export class StdioTransport implements McpTransport {
  readonly kind = "stdio";
  private session?: number;
  private unsubscribe: (() => void)[] = [];
  private closed = false;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;

  constructor(
    private payload: StdioStartPayload,
    private bridge: StdioBridge = desktopStdioBridge,
  ) {}

  async start() {
    const id = this.payload.id;
    this.unsubscribe.push(
      this.bridge.onMessage((event) => {
        if (event.id === id && (this.session === undefined || event.session === this.session)) this.onmessage?.(event.message);
      }),
      this.bridge.onExit((event) => {
        if (event.id !== id || (this.session !== undefined && event.session !== this.session)) return;
        this.finish(new McpClosedError(exitMessage(event)));
      }),
    );
    try {
      const { session } = await this.bridge.start(this.payload);
      this.session = session;
    } catch (error) {
      this.finish();
      throw error;
    }
  }

  async send(message: JsonRpcMessage) {
    if (this.closed || this.session === undefined) throw new McpClosedError();
    await this.bridge.send({ id: this.payload.id, session: this.session, message });
  }

  private finish(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.onclose?.(error);
  }

  async close() {
    const wasOpen = !this.closed && this.session !== undefined;
    this.finish();
    if (wasOpen) await this.bridge.stop(this.payload.id).catch(() => undefined);
  }
}
