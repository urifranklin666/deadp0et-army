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

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

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

export async function liveRoutes(app) {
  app.get("/api/mls/groups/:groupId/live", { websocket: true }, async (socket, req) => {
    const groupId = req.params.groupId;

    // The WS upgrade carries cookies, so the same session check applies.
    const token = req.cookies?.dp_session;
    if (!token) { socket.close(4401, "unauthenticated"); return; }

    const auth = await q(
      `SELECT u.id, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
    if (!auth.rowCount) { socket.close(4401, "unauthenticated"); return; }

    const member = await q(
      `SELECT 1 FROM mls_groups g JOIN channel_members m ON m.channel_id = g.channel_id
        WHERE g.group_id = decode($1,'base64') AND m.user_id = $2`,
      [groupId, auth.rows[0].id]);
    if (!member.rowCount) { socket.close(4403, "not a member"); return; }

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

    // No disconnect notification is sent. The server holds no presence key, so
    // any such frame would be unencrypted and unattributable — a plaintext
    // control channel the client would have to trust. Clients expire a cursor
    // that has been silent for a few seconds instead.
    socket.on("close", () => leave(groupId, socket));

    socket.on("error", () => leave(groupId, socket));
  });
}
