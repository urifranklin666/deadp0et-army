import Fastify from "fastify";
import { TRUST_PROXY, migrationFiles } from "./config.js";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { pool, q, tx } from "./db.js";
import { authRoutes, requireSession } from "./routes/auth.js";
import { keyRoutes } from "./routes/keys.js";
import { messageRoutes } from "./routes/messages.js";
import { mlsRoutes, registerSignatureKey } from "./routes/mls.js";
import { verifiedKeyPackage } from "./keypackages.js";
import { liveRoutes } from "./routes/live.js";
import { notifyRoutes } from "./routes/notify.js";
import { compactAll } from "./compaction.js";
import { sweepExpired } from "./retention.js";
import { challengeBackend, closeChallenges } from "./challenges.js";
import { busBackend, closeBus } from "./bus.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  // Believe X-Forwarded-For only from our own proxies (see config.js).
  trustProxy: TRUST_PROXY,
  bodyLimit: 1024 * 1024, // 1 MiB — envelopes are small; canvas state has its own cap
});

await app.register(cookie, { secret: process.env.SESSION_SECRET });
// Per-IP ceiling. Overridable so a test run or a trusted load test can raise
// it without editing code; individual routes may set tighter limits.
await app.register(rateLimit, { max: Number(process.env.RATE_LIMIT_MAX) || 300, timeWindow: "1 minute" });
// Presence frames are tiny; the cap here just bounds a hostile client.
await app.register(websocket, { options: { maxPayload: 8 * 1024 } });

// Every response here is per-user state or key material. Nothing should be
// cached by the browser or anything between it and us, and nothing should be
// content-sniffed into something executable.
app.addHook("onSend", async (req, reply, payload) => {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  return payload;
});

// Migrations on disk that the database hasn't applied. A deploy that forgot
// `pnpm migrate` would otherwise fail later, on whichever query first needs
// a new column; this makes it visible at the health check instead.
const MIGRATIONS = migrationFiles().map((m) => m.name);

async function pendingMigrations() {
  const { rows } = await q("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  return MIGRATIONS.filter((f) => !applied.has(f));
}

app.get("/api/health", async () => {
  const started = Date.now();
  const db = await q("SELECT 1 AS ok").then(() => "up").catch(() => "down");
  const pending = db === "up" ? await pendingMigrations().catch(() => null) : null;
  return {
    status: db === "up" && pending?.length === 0 ? "ok" : "degraded",
    db,
    ...(pending?.length ? { pending_migrations: pending } : {}),
    uptime_s: Math.round(process.uptime()),
    latency_ms: Date.now() - started,
  };
});

// Everything the client needs to know before authenticating.
app.get("/api/meta", async () => ({
  rp_id: process.env.RP_ID,
  protocol: "signal-double-ratchet",
  transport: "https+ws",
}));

// Must be set BEFORE the route plugins register: each child scope copies the
// error handler that exists when it is created, so setting it afterwards
// silently leaves every route on Fastify's default.
//
// Postgres errors that mean "the client sent something unusable", not "we
// broke": a malformed uuid or number, or a reference to a row that is gone
// (e.g. a device deleted between the ownership check and the write).
const PG_CLIENT_ERRORS = {
  "22P02": [400, "malformed input"],       // invalid_text_representation
  "22003": [400, "value out of range"],    // numeric_value_out_of_range
  "23503": [409, "referenced row no longer exists"], // foreign_key_violation
};

app.setErrorHandler((err, req, reply) => {
  const pg = PG_CLIENT_ERRORS[err.code];
  if (pg) return reply.code(pg[0]).send({ error: pg[1] });
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) req.log.error({ err }, "unhandled");
  // Never leak internals to the client.
  reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
});

await app.register(authRoutes);
await app.register(keyRoutes);
await app.register(messageRoutes);
await app.register(mlsRoutes);
await app.register(liveRoutes);
await app.register(notifyRoutes);

// Periodic housekeeping. Compaction is cheap: it only touches groups whose
// logs have grown, and prunes strictly below the slowest active device. The
// retention sweep then deletes rows every read path was already hiding.
const COMPACT_MS = 5 * 60 * 1000;
const compactTimer = setInterval(() => {
  compactAll(app.log).catch((err) => app.log.error({ err }, "compaction sweep failed"));
  sweepExpired(app.log).catch((err) => app.log.error({ err }, "retention sweep failed"));
}, COMPACT_MS);
compactTimer.unref();

// Idempotent: a second signal (a supervisor retrying, ^C twice) must not run
// shutdown again — pool.end() throws if called twice.
let closing = null;
const close = () => (closing ??= shutdown());
const shutdown = async () => {
  clearInterval(compactTimer);
  app.log.info("shutting down");
  await app.close();
  await pool.end();
  await closeChallenges();
  await closeBus();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

// Passkeys are bound to RP_ID/RP_ORIGIN; the localhost fallbacks in auth.js
// are for development and would make every production login fail.
for (const key of ["RP_ID", "RP_ORIGIN", "SESSION_SECRET"]) {
  if (!process.env[key]) app.log.warn(`${key} is not set; using a development default`);
}
pendingMigrations()
  .then((p) => { if (p.length) app.log.warn({ pending: p }, "database is missing migrations; run `pnpm migrate`"); })
  .catch(() => {});

// One-time backfill for migration 009: packages uploaded before the
// signature-key directory existed. Parsing and signature checks need JS, so
// it can't live in the SQL migration; completion is recorded alongside the
// migrations so it runs once.
backfillSignatureKeys()
  .then((n) => { if (n !== null) app.log.info({ n }, "backfilled signature keys"); })
  .catch((err) => app.log.warn({ err }, "signature key backfill failed"));

async function backfillSignatureKeys() {
  const MARK = "backfill:009_signature_keys";
  if ((await q("SELECT 1 FROM schema_migrations WHERE name=$1", [MARK])).rowCount) return null;
  const { rows } = await q(
    "SELECT kp.key_package, d.user_id FROM mls_key_packages kp JOIN devices d ON d.id = kp.device_id");
  let n = 0;
  await tx(async (c) => {
    for (const r of rows) {
      const p = await verifiedKeyPackage(r.key_package);
      if (!p) continue;
      await registerSignatureKey(c, p.signatureKey, r.user_id);
      n++;
    }
    await c.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [MARK]);
  });
  return n;
}

const port = Number(process.env.PORT || 8790);
await app.listen({ port, host: "127.0.0.1" });
app.log.info(`api listening on 127.0.0.1:${port} (challenges: ${challengeBackend()}, fan-out: ${busBackend()})`);

export { requireSession };
