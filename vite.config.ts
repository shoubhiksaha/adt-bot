import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import brand from "./src/brand.json";
// @ts-expect-error plain ESM module shared with the Node server
import { createProxyHandler } from "./server/proxy.mjs";

/** Gives `npm run dev` the same /api/proxy as the production server, so CORS never gets in the way. */
const devProxy = (): Plugin => ({
  name: "adtbot-dev-proxy",
  configureServer(server) {
    server.middlewares.use(createProxyHandler({ allowPrivate: true }));
  },
});

const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };

export default defineConfig({
  base: "./",
  // Multi-threaded WebAssembly for on-device speech needs cross-origin isolation.
  server: { headers: isolation },
  preview: { headers: isolation },
  plugins: [
    react(),
    devProxy(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: brand.name,
        short_name: brand.name.slice(0, 12),
        description: "Your AI bots, any provider, any device.",
        theme_color: "#0b0c0e",
        background_color: "#0b0c0e",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,ttf}"],
        // The PDF reader is large and only needed when a PDF is attached.
        globIgnores: ["**/pdf-*.js", "**/pdf.worker*", "**/whisper.worker*", "**/transformers*", "**/ort*"],
      },
    }),
  ],
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  // The Whisper worker imports code-split modules, which needs ES-module workers.
  worker: { format: "es" },
});
