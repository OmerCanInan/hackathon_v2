import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true, // LAN erişimi — aynı WiFi'dan telefonla açılabilir
  },
});
