import "./env.js";
import Redis from "ioredis";

/**
 * WebAuthn challenges: short-lived and single-use.
 *
 * Held in Redis when REDIS_URL is set, so a challenge issued by one api
 * process can be redeemed at another and survives a restart mid-login.
 * Without Redis they stay in this process, which is fine for one node.
 * Either way `take` is atomic: a challenge can be redeemed at most once.
 */

export const CHALLENGE_TTL_S = 120;
const PREFIX = "dp:chal:";

let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
  // Logged by the caller's failures; an unhandled 'error' event would crash.
  redis.on("error", () => {});
}

const memory = new Map();

export async function putChallenge(key, value) {
  if (redis) {
    await redis.set(PREFIX + key, JSON.stringify(value), "EX", CHALLENGE_TTL_S);
    return;
  }
  memory.set(key, { value, exp: Date.now() + CHALLENGE_TTL_S * 1000 });
  if (memory.size > 5000) {
    for (const [k, e] of memory) if (e.exp < Date.now()) memory.delete(k);
  }
}

/** Redeem a challenge. Returns its value once, then null forever. */
export async function takeChallenge(key) {
  if (redis) {
    const raw = await redis.getdel(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }
  const e = memory.get(key);
  memory.delete(key);
  return e && e.exp > Date.now() ? e.value : null;
}

export const challengeBackend = () => (redis ? "redis" : "memory");

export async function closeChallenges() {
  if (redis) await redis.quit().catch(() => redis.disconnect());
}
