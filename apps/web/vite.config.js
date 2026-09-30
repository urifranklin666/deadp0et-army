import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Stamped at build time so the console says which commit it is, instead of a
// hand-edited string that drifts. Falls back cleanly outside a git checkout.
const commit = (() => {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "dev"; }
})();
const BUILD = `${new Date().toISOString().slice(0, 10)}.${commit}`;

export default defineConfig({
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  // Served from https://deadp0et.army/app/ alongside the marketing site.
  base: "/app/",
  // esnext so the pure-JS post-quantum crypto isn't downlevelled.
  build: { target: "esnext", outDir: "dist" },
  esbuild: { target: "esnext" },
  // ws: true so the presence WebSocket is proxied too, not just HTTP.
  // API_TARGET lets the test runner point a dev server at its own api.
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_TARGET || "http://127.0.0.1:8790", ws: true } },
  },
});
