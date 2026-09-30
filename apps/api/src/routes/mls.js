import { q, tx } from "../db.js";
import { requireSession } from "./auth.js";

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64");
const MAX_PAYLOAD = 512 * 1024;
// Claimed-but-never-welcomed packages one user may hold against another's
// devices within CLAIM_WINDOW. A real invite uses its claim within seconds.
const MAX_OUTSTANDING_CLAIMS = Number(process.env.KP_MAX_OUTSTANDING) || 3;
const CLAIM_WINDOW = "1 hour";
// A claim with no Welcome after this long never will; the device may forget it.
const STALE_CLAIM = "1 day";

/** Confirm the caller owns this device; returns its id or null. */
async function ownedDevice(userId, deviceId) {
  const { rows } = await q("SELECT id FROM devices WHERE id=$1 AND user_id=$2", [deviceId, userId]);
  return rows[0]?.id ?? null;
}

/** Confirm the caller is a member of the channel backing this group. */
async function groupMembership(userId, groupIdB64) {
  const { rows } = await q(
    `SELECT g.group_id, g.epoch, g.ciphersuite, g.channel_id, g.compaction_watermark, m.role
       FROM mls_groups g
       JOIN channel_members m ON m.channel_id = g.channel_id
      WHERE g.group_id = $1 AND m.user_id = $2`,
    [unb64(groupIdB64), userId]
  );
  return rows[0] ?? null;
}

async function keyPackageStatus(deviceId) {
  const { rows: [r] } = await q(
    `SELECT count(*) FILTER (WHERE claimed_at IS NULL)::int AS available,
            coalesce(array_agg(encode(ref, 'base64')) FILTER (
              WHERE claimed_at < now() - $2::interval AND welcomed_at IS NULL), '{}') AS stale
       FROM mls_key_packages WHERE device_id = $1`,
    [deviceId, STALE_CLAIM]);
  return { available: r.available, stale: r.stale };
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
  app.post("/api/mls/devices", { preHandler: requireSession }, async (req, reply) => {
    const { name, identity } = req.body || {};
    if (!identity) return reply.code(400).send({ error: "identity required" });
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

  app.post("/api/mls/key-packages", { preHandler: requireSession }, async (req, reply) => {
    const { deviceId, ciphersuite, keyPackages } = req.body || {};
    const items = Array.isArray(keyPackages) ? keyPackages : [];
    if (!ciphersuite || !items.length) {
      return reply.code(400).send({ error: "ciphersuite and keyPackages required" });
    }
    if (items.length > 100) return reply.code(400).send({ error: "max 100 key packages per upload" });
    if (!items.every((kp) => typeof kp?.ref === "string" && typeof kp?.keyPackage === "string")) {
      return reply.code(400).send({ error: "each key package needs ref and keyPackage" });
    }
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
    return keyPackageStatus(dev);
  });

  /**
   * How this device's published packages stand, without publishing any.
   * `stale` lists refs claimed long ago that no Welcome ever followed: the
   * device can delete their private halves, since nothing will open them.
   */
  app.get("/api/mls/devices/:id/key-packages", { preHandler: requireSession }, async (req, reply) => {
    const dev = await ownedDevice(req.user.id, req.params.id);
    if (!dev) return reply.code(404).send({ error: "no such device" });
    return keyPackageStatus(dev);
  });

  // Claim one unclaimed KeyPackage per device belonging to `handle`.
  // SKIP LOCKED + the claimed_at write is what stops two concurrent adds
  // being handed the same package.
  //
  // Claiming is destructive — each call burns one of the target's packages —
  // so two limits apply. A per-IP rate limit, tighter than the global one,
  // bounds raw volume. And a claimer may hold only a few unused claims
  // against any one user at a time: that is what stops a drain, however many
  // sessions or addresses it comes from, since an unused claim is exactly
  // what a drain leaves behind and a real invite does not.
  app.get("/api/mls/key-packages/:handle", {
    preHandler: requireSession,
    config: {
      rateLimit: {
        max: Number(process.env.KP_CLAIM_LIMIT) || 20,
        timeWindow: "1 minute",
      },
    },
  }, async (req, reply) => {
    const suite = req.query?.ciphersuite;
    if (!suite) return reply.code(400).send({ error: "ciphersuite query param required" });

    const { rows: devs } = await q(
      `SELECT d.id FROM devices d JOIN users u ON u.id=d.user_id WHERE u.handle=$1`,
      [req.params.handle]);
    if (!devs.length) return reply.code(404).send({ error: "no devices for handle" });

    const { rows: [held] } = await q(
      `SELECT count(*)::int AS n FROM mls_key_packages
        WHERE claimed_by = $1 AND device_id = ANY($2::uuid[])
          AND welcomed_at IS NULL AND claimed_at > now() - $3::interval`,
      [req.user.id, devs.map((d) => d.id), CLAIM_WINDOW]);
    if (held.n >= MAX_OUTSTANDING_CLAIMS * devs.length) {
      return reply.code(429).send({ error: "too many unused key-package claims for that user; try again later" });
    }

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

  app.post("/api/mls/groups", { preHandler: requireSession }, async (req, reply) => {
    const { channelId, groupId, ciphersuite } = req.body || {};
    if (!channelId || !groupId || !ciphersuite) {
      return reply.code(400).send({ error: "channelId, groupId and ciphersuite required" });
    }
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

  app.get("/api/mls/groups/:groupId", { preHandler: requireSession }, async (req, reply) => {
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    return { groupId: b64(g.group_id), epoch: Number(g.epoch), ciphersuite: g.ciphersuite, channelId: g.channel_id };
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
  app.post("/api/mls/groups/:groupId/messages", { preHandler: requireSession }, async (req, reply) => {
    const { kind, payload, epoch, senderDeviceId, welcomes, removes, retentionDays } = req.body || {};
    if (!["application", "commit", "proposal"].includes(kind)) {
      return reply.code(400).send({ error: "kind must be application|commit|proposal" });
    }
    if (!payload) return reply.code(400).send({ error: "payload required" });
    const body = unb64(payload);
    if (body.length > MAX_PAYLOAD) return reply.code(413).send({ error: "payload too large" });

    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    const dev = await ownedDevice(req.user.id, senderDeviceId);
    if (!dev) return reply.code(400).send({ error: "unknown sender device" });

    const adds = Array.isArray(welcomes) ? welcomes : [];
    if (adds.length && kind !== "commit") {
      return reply.code(400).send({ error: "welcomes only ride along with a commit" });
    }

    // Removal. The commit itself is opaque, so the server cannot see who it
    // removes from the MLS group; `removes` names them so their access to the
    // channel's ciphertext ends with the same transaction. Cryptographically
    // they are already out — the next epoch's keys never reach them. Only a
    // channel owner or admin may do this, and never to an owner or themself.
    const drops = Array.isArray(removes) ? [...new Set(removes.map(String))] : [];
    if (drops.length) {
      if (kind !== "commit") return reply.code(400).send({ error: "removes only ride along with a commit" });
      if (!["owner", "admin"].includes(g.role)) {
        return reply.code(403).send({ error: "only a channel owner or admin can remove members" });
      }
      if (drops.includes(req.user.handle)) return reply.code(400).send({ error: "cannot remove yourself" });
    }

    // Retention applies to application traffic only. A commit or proposal
    // that expired would vanish from the replay while compaction still
    // assumes it is there, and a member replaying epochs could never catch up.
    const ttl = Number(retentionDays);
    const expires = kind === "application" && Number.isFinite(ttl) && ttl > 0
      ? new Date(Date.now() + ttl * 864e5) : null;

    try {
      return await tx(async (c) => {
        let writeEpoch = Number(g.epoch);

        // A Welcome grants channel membership (below), so it must be backed
        // by a KeyPackage that THIS user claimed from the target device and
        // has not already spent on another Welcome. Without that, any member
        // could pull an arbitrary user into channels by naming their device,
        // or replay one old claim into channel after channel. Marking it
        // spent here rolls back with the rest if the commit is refused.
        for (const w of adds) {
          const ok = typeof w?.ref === "string" && typeof w?.welcome === "string" && w.deviceId
            ? await c.query(
                `UPDATE mls_key_packages SET welcomed_at = now()
                  WHERE ref=$1 AND device_id::text=$2 AND claimed_by=$3
                    AND claimed_at IS NOT NULL AND welcomed_at IS NULL`,
                [unb64(w.ref), String(w.deviceId), req.user.id])
            : { rowCount: 0 };
          if (!ok.rowCount) {
            throw Object.assign(new Error("welcome does not match a claimed key package for that device"),
              { statusCode: 400 });
          }
        }

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
        //
        // The joiner's delivery cursor is seeded at the add commit too. Until
        // it reports one itself it would otherwise be invisible to compaction,
        // which could prune messages it has not yet had a chance to fetch.
        for (const w of adds) {
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
          await c.query(
            `INSERT INTO mls_device_cursors(group_id, device_id, last_seq)
             VALUES ($1,$2,$3) ON CONFLICT (group_id, device_id) DO NOTHING`,
            [g.group_id, w.deviceId, seq]);
        }
        for (const handle of drops) {
          const { rows: gone } = await c.query(
            `DELETE FROM channel_members m USING users u
              WHERE m.channel_id = $1 AND m.user_id = u.id AND u.handle = $2 AND m.role <> 'owner'
          RETURNING m.user_id`, [g.channel_id, handle]);
          if (!gone.length) {
            throw Object.assign(new Error(`${handle} is not a removable member of this channel`),
              { statusCode: 400 });
          }
          // Their devices stop pinning compaction and lose any pending join.
          await c.query(
            `DELETE FROM mls_device_cursors
              WHERE group_id = $1 AND device_id IN (SELECT id FROM devices WHERE user_id = $2)`,
            [g.group_id, gone[0].user_id]);
          await c.query(
            `DELETE FROM mls_welcomes
              WHERE group_id = $1 AND delivered_at IS NULL
                AND target_device_id IN (SELECT id FROM devices WHERE user_id = $2)`,
            [g.group_id, gone[0].user_id]);
        }
        return { seq, epoch: writeEpoch };
      });
    } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
      // The partial unique index is the backstop if the guard is ever bypassed.
      if (e.code === "23505") return reply.code(409).send({ error: "a commit already exists for that epoch" });
      throw e;
    }
  });

  // Replay the log from a cursor. Members always apply in `seq` order.
  app.get("/api/mls/groups/:groupId/messages", { preHandler: requireSession }, async (req, reply) => {
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    // Malformed paging input falls back to defaults rather than reaching
    // Postgres as NaN and surfacing as a 500.
    const sinceRaw = Number(req.query?.since ?? 0);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    const limitRaw = Number(req.query?.limit ?? 200);
    const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 500) : 200;

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
  app.post("/api/mls/groups/:groupId/cursor", { preHandler: requireSession }, async (req, reply) => {
    const seq = Number(req.body?.seq);
    if (!Number.isFinite(seq) || seq < 0) return reply.code(400).send({ error: "seq required" });
    const g = await groupMembership(req.user.id, req.params.groupId);
    if (!g) return reply.code(404).send({ error: "no such group" });
    const dev = await ownedDevice(req.user.id, req.body?.deviceId);
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

  app.get("/api/mls/devices/:id/welcomes", { preHandler: requireSession }, async (req, reply) => {
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

  app.post("/api/mls/devices/:id/welcomes/ack", { preHandler: requireSession }, async (req, reply) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite);
    if (!ids.length) return reply.code(400).send({ error: "no ids" });
    const dev = await ownedDevice(req.user.id, req.params.id);
    if (!dev) return reply.code(404).send({ error: "no such device" });
    const { rowCount } = await q(
      `UPDATE mls_welcomes SET delivered_at=now()
        WHERE target_device_id=$1 AND id = ANY($2::bigint[]) AND delivered_at IS NULL`,
      [dev, ids]);
    return { acked: rowCount };
  });
}
