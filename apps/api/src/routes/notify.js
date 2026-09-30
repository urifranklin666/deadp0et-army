import crypto from "node:crypto";
import { q } from "../db.js";

/**
 * Delivery hints: "group G has something new at seq S".
 *
 * Clients used to learn about new log entries only by polling every few
 * seconds. Instead, each signed-in tab holds one socket here and the api
 * pushes a hint when a message lands in one of the user's groups, or a
 * Welcome is addressed to one of their devices. A hint carries nothing the
 * server didn't already know and asks the client to trust nothing: it only
 * says "fetch now". Clients keep a slow poll as a fallback, so a lost hint
 * costs latency, never data.
 *
 * In-process, like the presence relay: fine for one api node. More nodes
 * would fan hints out over Redis pub/sub.
 */

const subscribers = new Map();          // userId -> Set<socket>
const MAX_SOCKETS_PER_USER = 8;         // tabs
const RP_ORIGIN = process.env.RP_ORIGIN || "http://localhost";
const RECHECK_MS = Number(process.env.PRESENCE_RECHECK_MS) || 60_000;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

async function sessionUser(token) {
  if (!token) return null;
  const { rows } = await q(
    "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()", [sha256(token)]);
  return rows[0]?.user_id ?? null;
}

function send(userIds, hint) {
  const frame = JSON.stringify(hint);
  for (const id of userIds) {
    for (const socket of subscribers.get(id) || []) {
      if (socket.readyState === 1) socket.send(frame);
    }
  }
}

/**
 * A message was appended to a group: hint every member (the sender's other
 * tabs and devices need it too), plus anyone this commit just removed, so
 * they learn it now rather than at their next fallback poll.
 */
export async function hintGroup(groupId, seq, alsoUserIds = []) {
  if (!subscribers.size) return;
  const { rows } = await q(
    `SELECT m.user_id FROM mls_groups g JOIN channel_members m ON m.channel_id = g.channel_id
      WHERE g.group_id = $1`, [groupId]);
  send(new Set([...rows.map((r) => r.user_id), ...alsoUserIds]),
    { t: "log", g: Buffer.from(groupId).toString("base64"), s: seq });
}

/** Welcomes were addressed to these devices: hint their owners. */
export async function hintWelcome(deviceIds) {
  if (!subscribers.size || !deviceIds.length) return;
  const { rows } = await q("SELECT DISTINCT user_id FROM devices WHERE id = ANY($1::uuid[])", [deviceIds]);
  send(rows.map((r) => r.user_id), { t: "welcome" });
}

export async function notifyRoutes(app) {
  app.get("/api/live", { websocket: true }, async (socket, req) => {
    // Same reasoning as the presence relay: CORS doesn't cover WebSockets.
    if (req.headers.origin !== RP_ORIGIN) { socket.close(4403, "forbidden"); return; }
    const token = req.cookies?.dp_session;
    let userId;
    try {
      userId = await sessionUser(token);
    } catch (err) {
      req.log.warn({ err }, "notify: auth check failed");
      socket.close(1011, "try again");
      return;
    }
    if (!userId) { socket.close(4401, "unauthenticated"); return; }

    let set = subscribers.get(userId);
    if (set && set.size >= MAX_SOCKETS_PER_USER) { socket.close(4429, "too many connections"); return; }
    if (!set) { set = new Set(); subscribers.set(userId, set); }
    set.add(socket);

    const drop = () => {
      clearInterval(recheck);
      set.delete(socket);
      if (!set.size && subscribers.get(userId) === set) subscribers.delete(userId);
    };
    // A logged-out session stops getting hints within RECHECK_MS.
    const recheck = setInterval(async () => {
      const still = await sessionUser(token).catch(() => userId);
      if (!still) { drop(); socket.close(4401, "unauthenticated"); }
    }, RECHECK_MS);
    recheck.unref();

    socket.on("message", () => {});     // nothing to say to us; ignore rather than error
    socket.on("close", drop);
    socket.on("error", drop);
  });
}
