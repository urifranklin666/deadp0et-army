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

const rooms = new Map();          // group id (hex of the raw bytes) -> Set<socket>
const MAX_FRAME = 4096;           // a cursor packet is ~60 bytes
const MAX_PER_SEC = 40;           // generous for 20Hz, cheap to enforce
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const RP_ORIGIN = process.env.RP_ORIGIN;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const roomKey = (groupIdBytes) => Buffer.from(groupIdBytes).toString("hex");

/** Close every socket `userId` holds in the group. Called when membership is revoked. */
export function kickFromLive(groupIdBytes, userId) {
  const set = rooms.get(roomKey(groupIdBytes));
  if (!set) return 0;
  let n = 0;
  for (const s of set) {
    if (s.userId === userId) { try { s.close(4403, "removed"); } catch { /* already closing */ } n++; }
  }
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

export async function liveRoutes(app) {
  app.get("/api/mls/groups/:groupId/live", { websocket: true }, async (socket, req) => {
    const raw = String(req.params.groupId || "");
    if (raw.length > 64 || !B64_RE.test(raw)) { socket.close(4400, "bad group id"); return; }
    const groupIdBytes = Buffer.from(raw, "base64");
    const groupId = roomKey(groupIdBytes);   // one room per group, whatever the URL encoding

    // Browsers always send Origin on a WebSocket upgrade. The cookie is
    // SameSite=Lax, which does not cover cross-site WebSockets, so check it.
    const origin = req.headers.origin;
    if (origin && RP_ORIGIN && origin !== RP_ORIGIN) { socket.close(4403, "bad origin"); return; }

    // The WS upgrade carries cookies, so the same session check applies.
    const token = req.cookies?.dp_session;
    if (!token) { socket.close(4401, "unauthenticated"); return; }

    const auth = await q(
      `SELECT u.id, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
    if (!auth.rowCount) { socket.close(4401, "unauthenticated"); return; }

    const member = await q(
      `SELECT 1 FROM mls_groups g JOIN channel_members m ON m.channel_id = g.channel_id
        WHERE g.group_id = $1 AND m.user_id = $2`,
      [groupIdBytes, auth.rows[0].id]);
    if (!member.rowCount) { socket.close(4403, "not a member"); return; }

    socket.userId = auth.rows[0].id;
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
