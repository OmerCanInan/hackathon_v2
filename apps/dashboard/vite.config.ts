import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3002",
      "/ws": { target: "ws://localhost:3002", ws: true },
    },
  },
  optimizeDeps: {
    exclude: ["pmtiles"],
  },
});
