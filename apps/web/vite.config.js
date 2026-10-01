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

// This page holds private keys in IndexedDB, so injected script is key theft.
// The built console loads nothing but its own bundle and talks only to its
// own origin; say so. (Build only: the dev server injects inline scripts.)
// frame-ancestors can't be set from a meta tag — nginx should send it.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   // React style={} attributes
  "img-src 'self' data:",               // the inline favicon
  "font-src 'self'",
  "connect-src 'self'",                 // fetch + same-origin WebSockets
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const cspMeta = {
  name: "csp-meta",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

const api = { "/api": { target: process.env.API_TARGET || "http://127.0.0.1:8790", ws: true } };

export default defineConfig({
  plugins: [react(), cspMeta],
  define: { __BUILD__: JSON.stringify(BUILD) },
  // Served from https://deadp0et.army/app/ alongside the marketing site.
  base: "/app/",
  // esnext so the pure-JS post-quantum crypto isn't downlevelled.
  build: {
    target: "esnext",
    outDir: "dist",
    // Small font subsets would otherwise be inlined as data: URIs, which the
    // CSP (font-src 'self') rightly refuses. Ship them as files.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  esbuild: { target: "esnext" },
  // ws: true so the presence WebSocket is proxied too, not just HTTP.
  // API_TARGET lets the test runner point a dev server at its own api.
  server: { port: 5173, proxy: api },
  // `vite preview` serves the built bundle — CSP and all — the same way.
  preview: { proxy: api },
});
