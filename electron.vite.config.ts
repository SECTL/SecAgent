import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: { build: { rollupOptions: { input: "src/electron/main.ts" } } },
  // Electron runs sandboxed preload scripts as CommonJS.  A `.cjs` filename is
  // important because this package otherwise opts into ESM via `type: module`.
  preload: {
    build: {
      rollupOptions: {
        input: "src/electron/preload.ts",
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  },
  renderer: { root: "src/renderer", plugins: [react()] }
});
