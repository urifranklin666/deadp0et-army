import { q } from "../db.js";
import { RECHECK_MS, RP_ORIGIN } from "../config.js";
import { sessionUser } from "../sessions.js";
import { publish, subscribe, busBackend } from "../bus.js";

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
 * Sockets live in whichever api node accepted them, so hints travel over
 * the bus (bus.js): one topic per user, which a node subscribes to only
 * while it holds one of that user's sockets.
 */

const subscribers = new Map();          // userId -> Set<socket>, on this node
const MAX_SOCKETS_PER_USER = 8;         // tabs

// Who is in a group, briefly cached: every message posted would otherwise
// cost a membership query. A membership change invalidates it explicitly;
// the TTL only bounds staleness if something forgets to.
const MEMBERS_TTL_MS = 5_000;
const memberCache = new Map();          // groupId(hex) -> { at, ids }

async function groupMembers(groupId) {
  const key = Buffer.from(groupId).toString("hex");
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < MEMBERS_TTL_MS) return hit.ids;
  const { rows } = await q(
    `SELECT m.user_id FROM mls_groups g JOIN channel_members m ON m.channel_id = g.channel_id
      WHERE g.group_id = $1`, [groupId]);
  const ids = rows.map((r) => r.user_id);
  memberCache.set(key, { at: Date.now(), ids });
  if (memberCache.size > 10_000) memberCache.clear();
  return ids;
}

// Every node caches membership, so a change made at one must reach them all.
subscribe("members", (data) => {
  const key = data.toString();
  if (key === "*") memberCache.clear();
  else memberCache.delete(key);
});

/** Call when a group's membership changes (no argument: forget them all). */
export function invalidateMembers(groupId) {
  publish("members", groupId === undefined ? "*" : Buffer.from(groupId).toString("hex"));
}

/**
 * Something that can end a user's access just happened (a sign-out, a
 * revoked session, leaving or removal from a channel, account deletion):
 * every node re-checks that user's live sockets now, closing any that no
 * longer pass, instead of waiting up to RECHECK_MS for the periodic check.
 * The check itself is the same one, so this can only close sooner.
 */
export function recheckSockets(userIds) {
  for (const id of new Set([].concat(userIds))) publish("recheck", String(id));
}

subscribe("recheck", (data) => {
  const id = data.toString();
  for (const socket of subscribers.get(id) || []) socket.recheck?.();
  for (const fn of recheckers) fn(id);
});

// Other socket kinds (the presence relay) register here to be re-checked too.
const recheckers = new Set();
export const onRecheck = (fn) => { recheckers.add(fn); };

// With one node and nobody listening, there's no one to tell: skip the query.
const nobodyListening = () => !subscribers.size && busBackend() === "memory";

function send(userIds, hint) {
  const frame = JSON.stringify(hint);
  for (const id of userIds) publish("user:" + id, frame);
}

/**
 * A message was appended to a group: hint every member (the sender's other
 * tabs and devices need it too), plus anyone this commit just removed, so
 * they learn it now rather than at their next fallback poll.
 */
export async function hintGroup(groupId, seq, alsoUserIds = []) {
  if (nobodyListening()) return;
  const members = await groupMembers(groupId);
  send(new Set([...members, ...alsoUserIds]),
    { t: "log", g: Buffer.from(groupId).toString("base64"), s: seq });
}

/** Welcomes were addressed to these devices: hint their owners. */
export async function hintWelcome(deviceIds) {
  if (nobodyListening() || !deviceIds.length) return;
  const { rows } = await q("SELECT DISTINCT user_id FROM devices WHERE id = ANY($1::uuid[])", [deviceIds]);
  send(rows.map((r) => r.user_id), { t: "welcome" });
}

export async function notifyRoutes(app) {
  app.get("/api/live", { websocket: true }, async (socket, req) => {
    // Same reasoning as the presence relay: CORS doesn't cover WebSockets.
    if (req.headers.origin !== RP_ORIGIN) { socket.close(4403, "forbidden"); return; }

    // Listen for close BEFORE awaiting anything: a socket that goes away
    // during the session check must not be registered afterwards and leak.
    let gone = false;
    let drop = () => { gone = true; };
    socket.on("close", () => drop());
    socket.on("error", () => drop());
    socket.on("message", () => {});     // nothing to say to us; ignore rather than error

    const token = req.cookies?.dp_session;
    let user;
    try {
      user = await sessionUser(token);
    } catch (err) {
      req.log.warn({ err }, "notify: auth check failed");
      socket.close(1011, "try again");
      return;
    }
    if (gone) return;
    if (!user) { socket.close(4401, "unauthenticated"); return; }

    let set = subscribers.get(user.id);
    if (set && set.size >= MAX_SOCKETS_PER_USER) { socket.close(4429, "too many connections"); return; }
    if (!set) {
      set = new Set();
      subscribers.set(user.id, set);
      // Deliver this user's hints, from any node, to their sockets here.
      set.off = subscribe("user:" + user.id, (frame) => {
        const text = frame.toString();
        for (const s of set) if (s.readyState === 1) s.send(text);
      });
    }
    set.add(socket);

    // A logged-out session stops getting hints within RECHECK_MS, or at once
    // when the logout is announced (recheckSockets).
    socket.recheck = async () => {
      const still = await sessionUser(token).catch(() => user);   // a db blip is not a revocation
      if (!still) { drop(); socket.close(4401, "unauthenticated"); }
    };
    const recheck = setInterval(socket.recheck, RECHECK_MS);
    recheck.unref();

    drop = () => {
      clearInterval(recheck);
      set.delete(socket);
      if (!set.size && subscribers.get(user.id) === set) {
        subscribers.delete(user.id);
        set.off();
      }
    };
  });
}
