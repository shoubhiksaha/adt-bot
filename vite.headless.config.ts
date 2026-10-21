// The always-on runner's code for Node (server/agent.mjs imports server/headless/agent.mjs):
// the app's own provider clients, schedules, triggers and search, in one file.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  resolve: { alias: { "@capacitor/core": fileURLToPath(new URL("./src/headless/capacitor-stub.ts", import.meta.url)) } },
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "src/headless/agent.ts",
    outDir: "server/headless",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: { output: { entryFileNames: "agent.mjs", format: "es" } },
  },
});
