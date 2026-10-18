/** Bridge to desktop-only features (Electron main process). Undefined on web and mobile. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.adtbotDesktop?.invoke);
}

export async function desktopInvoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!window.adtbotDesktop?.invoke) throw new Error("This only works in the ADT Bot desktop app.");
  return window.adtbotDesktop.invoke(channel, payload) as Promise<T>;
}

export function desktopOn<T = unknown>(channel: string, listener: (payload: T) => void): () => void {
  if (!window.adtbotDesktop?.on) return () => undefined;
  return window.adtbotDesktop.on(channel, listener as (payload: unknown) => void);
}
