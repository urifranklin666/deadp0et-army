import { q, tx } from "../db.js";
import { requireSession } from "./auth.js";
import { kickFromLive } from "./live.js";
import { B64, GROUP_ID, HANDLE, SUITE_NAME, UUID, obj } from "../schemas.js";

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64");
const MAX_PAYLOAD = 512 * 1024;
const MAX_WELCOMES = 100;
const MAX_PAYLOAD_B64 = Math.ceil(MAX_PAYLOAD / 3) * 4;
const groupParams = obj({ groupId: GROUP_ID }, ["groupId"]);
const deviceParams = obj({ id: UUID }, ["id"]);
const WELCOME = obj({
  ref: B64(64), deviceId: UUID, welcome: B64(MAX_PAYLOAD_B64), ratchetTree: B64(1_400_000),
}, ["ref", "deviceId", "welcome"]);
// Claims burn a single-use KeyPackage on someone else's device; keep the
// blast radius of an abusive account small even though it is authenticated.
const CLAIM_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };

/** Confirm the caller owns this device; returns its id or null. */
async function ownedDevice(userId, deviceId) {
  const { rows } = await q("SELECT id FROM devices WHERE id=$1 AND user_id=$2", [deviceId, userId]);
  return rows[0]?.id ?? null;
}

/** Confirm the caller is a member of the channel backing this group. */
async function groupMembership(userId, groupIdB64) {
  const { rows } = await q(
    `SELECT g.group_id, g.epoch, g.ciphersuite, g.channel_id, g.compaction_watermark
       FROM mls_groups g
       JOIN channel_members m ON m.channel_id = g.channel_id
      WHERE g.group_id = $1 AND m.user_id = $2`,
    [unb64(groupIdB64), userId]
  );
  return rows[0] ?? null;
}

export async function mlsRoutes(app) {
  // --------------------------------------------------------------- devices

  /**
   * Register an MLS device.
   *
   * Deliberately separate from POST /api/devices, which demands Signal
   * prekey material an MLS client has no reason to generate. `identity_key`
   * here holds the MLS credential identity, not a Signal identity key — the
   * column is shared, the protocols are not.
   */
  app.post("/api/mls/devices", {
    preHandler: requireSession,
    schema: { body: obj({ name: { type: "string", maxLength: 64 }, identity: B64(8192) }, ["identity"]) },
  }, async (req, reply) => {
    const { name, identity } = req.body;
    const idBytes = unb64(identity);
    if (idBytes.length > 4096) return reply.code(400).send({ error: "identity too large" });

    // Reuse the row for a device presenting the same identity, so a reload
    // does not accumulate phantom devices for one browser profile.
    const existing = await q(
      "SELECT id FROM devices WHERE user_id=$1 AND identity_key=$2 LIMIT 1",
      [req.user.id, idBytes]);
    if (existing.rowCount) {
      await q("UPDATE devices SET last_seen_at=now() WHERE id=$1", [existing.rows[0].id]);
      return { deviceId: existing.rows[0].id, reused: true };
    }
    const { rows } = await q(
      `INSERT INTO devices(user_id, name, registration_id, identity_key)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.user.id, name ?? "web", 1 + Math.floor(Math.random() * 2 ** 30), idBytes]);
    return { deviceId: rows[0].id, reused: false };
  });

  // ---------------------------------------------------------- key packages

  app.post("/api/mls/key-packages", {
    preHandler: requireSession,
    schema: { body: obj({
      deviceId: UUID, ciphersuite: SUITE_NAME,
      keyPackages: { type: "array", minItems: 1, maxItems: 100, items: obj({ ref: B64(64), keyPackage: B64(65536) }, ["ref", "keyPackage"]) },
    }, ["deviceId", "ciphersuite", "keyPackages"]) },
  }, async (req, reply) => {
    const { deviceId, ciphersuite, keyPackages: items } = req.body;
    const dev = await ownedDevice(req.user.id, deviceId);
    if (!dev) return reply.code(404).send({ error: "no such device" });

    await tx(async (c) => {
      for (const kp of items) {
        await c.query(
          `INSERT INTO mls_key_packages(device_id, ciphersuite, ref, key_package)
           VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO NOTHING`,
          [dev, ciphersuite, unb64(kp.ref), unb64(kp.keyPackage)]
        );
      }
    });
    const { rows } = await q(
      "SELECT count(*)::int AS n FROM mls_key_packages WHERE device_id=$1 AND claimed_at IS NULL", [dev]);
    return { available: rows[0].n };
  });

  // Claim one unclaimed KeyPackage per device belonging to `handle`.
  // SKIP LOCKED + the claimed_at write is what stops two concurrent adds
  // being handed the same package.
  //
  // A claim is only meaningful as the first half of an add into a group the
  // caller belongs to, so it requires that group: without it any account could
  // drain any user's packages and make them un-invitable. The claimer is
  // recorded so the Welcome on the add commit can be tied back to this claim.
  app.get("/api/mls/key-packages/:handle", {
    preHandler: requireSession, config: CLAIM_LIMIT,
    schema: {
      params: obj({ handle: HANDLE }, ["handle"]),
      querystring: obj({ ciphersuite: SUITE_NAME, groupId: GROUP_ID }, ["ciphersuite", "groupId"]),
    },
  }, async (req, reply) => {
    const suite = req.query.ciphersuite;
    const g = await groupMembership(req.user.id, req.query.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });

    const { rows: devs } = await q(
      `SELECT d.id FROM devices d JOIN users u ON u.id=d.user_id WHERE u.handle=$1`,
      [req.params.handle]);
    if (!devs.length) return reply.code(404).send({ error: "no devices for handle" });

    const claimed = [];
    for (const d of devs) {
      const got = await tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE mls_key_packages SET claimed_at=now(), claimed_by=$3
            WHERE id = (SELECT id FROM mls_key_packages
                         WHERE device_id=$1 AND ciphersuite=$2 AND claimed_at IS NULL
                         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING ref, key_package`, [d.id, suite, req.user.id]);
        return rows[0] ?? null;
      });
      if (got) {
        claimed.push({ deviceId: d.id, ref: b64(got.ref), keyPackage: b64(got.key_package) });
      }
    }
    if (!claimed.length) return reply.code(409).send({ error: "no unclaimed key packages; ask the device to top up" });
    return { handle: req.params.handle, keyPackages: claimed };
  });

  // ---------------------------------------------------------------- groups

  app.post("/api/mls/groups", {
    preHandler: requireSession,
    schema: { body: obj({ channelId: UUID, groupId: GROUP_ID, ciphersuite: SUITE_NAME }, ["channelId", "groupId", "ciphersuite"]) },
  }, async (req, reply) => {
    const { channelId, groupId, ciphersuite } = req.body;
    const member = await q(
      "SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2", [channelId, req.user.id]);
    if (!member.rowCount) return reply.code(403).send({ error: "not a member of that channel" });

    try {
      const { rows } = await q(
        `INSERT INTO mls_groups(channel_id, group_id, ciphersuite, created_by, epoch)
         VALUES ($1,$2,$3,$4,0) RETURNING id, epoch`,
        [channelId, unb64(groupId), ciphersuite, req.user.id]);
      return { id: rows[0].id, epoch: Number(rows[0].epoch) };
    } catch (e) {
      if (e.code === "23505") return reply.code(409).send({ error: "group already exists for that channel" });
      throw e;
    }
  });

  app.get("/api/mls/groups/:groupId", { preHandler: requireSession, schema: { params: groupParams } }, async (req, reply) => {
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    return { groupId: b64(g.group_id), epoch: Number(g.epoch), ciphersuite: g.ciphersuite, channelId: g.channel_id };
  });

  app.get("/api/mls/groups/:groupId/members", { preHandler: requireSession, schema: { params: groupParams } }, async (req, reply) => {
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    const { rows } = await q(
      `SELECT u.handle, cm.role, count(d.id)::int AS devices, max(d.last_seen_at) AS last_seen_at
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN devices d ON d.user_id = u.id
        WHERE cm.channel_id = $1
        GROUP BY u.id, u.handle, cm.role
        ORDER BY CASE cm.role WHEN 'owner' THEN 0 ELSE 1 END, u.handle`, [g.channel_id]);
    const own = rows.find((r) => r.handle === req.user.handle);
    return { members: rows.map((r) => ({ handle: r.handle, role: r.role, devices: r.devices, lastSeenAt: r.last_seen_at })), canRemove: own?.role === "owner" };
  });

  // -------------------------------------------------------------- messages

  /**
   * Append to the group log.
   *
   * A commit MUST carry the epoch it was built against. The conditional
   * UPDATE below is the fork guard: if another member already committed for
   * that epoch, zero rows update and we reject with 409 rather than accepting
   * a second, divergent history. The loser re-fetches and rebuilds.
   */
  app.post("/api/mls/groups/:groupId/messages", {
    preHandler: requireSession,
    schema: {
      params: groupParams,
      body: obj({
        kind: { type: "string", enum: ["application", "commit", "proposal"] },
        payload: B64(MAX_PAYLOAD_B64),
        epoch: { type: "integer", minimum: 0 },
        senderDeviceId: UUID,
        welcomes: { type: "array", maxItems: MAX_WELCOMES, items: WELCOME },
        retentionDays: { type: "number", minimum: 0, maximum: 3650 },
        removeHandle: HANDLE,
      }, ["kind", "payload", "senderDeviceId"]),
    },
  }, async (req, reply) => {
    const { kind, payload, epoch, senderDeviceId, welcomes, retentionDays, removeHandle } = req.body;
    const body = unb64(payload);
    if (body.length > MAX_PAYLOAD) return reply.code(413).send({ error: "payload too large" });

    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    const dev = await ownedDevice(req.user.id, senderDeviceId);
    if (!dev) return reply.code(400).send({ error: "unknown sender device" });

    // Welcomes grant channel membership, so they are accepted only where MLS
    // itself grants group membership: on a commit, for a KeyPackage this
    // caller claimed for exactly that device.
    const ws = welcomes ?? [];
    if (ws.length && kind !== "commit") return reply.code(400).send({ error: "welcomes ride only on commits" });

    // Commits never expire: compaction keeps them for the epoch chain, and a
    // retention policy that silently dropped one would strand every device
    // that had not yet applied it.
    const ttl = Number(retentionDays);
    const expires = kind !== "commit" && Number.isFinite(ttl) && ttl > 0 ? new Date(Date.now() + ttl * 864e5) : null;

    try {
      const result = await tx(async (c) => {
        let writeEpoch = Number(g.epoch);
        let removedUserId = null;

        if (kind === "commit") {
          if (!Number.isInteger(epoch)) {
            throw Object.assign(new Error("commit requires the epoch it was built against"), { statusCode: 400 });
          }
          const bump = await c.query(
            "UPDATE mls_groups SET epoch = epoch + 1 WHERE group_id=$1 AND epoch=$2 RETURNING epoch",
            [g.group_id, epoch]);
          if (!bump.rowCount) {
            const cur = await c.query("SELECT epoch FROM mls_groups WHERE group_id=$1", [g.group_id]);
            throw Object.assign(
              new Error(`epoch conflict: group is at ${Number(cur.rows[0].epoch)}, commit was built against ${epoch}`),
              { statusCode: 409 });
          }
          writeEpoch = epoch;   // the commit belongs to the epoch it transitions FROM
        }

        const { rows } = await c.query(
          `INSERT INTO mls_messages(group_id, epoch, kind, sender_device_id, payload, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq`,
          [g.group_id, writeEpoch, kind, dev, body, expires]);
        const seq = Number(rows[0].seq);

        // Welcomes ride along with the commit that added the members.
        //
        // Being welcomed into the group IS the grant of log access — otherwise
        // a member could hold group keys yet be unable to fetch the very
        // messages they can decrypt. So the add commit also materialises
        // channel membership for the welcomed device's owner.
        for (const w of ws) {
          const claim = await c.query(
            `SELECT 1 FROM mls_key_packages WHERE ref=$1 AND device_id=$2 AND claimed_by=$3`,
            [unb64(w.ref), w.deviceId, req.user.id]);
          if (!claim.rowCount) {
            throw Object.assign(new Error("welcome ref was not claimed by you for that device"), { statusCode: 400 });
          }
          await c.query(
            `INSERT INTO mls_welcomes(group_id, key_package_ref, target_device_id, payload, ratchet_tree, joined_at_seq)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [g.group_id, unb64(w.ref), w.deviceId, unb64(w.welcome),
             w.ratchetTree ? unb64(w.ratchetTree) : null, seq]);
          await c.query(
            `INSERT INTO channel_members(channel_id, user_id, role)
             SELECT $1, d.user_id, 'member' FROM devices d WHERE d.id = $2
             ON CONFLICT (channel_id, user_id) DO NOTHING`,
            [g.channel_id, w.deviceId]);
        }
        if (kind === "commit" && removeHandle) {
          const owner = await c.query(
            `SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND role='owner'`,
            [g.channel_id, req.user.id]);
          if (!owner.rowCount) throw Object.assign(new Error("only the room owner can remove members"), { statusCode: 403 });
          if (removeHandle === req.user.handle) throw Object.assign(new Error("the owner cannot remove themselves"), { statusCode: 400 });
          const removed = await c.query(
            `DELETE FROM channel_members cm USING users u
              WHERE cm.channel_id=$1 AND cm.user_id=u.id AND u.handle=$2 AND cm.role <> 'owner'
              RETURNING cm.user_id`,
            [g.channel_id, String(removeHandle)]);
          if (!removed.rowCount) throw Object.assign(new Error("no removable member with that handle"), { statusCode: 404 });
          removedUserId = removed.rows[0].user_id;
        }
        return { seq, epoch: writeEpoch, removedUserId };
      });
      // Membership is gone; close the presence sockets the removed user still
      // holds so they cannot keep injecting frames into the room.
      if (result.removedUserId) kickFromLive(g.group_id, result.removedUserId);
      return { seq: result.seq, epoch: result.epoch };
    } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
      // The partial unique index is the backstop if the guard is ever bypassed.
      if (e.code === "23505") return reply.code(409).send({ error: "a commit already exists for that epoch" });
      throw e;
    }
  });

  // Replay the log from a cursor. Members always apply in `seq` order.
  app.get("/api/mls/groups/:groupId/messages", {
    preHandler: requireSession,
    schema: {
      params: groupParams,
      querystring: obj({ since: { type: "integer", minimum: 0, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 200 } }),
    },
  }, async (req, reply) => {
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    const { since, limit } = req.query;

    const { rows } = await q(
      `SELECT seq, epoch, kind, sender_device_id, payload, created_at
         FROM mls_messages
        WHERE group_id=$1 AND seq > $2
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY seq LIMIT $3`,
      [g.group_id, since, limit]);

    // A cursor at or below the watermark means messages were compacted away
    // before this device applied them. They cannot be re-sent — MLS decrypts
    // once — so the client must recover via a fresh snapshot rather than
    // quietly carrying on with a hole in its state.
    const watermark = Number(g.compaction_watermark || 0);
    const gap = watermark > 0 && since < watermark;

    return {
      epoch: Number(g.epoch),
      watermark,
      gap,
      messages: rows.map((r) => ({
        seq: Number(r.seq), epoch: Number(r.epoch), kind: r.kind,
        senderDeviceId: r.sender_device_id, payload: b64(r.payload), createdAt: r.created_at,
      })),
    };
  });

  /**
   * Report how far a device has applied. This is the only input to
   * compaction: the server prunes strictly below the slowest active device,
   * because nothing it deletes can ever be reconstructed.
   */
  app.post("/api/mls/groups/:groupId/cursor", {
    preHandler: requireSession,
    schema: { params: groupParams, body: obj({ seq: { type: "integer", minimum: 0 }, deviceId: UUID }, ["seq", "deviceId"]) },
  }, async (req, reply) => {
    const { seq } = req.body;
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    const dev = await ownedDevice(req.user.id, req.body.deviceId);
    if (!dev) return reply.code(400).send({ error: "unknown device" });

    await q(
      `INSERT INTO mls_device_cursors(group_id, device_id, last_seq)
       VALUES ($1,$2,$3)
       ON CONFLICT (group_id, device_id) DO UPDATE
         -- never move a cursor backwards; a stale retry must not widen the
         -- prunable range for everyone else
         SET last_seq = GREATEST(mls_device_cursors.last_seq, EXCLUDED.last_seq),
             updated_at = now()`,
      [g.group_id, dev, seq]);
    return { ok: true };
  });

  // -------------------------------------------------------------- welcomes

  app.get("/api/mls/devices/:id/welcomes", { preHandler: requireSession, schema: { params: deviceParams } }, async (req, reply) => {
    const dev = await ownedDevice(req.user.id, req.params.id);
    if (!dev) return reply.code(404).send({ error: "no such device" });
    const { rows } = await q(
      `SELECT w.id, w.group_id, w.key_package_ref, w.payload, w.ratchet_tree, w.joined_at_seq,
              g.ciphersuite, g.channel_id
         FROM mls_welcomes w JOIN mls_groups g ON g.group_id = w.group_id
        WHERE w.target_device_id=$1 AND w.delivered_at IS NULL
        ORDER BY w.id LIMIT 50`, [dev]);
    return {
      welcomes: rows.map((r) => ({
        id: String(r.id), groupId: b64(r.group_id), ref: b64(r.key_package_ref),
        welcome: b64(r.payload), ratchetTree: r.ratchet_tree ? b64(r.ratchet_tree) : null,
        joinedAtSeq: r.joined_at_seq === null ? null : Number(r.joined_at_seq),
        ciphersuite: r.ciphersuite, channelId: r.channel_id,
      })),
    };
  });

  app.post("/api/mls/devices/:id/welcomes/ack", {
    preHandler: requireSession,
    schema: { params: deviceParams, body: obj({ ids: { type: "array", minItems: 1, maxItems: 100, items: { type: ["integer", "string"], pattern: "^[0-9]{1,18}$" } } }, ["ids"]) },
  }, async (req, reply) => {
    const ids = req.body.ids.map(Number);
    const dev = await ownedDevice(req.user.id, req.params.id);
    if (!dev) return reply.code(404).send({ error: "no such device" });
    const { rowCount } = await q(
      `UPDATE mls_welcomes SET delivered_at=now()
        WHERE target_device_id=$1 AND id = ANY($2::bigint[]) AND delivered_at IS NULL`,
      [dev, ids]);
    return { acked: rowCount };
  });
}
