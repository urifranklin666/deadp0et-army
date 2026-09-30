import crypto from "node:crypto";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { q, tx } from "../db.js";
import { putChallenge, takeChallenge } from "../challenges.js";

import { RP_ID, RP_ORIGIN, sha256 } from "../config.js";
const SESSION_TTL_DAYS = 30;


async function createSession(reply, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5);
  // Only the hash is stored — a database leak does not yield usable sessions.
  await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
    [userId, sha256(token), expires]);
  reply.setCookie("dp_session", token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", expires,
  });
}

/** The live session behind a cookie value: { id, handle }, or null. */
export async function sessionUser(token) {
  if (!token) return null;
  const { rows } = await q(
    `SELECT u.id, u.handle FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] ?? null;
}

/** Fastify preHandler: attaches req.user or 401s. */
export async function requireSession(req, reply) {
  const user = await sessionUser(req.cookies?.dp_session);
  if (!user) return reply.code(401).send({ error: "unauthenticated" });
  req.user = user;
}

// Starting a passkey ceremony is cheap to ask for and creates state (a
// challenge; on registration, soon an account), so it gets its own per-IP
// limit well under the global one. A person needs a handful a minute.
const ceremonyLimit = {
  config: {
    rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT) || 10, timeWindow: "1 minute" },
  },
};

export async function authRoutes(app) {
  // --- registration ---
  app.post("/api/auth/register/start", ceremonyLimit, async (req, reply) => {
    const handle = String(req.body?.handle || "").toLowerCase().trim();
    if (!/^[a-z0-9_]{3,32}$/.test(handle)) {
      return reply.code(400).send({ error: "handle must be 3-32 chars: a-z 0-9 _" });
    }
    const exists = await q("SELECT 1 FROM users WHERE handle=$1", [handle]);
    if (exists.rowCount) return reply.code(409).send({ error: "handle taken" });

    const userId = crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpName: "DEADP0ET.ARMY",
      rpID: RP_ID,
      userID: Buffer.from(userId),
      userName: handle,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    await putChallenge(`reg:${userId}`, { challenge: options.challenge, handle });
    return { userId, options };
  });

  app.post("/api/auth/register/finish", async (req, reply) => {
    const { userId, response } = req.body || {};
    const pending = await takeChallenge(`reg:${userId}`);
    if (!pending) return reply.code(400).send({ error: "challenge expired" });

    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    }).catch((e) => ({ verified: false, error: e.message }));
    if (!v.verified) return reply.code(400).send({ error: "attestation failed" });

    const { credential } = v.registrationInfo;
    // The handle was free at /start, but two registrations can race for it.
    const created = await tx(async (c) => {
      await c.query("INSERT INTO users(id, handle) VALUES ($1,$2)", [userId, pending.handle]);
      await c.query(
        `INSERT INTO webauthn_credentials(user_id, credential_id, public_key, counter, transports)
         VALUES ($1,$2,$3,$4,$5)`,
        [userId, Buffer.from(credential.id), Buffer.from(credential.publicKey),
         credential.counter ?? 0, credential.transports ?? null]
      );
      return true;
    }).catch((e) => { if (e.code === "23505") return false; throw e; });
    if (!created) return reply.code(409).send({ error: "handle taken" });
    await createSession(reply, userId);
    return { ok: true, userId, handle: pending.handle };
  });

  // --- authentication ---
  app.post("/api/auth/login/start", ceremonyLimit, async (req) => {
    const handle = String(req.body?.handle || "").toLowerCase().trim();
    const { rows } = await q(
      `SELECT c.credential_id, c.transports FROM webauthn_credentials c
         JOIN users u ON u.id=c.user_id WHERE u.handle=$1`, [handle]);
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "preferred",
      allowCredentials: rows.map((r) => ({
        id: Buffer.from(r.credential_id).toString("base64url"),
        transports: r.transports ?? undefined,
      })),
    });
    // Note: options are returned even for an unknown handle, so this endpoint
    // cannot be used to enumerate which handles exist.
    await putChallenge(`auth:${options.challenge}`, { challenge: options.challenge, handle });
    return { options };
  });

  app.post("/api/auth/login/finish", async (req, reply) => {
    const { response, challenge } = req.body || {};
    const pending = await takeChallenge(`auth:${challenge}`);
    if (!pending) return reply.code(400).send({ error: "challenge expired" });

    if (typeof response?.id !== "string") return reply.code(400).send({ error: "malformed assertion" });
    const idBuf = Buffer.from(response.id, "base64url");
    const { rows } = await q(
      `SELECT c.*, u.handle FROM webauthn_credentials c
         JOIN users u ON u.id=c.user_id WHERE c.credential_id=$1`, [idBuf]);
    if (!rows.length) return reply.code(401).send({ error: "unknown credential" });
    const cred = rows[0];

    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: Buffer.from(cred.credential_id).toString("base64url"),
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.counter),
        transports: cred.transports ?? undefined,
      },
    }).catch(() => ({ verified: false }));
    if (!v.verified) return reply.code(401).send({ error: "assertion failed" });

    // A counter that fails to advance is the documented clone signal.
    const newCounter = v.authenticationInfo.newCounter;
    if (Number(cred.counter) > 0 && newCounter <= Number(cred.counter)) {
      return reply.code(401).send({ error: "authenticator counter regressed" });
    }
    await q("UPDATE webauthn_credentials SET counter=$1, last_used_at=now() WHERE id=$2",
      [newCounter, cred.id]);
    await createSession(reply, cred.user_id);
    return { ok: true, handle: cred.handle };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.dp_session;
    if (token) await q("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
    reply.clearCookie("dp_session", { path: "/" });
    return { ok: true };
  });

  // Every session of this user, this one included. Passkeys can't be
  // "changed" like a password, so this is how a lost or stolen device's
  // session is cut off.
  app.post("/api/auth/logout-all", { preHandler: requireSession }, async (req, reply) => {
    const { rowCount } = await q("DELETE FROM sessions WHERE user_id=$1", [req.user.id]);
    reply.clearCookie("dp_session", { path: "/" });
    return { ok: true, ended: rowCount };
  });

  app.get("/api/auth/me", { preHandler: requireSession }, async (req) => ({ user: req.user }));
}
