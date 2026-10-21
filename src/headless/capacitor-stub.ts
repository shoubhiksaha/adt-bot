// The server's always-on runner (Node) has no Capacitor: native HTTP is never used there.
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => "web" };
export const CapacitorHttp = {
  request: async () => {
    throw new Error("Native HTTP isn't available on the server.");
  },
};
