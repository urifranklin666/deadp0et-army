import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { pool, q } from "./db.js";
import { authRoutes, requireSession } from "./routes/auth.js";
import { keyRoutes } from "./routes/keys.js";
import { messageRoutes } from "./routes/messages.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  // nginx is the only thing in front of us and it sets these.
  trustProxy: true,
  bodyLimit: 1024 * 1024, // 1 MiB — envelopes are small; canvas state has its own cap
});

await app.register(cookie, { secret: process.env.SESSION_SECRET });
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

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

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) req.log.error({ err }, "unhandled");
  // Never leak internals to the client.
  reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
});

const close = async () => {
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
