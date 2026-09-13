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
  protocol: "signal-double-ratchet",
  transport: "https+ws",
}));

await app.register(authRoutes);
await app.register(keyRoutes);
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

const close = async () => {
  clearInterval(compactTimer);
  app.log.info("shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

const port = Number(process.env.PORT || 8790);
await app.listen({ port, host: "127.0.0.1" });
app.log.info(`api listening on 127.0.0.1:${port}`);

export { requireSession };
