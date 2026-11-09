import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Dev server proxies /api to the real Node workspace server (port 9000) so `npm run dev` works against live data.
// The production build (`npm run build`) outputs straight into ../question-workspace/dist, which the workspace
// server serves as static files — no separate deploy step.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:9000", changeOrigin: true },
    },
  },
});
