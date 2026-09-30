import "./env.js";
import crypto from "node:crypto";
import Redis from "ioredis";

/**
 * Fan-out between api nodes, for what lives in one process's memory:
 * delivery hints, presence frames, membership-cache invalidations.
 *
 * Every publish is delivered to this node's handlers at once, and — when
 * REDIS_URL is set — to every other node's over Redis pub/sub. A node drops
 * its own echoes, so local delivery never waits on (or depends on) Redis:
 * if Redis goes away, each node keeps serving the sockets it holds, which is
 * exactly the single-node behaviour. Nothing sent here is durable or
 * trusted; it's all "fetch now" or ciphertext that expires in seconds.
 *
 * Channels are subscribed on demand, so a node only receives traffic for
 * topics it has handlers for (a presence room with nobody on this node
 * costs it nothing).
 */

const NODE = crypto.randomBytes(8);           // tags our publishes, to drop echoes
const PREFIX = "dp:bus:";

let pub = null;
let sub = null;
if (process.env.REDIS_URL) {
  const opts = { maxRetriesPerRequest: 2, enableOfflineQueue: true };
  // Auto-pipelining batches the per-member hint publishes of one message.
  pub = new Redis(process.env.REDIS_URL, { ...opts, enableAutoPipelining: true });
  sub = new Redis(process.env.REDIS_URL, opts);
  // Losing Redis degrades to single-node; an unhandled 'error' would crash.
  pub.on("error", () => {});
  sub.on("error", () => {});
  sub.on("messageBuffer", (channel, message) => {
    if (message.length < NODE.length || NODE.equals(message.subarray(0, NODE.length))) return;
    deliver(channel.toString().slice(PREFIX.length), message.subarray(NODE.length), undefined);
  });
}

const handlers = new Map();                   // topic -> Set<fn(Buffer)>

function deliver(topic, data, local) {
  for (const fn of handlers.get(topic) || []) {
    try { fn(data, local); } catch { /* one bad handler must not starve the rest */ }
  }
}

/**
 * Send `data` (Buffer or string) to every handler of `topic`, on every node.
 * `local` is handed to this node's handlers only (e.g. the socket a frame
 * came from, so it isn't echoed back); other nodes' handlers get undefined.
 */
export function publish(topic, data, local) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  deliver(topic, buf, local);
  if (pub) pub.publish(PREFIX + topic, Buffer.concat([NODE, buf])).catch(() => {});
}

/**
 * Handle `topic` from any node. Returns the unsubscribe function. `fn`
 * receives (Buffer, local), including for this node's own publishes.
 */
export function subscribe(topic, fn) {
  let set = handlers.get(topic);
  if (!set) {
    set = new Set();
    handlers.set(topic, set);
    if (sub) sub.subscribe(PREFIX + topic).catch(() => {});
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size && handlers.get(topic) === set) {
      handlers.delete(topic);
      if (sub) sub.unsubscribe(PREFIX + topic).catch(() => {});
    }
  };
}

export const busBackend = () => (pub ? "redis" : "memory");

export async function closeBus() {
  for (const c of [pub, sub]) if (c) await c.quit().catch(() => c.disconnect());
}
