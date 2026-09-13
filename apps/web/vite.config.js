import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Served from https://deadp0et.army/app/ alongside the marketing site.
  base: "/app/",
  // esnext so the pure-JS post-quantum crypto isn't downlevelled.
  build: { target: "esnext", outDir: "dist" },
  esbuild: { target: "esnext" },
  // ws: true, or the presence socket at /api/mls/groups/:id/live never
  // connects under `vite dev`.
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8790", ws: true } } },
});
