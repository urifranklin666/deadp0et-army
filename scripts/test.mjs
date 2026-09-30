#!/usr/bin/env node
/**
 * Run every suite that doesn't need the live origin, against a throwaway api.
 *
 *   pnpm test          # needs Postgres (DATABASE_URL) with migrations applied
 *
 * Starts apps/api on a spare port with test-friendly limits, runs each suite
 * in turn, and always stops the server. The browser suites (e2e, canvas,
 * presence, funnel) are not here: WebAuthn pins them to the live RP ID.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.TEST_PORT || "8791";
const BASE = `http://127.0.0.1:${PORT}`;

const SUITES = [
  "apps/api/test/e2ee.test.js",
  "apps/api/test/mls.api.test.js",
  "apps/api/test/compaction.test.js",
  "apps/api/test/housekeeping.test.js",
  "apps/web/test/session.test.mjs",
];

const env = {
  ...process.env,
  PORT,
  BASE,
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
  // Suites fire hundreds of requests a minute from one address.
  RATE_LIMIT_MAX: "100000",
  PRESENCE_RECHECK_MS: "300",
};

const api = spawn(process.execPath, ["apps/api/src/server.js"], { cwd: root, env, stdio: "inherit" });
const stop = () => { if (api.exitCode === null) api.kill("SIGTERM"); };
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

async function waitForApi() {
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`api exited early (${api.exitCode})`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if ((await r.json()).status === "ok") return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("api did not become healthy");
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: root, env, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

await waitForApi();
const failed = [];
for (const suite of SUITES) {
  console.log(`\n━━ ${suite}`);
  if (await run(suite)) failed.push(suite);
}
stop();

if (failed.length) {
  console.error(`\n${failed.length} suite(s) failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nall ${SUITES.length} suites passed`);
