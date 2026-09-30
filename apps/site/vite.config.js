import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production nginx serves this site at / and the console at /app/ on one
// origin. For local testing, CONSOLE_TARGET / API_TARGET recreate that layout
// by proxying to the console's own dev server and the api.
const proxy = {};
if (process.env.CONSOLE_TARGET) proxy["/app"] = { target: process.env.CONSOLE_TARGET, ws: true };
if (process.env.API_TARGET) proxy["/api"] = { target: process.env.API_TARGET, ws: true };

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", assetsDir: "a" },
  server: { proxy },
});
