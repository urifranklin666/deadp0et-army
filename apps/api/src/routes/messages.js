import { q, tx } from "../db.js";
import { requireSession } from "./auth.js";
import { revokeAccess } from "../membership.js";
import { invalidateMembers, recheckSockets } from "./notify.js";

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64");
const MAX_BODY = 256 * 1024;

/**
 * Ciphertext relay. `body` is an opaque Signal-protocol message: this file
 * never parses, inspects or transforms it. Sender fan-out to each recipient
 * device is the client's job, because only the client can encrypt per-session.
 */
export async function messageRoutes(app) {
  app.post("/api/channels", { preHandler: requireSession }, async (req, reply) => {
    const slug = String(req.body?.slug || "").toLowerCase().trim();
    const kind = req.body?.kind === "canvas" ? "canvas" : "chat";
    if (!/^[a-z0-9-]{2,48}$/.test(slug)) {
      return reply.code(400).send({ error: "slug must be 2-48 chars: a-z 0-9 -" });
    }
    const ch = await tx(async (c) => {
      const { rows } = await c.query(
        "INSERT INTO channels(slug, kind, created_by) VALUES ($1,$2,$3) RETURNING id, slug, kind",
        [slug, kind, req.user.id]
      ).catch((e) => { if (e.code === "23505") return null; throw e; }) ?? {};
      if (!rows) return null;
      await c.query(
        "INSERT INTO channel_members(channel_id, user_id, role) VALUES ($1,$2,'owner')",
        [rows[0].id, req.user.id]);
      return rows[0];
    });
    if (!ch) return reply.code(409).send({ error: "slug taken" });
    return { ...ch, role: "owner" };   // same shape as GET /api/channels
  });

  app.get("/api/channels", { preHandler: requireSession }, async (req) => {
    // groupId comes along so a reloading client can find its saved MLS state
    // instead of concluding the group doesn't exist and founding a second one.
    const { rows } = await q(
      `SELECT c.id, c.slug, c.kind, m.role,
              encode(g.group_id, 'base64') AS "groupId",
              g.epoch
         FROM channels c
         JOIN channel_members m ON m.channel_id = c.id
         LEFT JOIN mls_groups g ON g.channel_id = c.id
        WHERE m.user_id = $1
        ORDER BY c.created_at DESC`, [req.user.id]);
    return { channels: rows.map((r) => ({ ...r, epoch: r.epoch === null ? null : Number(r.epoch) })) };
  });

  // Leave a channel. Access to its ciphertext ends now; the MLS leaf is
  // removed by the next owner/admin client that reconciles the group against
  // this roster (a member cannot commit its own removal).
  app.post("/api/channels/:id/leave", { preHandler: requireSession }, async (req, reply) => {
    const out = await tx(async (c) => {
      const { rows } = await c.query(
        "SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2 FOR UPDATE",
        [req.params.id, req.user.id]);
      if (!rows.length) return 404;
      if (rows[0].role === "owner") return 409;
      await revokeAccess(c, req.params.id, req.user.id);
      return 200;
    });
    if (out === 404) return reply.code(404).send({ error: "not a member" });
    if (out === 409) return reply.code(409).send({ error: "the owner cannot leave their own channel" });
    invalidateMembers();   // leaving is rare; forget every cached roster
    recheckSockets(req.user.id);   // and stop relaying the channel's presence to them now
    return { ok: true };
  });

  // Promote a member to admin, or back. Owner only; the owner's own role is
  // not changeable here. Admins may remove members (see mls.js).
  app.post("/api/channels/:id/members/:handle/role", { preHandler: requireSession }, async (req, reply) => {
    const role = req.body?.role;
    if (!["admin", "member"].includes(role)) return reply.code(400).send({ error: "role must be admin or member" });
    const { rows: [me] } = await q(
      "SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!me) return reply.code(404).send({ error: "no such channel" });
    if (me.role !== "owner") return reply.code(403).send({ error: "only the owner can change roles" });
    const { rowCount } = await q(
      `UPDATE channel_members m SET role = $3 FROM users u
        WHERE m.channel_id = $1 AND m.user_id = u.id AND u.handle = $2 AND m.role <> 'owner'`,
      [req.params.id, req.params.handle, role]);
    if (!rowCount) return reply.code(404).send({ error: "no such member" });
    return { ok: true, role };
  });

  // Who is in a channel. Members only — the roster is itself sensitive.
  app.get("/api/channels/:id/members", { preHandler: requireSession }, async (req, reply) => {
    const { rows } = await q(
      `SELECT u.handle, m.role, m.joined_at AS "joinedAt"
         FROM channel_members m JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = $1
          AND EXISTS (SELECT 1 FROM channel_members me
                       WHERE me.channel_id = $1 AND me.user_id = $2)
        ORDER BY m.joined_at`, [req.params.id, req.user.id]);
    if (!rows.length) return reply.code(404).send({ error: "no such channel" });
    return { members: rows };
  });

  // Deliver one ciphertext per recipient device.
  app.post("/api/channels/:id/envelopes", { preHandler: requireSession }, async (req, reply) => {
    const items = Array.isArray(req.body?.envelopes) ? req.body.envelopes : [];
    if (!items.length) return reply.code(400).send({ error: "no envelopes" });
    if (items.length > 500) return reply.code(400).send({ error: "max 500 envelopes per call" });

    const member = await q(
      "SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2",
      [req.params.id, req.user.id]);
    if (!member.rowCount) return reply.code(403).send({ error: "not a member" });

    const sender = await q("SELECT id FROM devices WHERE id=$1 AND user_id=$2",
      [req.body?.senderDeviceId, req.user.id]);
    if (!sender.rowCount) return reply.code(400).send({ error: "unknown sender device" });

    const ttlDays = Number(req.body?.retentionDays);
    const expires = Number.isFinite(ttlDays) && ttlDays > 0
      ? new Date(Date.now() + ttlDays * 864e5) : null;

    const ids = await tx(async (c) => {
      const out = [];
      for (const e of items) {
        const body = unb64(e.body);
        if (body.length > MAX_BODY) throw Object.assign(new Error("envelope too large"), { statusCode: 413 });
        const { rows } = await c.query(
          `INSERT INTO envelopes(channel_id, sender_device_id, target_device_id, msg_type, body, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [req.params.id, sender.rows[0].id, e.targetDeviceId, e.type ?? 1, body, expires]);
        out.push(String(rows[0].id));
      }
      return out;
    });
    return { accepted: ids.length, ids };
  });

  // Long-poll-free pull: client asks for anything undelivered to its device.
  app.get("/api/devices/:id/envelopes", { preHandler: requireSession }, async (req, reply) => {
    const owned = await q("SELECT 1 FROM devices WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]);
    if (!owned.rowCount) return reply.code(404).send({ error: "no such device" });

    const { rows } = await q(
      `SELECT id, channel_id, sender_device_id, msg_type, body, created_at
         FROM envelopes
        WHERE target_device_id=$1 AND delivered_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY id LIMIT 200`, [req.params.id]);
    await q("UPDATE devices SET last_seen_at=now() WHERE id=$1", [req.params.id]);
    return {
      envelopes: rows.map((r) => ({
        id: String(r.id), channelId: r.channel_id, senderDeviceId: r.sender_device_id,
        type: r.msg_type, body: b64(r.body), createdAt: r.created_at,
      })),
    };
  });

  // Explicit ack, so a crash mid-decrypt doesn't silently lose messages.
  app.post("/api/devices/:id/ack", { preHandler: requireSession }, async (req, reply) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite);
    if (!ids.length) return reply.code(400).send({ error: "no ids" });
    const owned = await q("SELECT 1 FROM devices WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]);
    if (!owned.rowCount) return reply.code(404).send({ error: "no such device" });
    const { rowCount } = await q(
      `UPDATE envelopes SET delivered_at=now()
        WHERE target_device_id=$1 AND id = ANY($2::bigint[]) AND delivered_at IS NULL`,
      [req.params.id, ids]);
    return { acked: rowCount };
  });
}
