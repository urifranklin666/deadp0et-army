import crypto from "node:crypto";
import { q } from "../db.js";

/**
 * Ephemeral presence relay.
 *
 * Fan-out only: frames are forwarded to the other members of the group and
 * then forgotten. Nothing here is written to the database, and nothing here
 * touches the MLS ratchet — payloads are sealed by the client under a key
 * derived from the MLS exporter, so this process handles opaque bytes.
 *
 * That separation is the whole point: cursors move at pointer-event rates,
 * and putting them in the ordered log would grow it without bound and burn
 * ratchet generations faster than receivers keep skipped keys.
 */

const rooms = new Map();          // groupId(b64) -> Set<socket>
const MAX_FRAME = 4096;           // a cursor packet is ~60 bytes
const MAX_PER_SEC = 40;           // generous for 20Hz, cheap to enforce
const MAX_SOCKETS_PER_USER = 4;   // per group: a few tabs, not a fan-out amplifier
// Same default as WebAuthn's in auth.js: never "unset means anything goes".
const RP_ORIGIN = process.env.RP_ORIGIN || "http://localhost";
const RECHECK_MS = Number(process.env.PRESENCE_RECHECK_MS) || 60_000;  // max time a revoked session keeps listening

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

/** Sockets `userId` already holds in this group. */
function held(groupId, userId) {
  let n = 0;
  for (const s of rooms.get(groupId) || []) if (s.userId === userId) n++;
  return n;
}

function join(groupId, socket) {
  let set = rooms.get(groupId);
  if (!set) { set = new Set(); rooms.set(groupId, set); }
  set.add(socket);
  return set;
}

function leave(groupId, socket) {
  const set = rooms.get(groupId);
  if (!set) return;
  set.delete(socket);
  if (!set.size) rooms.delete(groupId);
}

/**
 * Is this cookie still a live session for a member of the group?
 * Returns the user id, or null. Checked at connect and then periodically,
 * because a socket outlives the request that opened it: without the recheck,
 * logging out or leaving the channel would not stop the frames.
 */
async function authorise(token, groupId) {
  if (!token) return null;
  const { rows } = await q(
    `SELECT s.user_id FROM sessions s
       JOIN mls_groups g ON g.group_id = decode($2,'base64')
       JOIN channel_members m ON m.channel_id = g.channel_id AND m.user_id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token), groupId]);
  return rows[0]?.user_id ?? null;
}

export async function liveRoutes(app) {
  app.get("/api/mls/groups/:groupId/live", { websocket: true }, async (socket, req) => {
    const groupId = req.params.groupId;

    // Browsers send the session cookie on any same-site WebSocket upgrade,
    // and CORS does not apply to WebSockets. Without this check a page on
    // another origin of the same site could listen in as the user (seeing
    // only ciphertext, but still traffic timing and sizes) and inject frames.
    if (req.headers.origin !== RP_ORIGIN) {
      socket.close(4403, "forbidden");
      return;
    }

    // The WS upgrade carries cookies, so the same session check applies.
    // (One close code for both failures: telling an outsider "that group
    // exists but you're not in it" would be a membership oracle.)
    const token = req.cookies?.dp_session;
    let userId;
    try {
      userId = await authorise(token, groupId);
    } catch (err) {
      // Not a verdict on the caller: 1011 tells the client to retry, where
      // 4403 would tell it to give up for good.
      req.log.warn({ err }, "presence: auth check failed");
      socket.close(1011, "try again");
      return;
    }
    if (!userId) { socket.close(4403, "forbidden"); return; }
    if (held(groupId, userId) >= MAX_SOCKETS_PER_USER) {
      socket.close(4429, "too many connections");
      return;
    }
    socket.userId = userId;

    const peers = join(groupId, socket);
    req.log.info({ groupId, peers: peers.size }, "presence: joined");

    let windowStart = Date.now();
    let framesThisWindow = 0;

    socket.on("message", (data) => {
      if (data.length > MAX_FRAME) return;

      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; framesThisWindow = 0; }
      if (++framesThisWindow > MAX_PER_SEC) return;   // drop, don't disconnect

      for (const peer of peers) {
        if (peer === socket) continue;
        if (peer.readyState === 1) peer.send(data, { binary: true });
      }
    });

    const recheck = setInterval(async () => {
      const still = await authorise(token, groupId).catch(() => userId);   // a db blip is not a revocation
      if (!still) { leave(groupId, socket); socket.close(4403, "forbidden"); }
    }, RECHECK_MS);
    recheck.unref();

    // No disconnect notification is sent. The server holds no presence key, so
    // any such frame would be unencrypted and unattributable — a plaintext
    // control channel the client would have to trust. Clients expire a cursor
    // that has been silent for a few seconds instead.
    const done = () => { clearInterval(recheck); leave(groupId, socket); };
    socket.on("close", done);
    socket.on("error", done);
  });
}
