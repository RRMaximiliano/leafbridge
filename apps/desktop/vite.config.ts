import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@leafbridge/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url))
    }
  },
  server: {
    strictPort: true,
    port: 1420,
    host: "127.0.0.1"
  },
  clearScreen: false
});
