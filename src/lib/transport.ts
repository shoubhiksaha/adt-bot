import { Capacitor, CapacitorHttp } from "@capacitor/core";

/**
 * Where the app is running decides how provider requests leave it:
 * - desktop (Electron) and self-hosted web: through the bundled same-origin proxy, so CORS
 *   never blocks a provider or local LLM server;
 * - Android/iOS: straight from the WebView, falling back to native HTTP when CORS blocks it;
 * - static web hosting: straight from the browser.
 */
export type Platform = "desktop" | "android" | "ios" | "web";

type Env = { platform: Platform; proxy: boolean; proxyToken?: string };

declare global {
  interface Window {
    adtbotDesktop?: {
      proxyToken: string;
      platform: string;
      version: string;
      invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
      on?: (channel: string, listener: (payload: unknown) => void) => () => void;
    };
  }
}

let envPromise: Promise<Env> | null = null;

export function detectEnv(): Promise<Env> {
  envPromise ??= (async (): Promise<Env> => {
    // The server's always-on runner uses this code in Node, where there is no window.
    if (typeof window === "undefined") return { platform: "web", proxy: false };
    if (window.adtbotDesktop) {
      return { platform: "desktop", proxy: true, proxyToken: window.adtbotDesktop.proxyToken };
    }
    if (Capacitor.isNativePlatform()) {
      return { platform: Capacitor.getPlatform() === "ios" ? "ios" : "android", proxy: false };
    }
    try {
      const res = await fetch("./api/health", { signal: AbortSignal.timeout(1500) });
      const body = res.ok ? await res.json() : null;
      return { platform: "web", proxy: Boolean(body?.proxy) };
    } catch {
      return { platform: "web", proxy: false };
    }
  })();
  return envPromise;
}

export class NetworkError extends Error {}

export type FetchInit = Omit<RequestInit, "headers"> & { headers: Record<string, string> };

export async function providerFetch(
  url: string,
  init: FetchInit,
  useProxy: boolean,
): Promise<Response> {
  const env = await detectEnv();

  if (env.proxy && useProxy) {
    const headers: Record<string, string> = { ...init.headers, "x-adtbot-target": url };
    if (env.proxyToken) headers["x-adtbot-token"] = env.proxyToken;
    return fetch("./api/proxy", { ...init, headers });
  }

  try {
    return await fetch(url, init);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    const nativeOk = init.body === undefined || typeof init.body === "string";
    if ((env.platform === "android" || env.platform === "ios") && nativeOk) return nativeFetch(url, init);
    throw new NetworkError(
      `Could not reach ${new URL(url).host}. The provider may block browser requests (CORS) or the server is not running. ` +
        "Use the desktop app, or run the web app with `npm start` so requests go through the built-in proxy.",
    );
  }
}

/** Native HTTP bypasses CORS on mobile. It buffers the reply, so the answer arrives in one piece. */
async function nativeFetch(url: string, init: FetchInit) {
  const res = await CapacitorHttp.request({
    url,
    method: init.method ?? "GET",
    headers: init.headers,
    data: typeof init.body === "string" ? parseBody(init.body) : undefined,
    responseType: "text",
  });
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  const headers: Record<string, string> = { "content-type": res.headers["Content-Type"] ?? res.headers["content-type"] ?? "" };
  // MCP connectors (Streamable HTTP) keep their session in this header.
  const mcpSession = Object.entries(res.headers).find(([key]) => key.toLowerCase() === "mcp-session-id")?.[1];
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  return new Response(text, { status: res.status, headers });
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
