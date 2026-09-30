import crypto from "node:crypto";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { q, tx } from "../db.js";
import { putChallenge, takeChallenge } from "../challenges.js";

import { RP_ID, RP_ORIGIN, sha256 } from "../config.js";
import { invalidateMembers, recheckSockets } from "./notify.js";
import { sessionUser } from "../sessions.js";

export { sessionUser };
const SESSION_TTL_DAYS = 30;


async function createSession(req, reply, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5);
  // Only the hash is stored — a database leak does not yield usable sessions.
  // The passkey was proven just now: that's as fresh as a step-up.
  await q(
    `INSERT INTO sessions(user_id, token_hash, expires_at, reauthed_at, user_agent, last_seen_at)
     VALUES ($1,$2,$3, now(), $4, now())`,
    [userId, sha256(token), expires, String(req.headers["user-agent"] || "").slice(0, 300) || null]);
  reply.setCookie("dp_session", token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", expires,
  });
}


const REAUTH_WINDOW = "5 minutes";

/**
 * preHandler for sensitive operations: the session must have re-proved one
 * of the account's passkeys within REAUTH_WINDOW. 403 with a machine-readable
 * reason, so the client knows to run the step-up ceremony and retry.
 */
async function recentlyAuthed(token) {
  const { rows } = await q(
    "SELECT 1 FROM sessions WHERE token_hash=$1 AND reauthed_at > now() - $2::interval",
    [sha256(token ?? ""), REAUTH_WINDOW]);
  return rows.length > 0;
}

export async function requireRecentAuth(req, reply) {
  if (!(await recentlyAuthed(req.cookies?.dp_session))) return reply.code(403).send({ error: "reauth_required" });
}

/**
 * Check a WebAuthn assertion against a stored credential (optionally one of
 * `userId`'s), enforce the counter, and record the use. Returns { cred } or
 * { status, error }.
 */
async function verifyAssertion(response, expectedChallenge, userId) {
  if (typeof response?.id !== "string") return { status: 400, error: "malformed assertion" };
  const { rows } = await q(
    `SELECT c.*, u.handle FROM webauthn_credentials c
       JOIN users u ON u.id=c.user_id
      WHERE c.credential_id=$1 AND ($2::uuid IS NULL OR c.user_id = $2)`,
    [Buffer.from(response.id, "base64url"), userId ?? null]);
  if (!rows.length) return { status: 401, error: "unknown credential" };
  const cred = rows[0];
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: Buffer.from(cred.credential_id).toString("base64url"),
      publicKey: new Uint8Array(cred.public_key),
      counter: Number(cred.counter),
      transports: cred.transports ?? undefined,
    },
  }).catch(() => ({ verified: false }));
  if (!v.verified) return { status: 401, error: "assertion failed" };
  // A counter that fails to advance is the documented clone signal.
  const newCounter = v.authenticationInfo.newCounter;
  if (Number(cred.counter) > 0 && newCounter <= Number(cred.counter)) {
    return { status: 401, error: "authenticator counter regressed" };
  }
  await q("UPDATE webauthn_credentials SET counter=$1, last_used_at=now() WHERE id=$2", [newCounter, cred.id]);
  return { cred };
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
    // A deleted account's handle stays retired: see migration 007.
    const exists = await q(
      "SELECT 1 FROM users WHERE handle=$1 UNION ALL SELECT 1 FROM retired_handles WHERE handle=$1", [handle]);
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
      // Re-checked here: the handle may have been retired since /start
      // (its owner deleted the account while this challenge was pending).
      const retired = await c.query("SELECT 1 FROM retired_handles WHERE handle=$1", [pending.handle]);
      if (retired.rowCount) return false;
      await c.query("INSERT INTO users(id, handle) VALUES ($1,$2)", [userId, pending.handle]);
      await c.query(
        `INSERT INTO webauthn_credentials(user_id, credential_id, public_key, counter, transports)
         VALUES ($1,$2,$3,$4,$5)`,
        // credential.id is a base64url STRING; store the raw id bytes, which
        // is what login looks up (and hands back to the authenticator).
        [userId, Buffer.from(credential.id, "base64url"), Buffer.from(credential.publicKey),
         credential.counter ?? 0, credential.transports ?? null]
      );
      return true;
    }).catch((e) => { if (e.code === "23505") return false; throw e; });
    if (!created) return reply.code(409).send({ error: "handle taken" });
    await createSession(req, reply, userId);
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
    const r = await verifyAssertion(response, pending.challenge);
    if (r.error) return reply.code(r.status).send({ error: r.error });
    await createSession(req, reply, r.cred.user_id);
    return { ok: true, handle: r.cred.handle };
  });

  // --- step-up: re-prove the passkey inside an existing session ---
  //
  // A session cookie is bearer authority for 30 days. The operations that
  // would turn a stolen one into a permanent takeover or an irreversible loss
  // — adding or removing a passkey, deleting the account — also need a fresh
  // assertion from one of the account's own passkeys (see requireRecentAuth).

  // Whether this session's passkey proof is still fresh, so a client can
  // decide to prompt before trying, rather than provoke a 403.
  app.get("/api/auth/reauth", { preHandler: requireSession }, async (req) => ({
    recent: await recentlyAuthed(req.cookies.dp_session),
  }));

  app.post("/api/auth/reauth/start", { preHandler: requireSession, ...ceremonyLimit }, async (req) => {
    const { rows } = await q(
      "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1", [req.user.id]);
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "preferred",
      allowCredentials: rows.map((r) => ({
        id: Buffer.from(r.credential_id).toString("base64url"),
        transports: r.transports ?? undefined,
      })),
    });
    // Keyed per session, so step-ups in two tabs don't overwrite each other.
    await putChallenge(`reauth:${sha256(req.cookies.dp_session).toString("hex")}`, { challenge: options.challenge });
    return { options };
  });

  app.post("/api/auth/reauth/finish", { preHandler: requireSession }, async (req, reply) => {
    const pending = await takeChallenge(`reauth:${sha256(req.cookies.dp_session).toString("hex")}`);
    if (!pending) return reply.code(400).send({ error: "challenge expired" });
    const r = await verifyAssertion(req.body?.response, pending.challenge, req.user.id);
    if (r.error) return reply.code(r.status).send({ error: r.error });
    await q("UPDATE sessions SET reauthed_at = now() WHERE token_hash = $1", [sha256(req.cookies.dp_session)]);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.dp_session;
    if (token) {
      const { rows } = await q("DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id", [sha256(token)]);
      if (rows.length) recheckSockets(rows[0].user_id);
    }
    reply.clearCookie("dp_session", { path: "/" });
    return { ok: true };
  });

  // Every session of this user, this one included. Passkeys can't be
  // "changed" like a password, so this is how a lost or stolen device's
  // session is cut off.
  app.post("/api/auth/logout-all", { preHandler: requireSession }, async (req, reply) => {
    const { rowCount } = await q("DELETE FROM sessions WHERE user_id=$1", [req.user.id]);
    recheckSockets(req.user.id);
    reply.clearCookie("dp_session", { path: "/" });
    return { ok: true, ended: rowCount };
  });

  // --- more passkeys for this account ---
  //
  // Sign-in is passkey-only, so a single passkey is a single point of loss:
  // lose that authenticator and the account is gone. These let a signed-in
  // user add backups (another device, a security key) and prune old ones.

  app.get("/api/auth/passkeys", { preHandler: requireSession }, async (req) => {
    const { rows } = await q(
      `SELECT id, created_at AS "createdAt", last_used_at AS "lastUsedAt", transports
         FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at`, [req.user.id]);
    return { passkeys: rows };
  });

  app.post("/api/auth/passkeys/start", { preHandler: [requireSession, requireRecentAuth], ...ceremonyLimit }, async (req) => {
    const { rows } = await q(
      "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1", [req.user.id]);
    const options = await generateRegistrationOptions({
      rpName: "DEADP0ET.ARMY",
      rpID: RP_ID,
      userID: Buffer.from(req.user.id),      // same user handle as the first passkey
      userName: req.user.handle,
      attestationType: "none",
      // Don't let an authenticator that already holds one register again.
      excludeCredentials: rows.map((r) => ({
        id: Buffer.from(r.credential_id).toString("base64url"),
        transports: r.transports ?? undefined,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await putChallenge(`add:${req.user.id}`, { challenge: options.challenge });
    return { options };
  });

  // No fresh-auth check here: /start required one to issue this challenge,
  // and a window lapsing mid-ceremony would orphan the credential the
  // authenticator just created.
  app.post("/api/auth/passkeys/finish", { preHandler: requireSession }, async (req, reply) => {
    const pending = await takeChallenge(`add:${req.user.id}`);
    if (!pending) return reply.code(400).send({ error: "challenge expired" });
    const v = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    }).catch(() => ({ verified: false }));
    if (!v.verified) return reply.code(400).send({ error: "attestation failed" });
    const { credential } = v.registrationInfo;
    const added = await q(
      `INSERT INTO webauthn_credentials(user_id, credential_id, public_key, counter, transports)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
      [req.user.id, Buffer.from(credential.id, "base64url"), Buffer.from(credential.publicKey),
       credential.counter ?? 0, credential.transports ?? null]);
    if (!added.rowCount) return reply.code(409).send({ error: "that passkey is already registered" });
    return { ok: true, id: added.rows[0].id };
  });

  app.post("/api/auth/passkeys/:id/remove", { preHandler: [requireSession, requireRecentAuth] }, async (req, reply) => {
    // Never the last one: that would lock the account out for good.
    const out = await tx(async (c) => {
      const { rows } = await c.query(
        "SELECT id FROM webauthn_credentials WHERE user_id=$1 FOR UPDATE", [req.user.id]);
      if (!rows.some((r) => r.id === req.params.id)) return 404;
      if (rows.length === 1) return 409;
      await c.query("DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
      return 200;
    });
    if (out === 404) return reply.code(404).send({ error: "no such passkey" });
    if (out === 409) return reply.code(409).send({ error: "can't remove your only passkey" });
    return { ok: true };
  });

  /**
   * Delete this account. Channels it owns pass to the longest-standing admin
   * (else member); a channel with nobody else in it goes with the account.
   * The handle is retired for good. Everything keyed to the user (sessions,
   * passkeys, devices, key packages, memberships) cascades. The remaining
   * members' clients prune the account's leftover MLS leaves when they
   * reconcile against the roster.
   */
  app.post("/api/auth/delete", { preHandler: [requireSession, requireRecentAuth] }, async (req, reply) => {
    await tx(async (c) => {
      const { rows: owned } = await c.query(
        "SELECT channel_id FROM channel_members WHERE user_id=$1 AND role='owner'", [req.user.id]);
      for (const { channel_id: channelId } of owned) {
        const { rows: [heir] } = await c.query(
          `SELECT user_id FROM channel_members
            WHERE channel_id=$1 AND user_id<>$2
            ORDER BY (role = 'admin') DESC, joined_at ASC LIMIT 1`, [channelId, req.user.id]);
        if (heir) {
          await c.query("UPDATE channel_members SET role='owner' WHERE channel_id=$1 AND user_id=$2",
            [channelId, heir.user_id]);
        } else {
          await c.query("DELETE FROM channels WHERE id=$1", [channelId]);
        }
      }
      await c.query("INSERT INTO retired_handles(handle) VALUES ($1) ON CONFLICT DO NOTHING", [req.user.handle]);
      await c.query("DELETE FROM users WHERE id=$1", [req.user.id]);
    });
    invalidateMembers();
    recheckSockets(req.user.id);
    reply.clearCookie("dp_session", { path: "/" });
    return { ok: true };
  });

  // --- sessions ---
  //
  // Every signed-in browser holds a session. Listing them lets a user spot one
  // they don't recognise and end just that one, rather than everything.

  app.get("/api/auth/sessions", { preHandler: requireSession }, async (req) => {
    const { rows } = await q(
      `SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", user_agent AS "userAgent"
         FROM sessions WHERE user_id = $1 AND expires_at > now()
        ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`, [req.user.id]);
    return { sessions: rows.map((r) => ({ ...r, current: r.id === req.user.sessionId })) };
  });

  // Ending a session only ever protects the account, so it needs no step-up.
  app.post("/api/auth/sessions/:id/revoke", { preHandler: requireSession }, async (req, reply) => {
    const { rowCount } = await q(
      "DELETE FROM sessions WHERE id::text = $1 AND user_id = $2", [req.params.id, req.user.id]);
    if (!rowCount) return reply.code(404).send({ error: "no such session" });
    recheckSockets(req.user.id);
    if (req.params.id === req.user.sessionId) reply.clearCookie("dp_session", { path: "/" });
    return { ok: true, current: req.params.id === req.user.sessionId };
  });

  app.get("/api/auth/me", { preHandler: requireSession }, async (req) => ({ user: req.user }));
}
