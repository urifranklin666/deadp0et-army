/**
 * Housekeeping: what the server deletes, throttles, and cuts off.
 *
 *  - the retention sweep removes exactly the rows reads were already hiding,
 *    and never a commit
 *  - key-package claims are throttled per session, so one user cannot drain
 *    another's pool
 *  - a presence socket stops relaying once its session is revoked
 *
 * The api must run with a short presence recheck for the last part:
 *   PRESENCE_RECHECK_MS=300 node apps/api/src/server.js
 */
import crypto from "node:crypto";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { sweepExpired } from "../src/retention.js";
import { q, pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:8790";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedUser(handle) {
  await q("DELETE FROM users WHERE handle=$1", [handle]);
  const { rows } = await q("INSERT INTO users(handle) VALUES ($1) RETURNING id", [handle]);
  const token = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
    [rows[0].id, sha256(token)]);
  return { id: rows[0].id, handle, token, cookie: `dp_session=${token}` };
}

const api = async (user, method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", cookie: user.cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

async function mkDevice(user) {
  const { rows } = await q(
    `INSERT INTO devices(user_id, name, registration_id, identity_key)
     VALUES ($1,'hk',$2,$3) RETURNING id`,
    [user.id, 1 + Math.floor(Math.random() * 1e6), crypto.randomBytes(32)]);
  return rows[0].id;
}

const alice = await seedUser("hk_alice");
const bob = await seedUser("hk_bob");
const aDev = await mkDevice(alice);
const bDev = await mkDevice(bob);

// A channel + group with alice and bob in it.
const ch = (await api(alice, "POST", "/api/channels", { slug: "hk-" + crypto.randomBytes(3).toString("hex") })).json;
await q("INSERT INTO channel_members(channel_id, user_id) VALUES ($1,$2)", [ch.id, bob.id]);
const gidBytes = crypto.randomBytes(16);
const gid = gidBytes.toString("base64");
await api(alice, "POST", "/api/mls/groups", { channelId: ch.id, groupId: gid, ciphersuite: "test" });

// ------------------------------------------------------------ retention

const post = (body) => api(alice, "POST", `/api/mls/groups/${encodeURIComponent(gid)}/messages`,
  { senderDeviceId: aDev, payload: Buffer.from("x").toString("base64"), ...body });
const live = (await post({ kind: "application" })).json.seq;
const doomed = (await post({ kind: "application", retentionDays: 1 })).json.seq;
const commit = (await post({ kind: "commit", epoch: 0, retentionDays: 1 })).json.seq;
assert.ok(live && doomed && commit, "setup messages should post");

const commitRow = await q("SELECT expires_at FROM mls_messages WHERE seq=$1", [commit]);
assert.equal(commitRow.rows[0].expires_at, null, "a commit must never be given an expiry");

// Age the rows instead of waiting for them.
await q("UPDATE mls_messages SET expires_at = now() - interval '1 minute' WHERE seq = ANY($1)", [[doomed, commit]]);
const oldSession = await seedUser("hk_expired");
await q("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id=$1", [oldSession.id]);
const env = await q(
  `INSERT INTO envelopes(channel_id, sender_device_id, target_device_id, msg_type, body, delivered_at)
   VALUES ($1,$2,$3,1,'\\x00', now() - interval '2 days') RETURNING id`, [ch.id, aDev, bDev]);
const fresh = await q(
  `INSERT INTO envelopes(channel_id, sender_device_id, target_device_id, msg_type, body, delivered_at)
   VALUES ($1,$2,$3,1,'\\x00', now()) RETURNING id`, [ch.id, aDev, bDev]);

await sweepExpired();

const left = async (sql, params) => (await q(sql, params)).rowCount;
assert.equal(await left("SELECT 1 FROM mls_messages WHERE seq=$1", [doomed]), 0, "expired application message should go");
assert.equal(await left("SELECT 1 FROM mls_messages WHERE seq=$1", [commit]), 1, "commits are never swept, expiry or not");
assert.equal(await left("SELECT 1 FROM mls_messages WHERE seq=$1", [live]), 1, "unexpired messages stay");
assert.equal(await left("SELECT 1 FROM sessions WHERE user_id=$1", [oldSession.id]), 0, "expired session should go");
assert.equal(await left("SELECT 1 FROM sessions WHERE user_id=$1", [alice.id]), 1, "live session stays");
assert.equal(await left("SELECT 1 FROM envelopes WHERE id=$1", [env.rows[0].id]), 0, "long-delivered envelope should go");
assert.equal(await left("SELECT 1 FROM envelopes WHERE id=$1", [fresh.rows[0].id]), 1, "just-acked envelope keeps its grace period");
console.log("· retention sweep removes only what reads were already hiding; commits survive");

// -------------------------------------------------- claim rate limiting

const LIMIT = Number(process.env.KP_CLAIM_LIMIT) || 20;
const claimant = await seedUser("hk_claimant");
let limited = 0;
for (let i = 0; i < LIMIT + 3; i++) {
  const r = await api(claimant, "GET", `/api/mls/key-packages/hk_bob?ciphersuite=test`);
  if (r.status === 429) limited++;
}
assert.equal(limited, 3, `claims past ${LIMIT}/min per session should be refused`);
// Keyed per session: someone else on the same address is unaffected.
const other = await api(alice, "GET", `/api/mls/key-packages/hk_bob?ciphersuite=test`);
assert.notEqual(other.status, 429, "one session's claims must not throttle another's");
console.log("· key-package claims throttled per session (", limited, "refused )");

// ------------------------------------------------ presence revocation

const wsUrl = BASE.replace(/^http/, "ws") + `/api/mls/groups/${encodeURIComponent(gid)}/live`;
const connect = (user) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl, { headers: { cookie: user.cookie } });
  ws.got = [];
  ws.on("message", (d) => ws.got.push(d));
  ws.on("close", (code) => { ws.closedWith = code; });
  ws.on("open", () => resolve(ws));
  ws.on("error", reject);
});

const outsider = await seedUser("hk_outsider");
const refused = await connect(outsider);
await sleep(200);
assert.equal(refused.closedWith, 4403, "a non-member must be refused");

const wa = await connect(alice);
const wb = await connect(bob);
await sleep(100);
wa.send(Buffer.from("frame-1"));
await sleep(150);
assert.equal(wb.got.length, 1, "bob should receive alice's frame");

await q("DELETE FROM sessions WHERE user_id=$1", [bob.id]);    // bob logs out
await sleep(Number(process.env.PRESENCE_RECHECK_MS || 300) * 3);
assert.equal(wb.closedWith, 4403, "a revoked session's socket should be closed");
wa.send(Buffer.from("frame-2"));
await sleep(150);
assert.equal(wb.got.length, 1, "no frames after revocation");
console.log("· presence socket closed after its session was revoked");

wa.close();
await q("DELETE FROM users WHERE handle = ANY($1)",
  [["hk_alice", "hk_bob", "hk_expired", "hk_claimant", "hk_outsider"]]);
await pool.end();
console.log("\nALL HOUSEKEEPING ASSERTIONS PASSED");
