#!/usr/bin/env node
/**
 * Run the test suites against a throwaway local stack.
 *
 *   pnpm test                 # api + session suites; needs Postgres (DATABASE_URL), migrated
 *   pnpm test:browser         # the web console's browser suites, via Vite + Chromium
 *
 * Starts apps/api on a spare port with test-friendly limits (and, for the
 * browser suites, a Vite dev server proxying to it with WebAuthn pinned to
 * localhost), runs each suite in turn, and always stops what it started.
 * Set CHROMIUM_PATH to use a Chromium other than Playwright's own.
 *
 * Not covered here: apps/site/test/funnel.mjs, which needs the site and the
 * console behind one origin the way nginx serves them.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = process.argv.includes("--browser");

const API_PORT = process.env.TEST_PORT || "8791";
const WEB_PORT = process.env.TEST_WEB_PORT || "5174";
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;

const SUITES = browser
  ? ["apps/web/test/e2e.mjs", "apps/web/test/canvas.mjs", "apps/web/test/presence.mjs"]
  : [
      "apps/api/test/e2ee.test.js",
      "apps/api/test/mls.api.test.js",
      "apps/api/test/compaction.test.js",
      "apps/api/test/housekeeping.test.js",
      "apps/web/test/session.test.mjs",
    ];

const env = {
  ...process.env,
  PORT: API_PORT,
  BASE: API,
  ORIGIN: WEB,
  API_TARGET: API,
  // WebAuthn validates both; they must name the origin the browser is on.
  RP_ID: "localhost",
  RP_ORIGIN: WEB,
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
  // Suites fire hundreds of requests a minute from one address.
  RATE_LIMIT_MAX: "100000",
  PRESENCE_RECHECK_MS: "300",
};

const children = [];
const start = (args, opts = {}) => {
  const child = spawn(args[0], args.slice(1), { cwd: root, env, stdio: "inherit", ...opts });
  children.push(child);
  return child;
};
const stopAll = () => { for (const c of children) if (c.exitCode === null) c.kill("SIGTERM"); };
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

async function waitFor(url, ok, what) {
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(url);
      if (await ok(r)) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

start([process.execPath, "apps/api/src/server.js"]);
await waitFor(`${API}/api/health`, async (r) => (await r.json()).status === "ok", "api");

if (browser) {
  start([process.execPath, "node_modules/vite/bin/vite.js", "--port", WEB_PORT, "--strictPort"],
    { cwd: path.join(root, "apps/web"), stdio: "ignore" });
  await waitFor(`${WEB}/app/`, (r) => r.ok, "vite");
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: root, env, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const failed = [];
for (const suite of SUITES) {
  console.log(`\n━━ ${suite}`);
  if (await run(suite)) failed.push(suite);
}
stopAll();

if (failed.length) {
  console.error(`\n${failed.length} suite(s) failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nall ${SUITES.length} suites passed`);
