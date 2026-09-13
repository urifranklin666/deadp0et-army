import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { pool, q } from "./db.js";
import { authRoutes, requireSession } from "./routes/auth.js";
import { keyRoutes } from "./routes/keys.js";
import { messageRoutes } from "./routes/messages.js";
import { mlsRoutes } from "./routes/mls.js";
import { liveRoutes } from "./routes/live.js";
import { compactAll } from "./compaction.js";
import { SWEEP_MS, sweep } from "./sweeper.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  // Trust only the loopback hop (nginx). `true` would take the LEFTMOST
  // X-Forwarded-For entry, which the client controls (Cloudflare appends to
  // an existing header rather than replacing it), so req.ip — and with it the
  // rate limiter's key — was spoofable. nginx now forwards a single
  // realip-resolved address.
  trustProxy: "127.0.0.1",
  bodyLimit: 1024 * 1024, // 1 MiB — envelopes are small; canvas state has its own cap
});

await app.register(cookie, { secret: process.env.SESSION_SECRET });
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
// Presence frames are tiny; the cap here just bounds a hostile client.
await app.register(websocket, { options: { maxPayload: 8 * 1024 } });

app.get("/api/health", async () => {
  const started = Date.now();
  const db = await q("SELECT 1 AS ok").then(() => "up").catch(() => "down");
  return {
    status: db === "up" ? "ok" : "degraded",
    db,
    uptime_s: Math.round(process.uptime()),
    latency_ms: Date.now() - started,
  };
});

// Everything the client needs to know before authenticating.
app.get("/api/meta", async () => ({
  rp_id: process.env.RP_ID,
  protocol: "mls",
  ciphersuite: "MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87",
  transport: "https+ws",
}));

await app.register(authRoutes);
// Signal key directory: no client speaks it yet, see routes/messages.js.
if (process.env.ENABLE_SIGNAL_ROUTES === "1") await app.register(keyRoutes);
await app.register(messageRoutes);
await app.register(mlsRoutes);
await app.register(liveRoutes);

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) req.log.error({ err }, "unhandled");
  // Never leak internals to the client.
  reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
});

// Periodic compaction. Cheap: it only touches groups whose logs have grown,
// and prunes strictly below the slowest active device.
const COMPACT_MS = 5 * 60 * 1000;
const compactTimer = setInterval(() => {
  compactAll(app.log).catch((err) => app.log.error({ err }, "compaction sweep failed"));
}, COMPACT_MS);
compactTimer.unref();

// Expired sessions, messages past their retention, delivered welcomes and
// spent key packages are filtered on read but were never deleted.
const sweepTimer = setInterval(() => {
  sweep(app.log).catch((err) => app.log.error({ err }, "sweep failed"));
}, SWEEP_MS);
sweepTimer.unref();
setTimeout(() => sweep(app.log).catch(() => {}), 30_000).unref();

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(compactTimer);
  clearInterval(sweepTimer);
  app.log.info("shutting down");
  // systemd gives us 90 s by default; do not let a stuck connection use it all.
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("unhandledRejection", (err) => { app.log.error({ err }, "unhandled rejection"); });
process.on("SIGTERM", close);
process.on("SIGINT", close);

const port = Number(process.env.PORT || 8790);
await app.listen({ port, host: "127.0.0.1" });
app.log.info(`api listening on 127.0.0.1:${port}`);

export { requireSession };
