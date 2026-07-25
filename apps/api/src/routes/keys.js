import { q, tx } from "../db.js";
import { requireSession } from "./auth.js";

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64");

/**
 * Public key directory. Everything here is public by construction — these are
 * the values other devices need in order to open a Signal session. No endpoint
 * in this file accepts or returns a private key.
 */
export async function keyRoutes(app) {
  // Register a device and its initial key material in one atomic step.
  app.post("/api/devices", { preHandler: requireSession }, async (req, reply) => {
    const { name, registrationId, identityKey, signedPreKey, kyberPreKey, oneTimePreKeys } = req.body || {};
    if (!Number.isInteger(registrationId) || !identityKey || !signedPreKey?.publicKey) {
      return reply.code(400).send({ error: "registrationId, identityKey and signedPreKey required" });
    }
    // PQXDH is not optional in this protocol version — a device without a
    // Kyber prekey could never be handed a usable bundle.
    if (!kyberPreKey?.publicKey || !kyberPreKey?.signature) {
      return reply.code(400).send({ error: "kyberPreKey (publicKey + signature) required" });
    }
    const otpks = Array.isArray(oneTimePreKeys) ? oneTimePreKeys : [];
    if (otpks.length > 200) return reply.code(400).send({ error: "max 200 one-time prekeys per upload" });

    const device = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO devices(user_id, name, registration_id, identity_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, registration_id)
           DO UPDATE SET identity_key=EXCLUDED.identity_key, last_seen_at=now()
         RETURNING id`,
        [req.user.id, name ?? null, registrationId, unb64(identityKey)]
      );
      const deviceId = rows[0].id;
      await c.query(
        `INSERT INTO signed_prekeys(device_id, key_id, public_key, signature)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (device_id, key_id) DO UPDATE
           SET public_key=EXCLUDED.public_key, signature=EXCLUDED.signature`,
        [deviceId, signedPreKey.keyId, unb64(signedPreKey.publicKey), unb64(signedPreKey.signature)]
      );
      await c.query(
        `INSERT INTO kyber_prekeys(device_id, key_id, public_key, signature)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (device_id, key_id) DO UPDATE
           SET public_key=EXCLUDED.public_key, signature=EXCLUDED.signature`,
        [deviceId, kyberPreKey.keyId, unb64(kyberPreKey.publicKey), unb64(kyberPreKey.signature)]
      );
      for (const k of otpks) {
        await c.query(
          `INSERT INTO one_time_prekeys(device_id, key_id, public_key)
           VALUES ($1,$2,$3) ON CONFLICT (device_id, key_id) DO NOTHING`,
          [deviceId, k.keyId, unb64(k.publicKey)]
        );
      }
      return deviceId;
    });
    return { deviceId: device };
  });

  // Top up one-time prekeys as they get consumed.
  app.post("/api/devices/:id/prekeys", { preHandler: requireSession }, async (req, reply) => {
    const keys = Array.isArray(req.body?.oneTimePreKeys) ? req.body.oneTimePreKeys : [];
    if (!keys.length) return reply.code(400).send({ error: "no keys supplied" });
    if (keys.length > 200) return reply.code(400).send({ error: "max 200 per upload" });
    const owned = await q("SELECT 1 FROM devices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!owned.rowCount) return reply.code(404).send({ error: "no such device" });

    await tx(async (c) => {
      for (const k of keys) {
        await c.query(
          `INSERT INTO one_time_prekeys(device_id, key_id, public_key)
           VALUES ($1,$2,$3) ON CONFLICT (device_id, key_id) DO NOTHING`,
          [req.params.id, k.keyId, unb64(k.publicKey)]);
      }
    });
    const { rows } = await q(
      "SELECT count(*)::int AS n FROM one_time_prekeys WHERE device_id=$1 AND consumed_at IS NULL",
      [req.params.id]);
    return { available: rows[0].n };
  });

  // Fetch a bundle to start a session. Consuming the one-time prekey inside the
  // transaction is what stops two peers being handed the same one.
  app.get("/api/keys/:handle", { preHandler: requireSession }, async (req, reply) => {
    const { rows: devs } = await q(
      `SELECT d.id, d.registration_id, d.identity_key
         FROM devices d JOIN users u ON u.id=d.user_id
        WHERE u.handle=$1`, [req.params.handle]);
    if (!devs.length) return reply.code(404).send({ error: "no devices for handle" });

    const bundles = [];
    for (const d of devs) {
      const bundle = await tx(async (c) => {
        const spk = await c.query(
          `SELECT key_id, public_key, signature FROM signed_prekeys
            WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1`, [d.id]);
        if (!spk.rowCount) return null;
        const kpk = await c.query(
          `SELECT key_id, public_key, signature FROM kyber_prekeys
            WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1`, [d.id]);
        if (!kpk.rowCount) return null;   // no PQXDH material => unusable bundle
        const otpk = await c.query(
          `UPDATE one_time_prekeys SET consumed_at=now()
            WHERE (device_id, key_id) = (
              SELECT device_id, key_id FROM one_time_prekeys
               WHERE device_id=$1 AND consumed_at IS NULL
               ORDER BY key_id FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING key_id, public_key`, [d.id]);
        return {
          deviceId: d.id,
          registrationId: d.registration_id,
          identityKey: b64(d.identity_key),
          signedPreKey: {
            keyId: spk.rows[0].key_id,
            publicKey: b64(spk.rows[0].public_key),
            signature: b64(spk.rows[0].signature),
          },
          kyberPreKey: {
            keyId: kpk.rows[0].key_id,
            publicKey: b64(kpk.rows[0].public_key),
            signature: b64(kpk.rows[0].signature),
          },
          // Absent when exhausted: the session still forms, with weaker
          // forward secrecy for the first message. Clients should top up.
          preKey: otpk.rowCount
            ? { keyId: otpk.rows[0].key_id, publicKey: b64(otpk.rows[0].public_key) }
            : null,
        };
      });
      if (bundle) bundles.push(bundle);
    }
    if (!bundles.length) return reply.code(404).send({ error: "no usable bundles" });
    return { handle: req.params.handle, bundles };
  });
}
