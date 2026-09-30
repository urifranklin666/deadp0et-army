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
import { MlsClient, b64 } from "../../../packages/crypto/src/mls.js";
import { putChallenge, takeChallenge, challengeBackend, closeChallenges } from "../src/challenges.js";
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
    method, headers: { "content-type": "application/json", cookie: user.cookie, ...(user.headers || {}) },
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

// ------------------------------------------------- malformed ids are 4xx

for (const path of [
  "/api/mls/devices/not-a-uuid/welcomes",
  "/api/devices/not-a-uuid/envelopes",
]) {
  const r = await api(alice, "GET", path);
  assert.ok(r.status >= 400 && r.status < 500, `${path} should be a client error, got ${r.status}`);
}
const junkCursor = await api(alice, "POST", `/api/mls/groups/${encodeURIComponent(gid)}/cursor`,
  { deviceId: "not-a-uuid", seq: 1 });
assert.ok(junkCursor.status < 500, `junk device id should not 500 (got ${junkCursor.status})`);
console.log("· malformed ids are rejected as client errors, not 500s");

// ------------------------------------------------ roster + response headers

const roster = await fetch(`${BASE}/api/channels/${ch.id}/members`, { headers: { cookie: alice.cookie } });
assert.equal(roster.headers.get("cache-control"), "no-store", "api responses must not be cacheable");
assert.equal(roster.headers.get("x-content-type-options"), "nosniff");
assert.deepEqual((await roster.json()).members.map((m) => m.handle).sort(), ["hk_alice", "hk_bob"]);
const nosy = await seedUser("hk_nosy");
assert.equal((await api(nosy, "GET", `/api/channels/${ch.id}/members`)).status, 404,
  "a non-member must not see the roster");
console.log("· roster visible to members only; responses are no-store");

// ---------------------------------------------------- webauthn challenges

const ck = "test:" + crypto.randomBytes(8).toString("hex");
await putChallenge(ck, { challenge: "abc", handle: "hk_alice" });
assert.deepEqual(await takeChallenge(ck), { challenge: "abc", handle: "hk_alice" });
assert.equal(await takeChallenge(ck), null, "a challenge must be redeemable once only");
assert.equal(await takeChallenge("test:never-issued"), null);
console.log(`· challenges are single-use (${challengeBackend()} backend)`);

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

// Per-IP limit. A dedicated forwarded address keeps this from eating the
// budget of whatever suite runs next from 127.0.0.1.
const LIMIT = Number(process.env.KP_CLAIM_LIMIT) || 20;
const claimant = await seedUser("hk_claimant");
const from = (ip) => ({ ...claimant, headers: { "x-forwarded-for": ip } });
let limited = 0;
for (let i = 0; i < LIMIT + 3; i++) {
  const r = await api(from("10.99.0.1"), "GET", `/api/mls/key-packages/hk_alice?ciphersuite=test`);
  if (r.status === 429) limited++;
}
assert.equal(limited, 3, `claims past ${LIMIT}/min per address should be refused`);
const elsewhere = await api(from("10.99.0.2"), "GET", `/api/mls/key-packages/hk_alice?ciphersuite=test`);
assert.notEqual(elsewhere.status, 429, "another address has its own budget");
console.log("· key-package claims rate-limited per address (", limited, "refused )");

// Unused-claim cap: however many sessions or addresses, one user may hold
// only a few never-welcomed claims against another user's device.
const kps = [];
for (let i = 0; i < 6; i++) {
  const kp = await (await MlsClient.create("hk_bob")).newKeyPackage();
  kps.push({ ref: b64(kp.ref), keyPackage: b64(kp.encoded) });
}
const pub = await api(bob, "POST", "/api/mls/key-packages", { deviceId: bDev, ciphersuite: "hk", keyPackages: kps });
assert.equal(pub.json.available, 6);
const drainer = await seedUser("hk_drainer");
const statuses = [];
for (let i = 0; i < 4; i++) {
  statuses.push((await api({ ...drainer, headers: { "x-forwarded-for": `10.98.0.${i}` } },
    "GET", "/api/mls/key-packages/hk_bob?ciphersuite=hk")).status);
}
assert.deepEqual(statuses, [200, 200, 200, 429], "a 4th unused claim against one device must be refused");
// A fresh session for the same user is the same claimer.
const again = await q(
  "INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
  [drainer.id, sha256("second-session")]);
const second = await api({ cookie: "dp_session=second-session", headers: { "x-forwarded-for": "10.98.1.1" } },
  "GET", "/api/mls/key-packages/hk_bob?ciphersuite=hk");
assert.equal(second.status, 429, "a new session must not reset the unused-claim cap");
assert.equal((await api(bob, "GET", `/api/mls/devices/${bDev}/key-packages`)).json.available, 3,
  "the drain stops with packages left for real invites");
console.log("· unused claims capped per claimer; bob keeps packages for real invites");

// Claims no Welcome ever followed are reported stale, so the device can
// discard their private halves.
await q("UPDATE mls_key_packages SET claimed_at = now() - interval '2 days' WHERE device_id=$1 AND claimed_by=$2",
  [bDev, drainer.id]);
const status = (await api(bob, "GET", `/api/mls/devices/${bDev}/key-packages`)).json;
assert.equal(status.stale.length, 3, "day-old unwelcomed claims should be reported stale");
assert.ok(status.stale.every((r) => kps.some((k) => k.ref === r)));
console.log("· stale claims reported to the owning device");

// A KeyPackage must name its uploader: nobody publishes themselves as bob.
const posing = await (await MlsClient.create("hk_bob")).newKeyPackage();
const aliceKp = await api(alice, "POST", "/api/mls/key-packages", {
  deviceId: aDev, ciphersuite: "hk", keyPackages: [{ ref: b64(posing.ref), keyPackage: b64(posing.encoded) }] });
assert.equal(aliceKp.status, 400, "a key package naming someone else must be refused");
const junkKp = await api(alice, "POST", "/api/mls/key-packages", {
  deviceId: aDev, ciphersuite: "hk", keyPackages: [{ ref: "AAAA", keyPackage: "bm90IGEga2V5IHBhY2thZ2U=" }] });
assert.equal(junkKp.status, 400, "bytes that aren't a key package must be refused");
console.log("· key packages must carry their uploader's handle");

// ------------------------------------------------ presence revocation

const wsUrl = BASE.replace(/^http/, "ws") + `/api/mls/groups/${encodeURIComponent(gid)}/live`;
const ORIGIN = process.env.RP_ORIGIN;
const connect = (user, origin = ORIGIN) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl, { headers: { cookie: user.cookie, ...(origin ? { origin } : {}) } });
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

if (ORIGIN) {
  const foreign = await connect(alice, "https://evil.example");
  await sleep(200);
  assert.equal(foreign.closedWith, 4403, "an upgrade from another origin must be refused");
  console.log("· presence upgrade from a foreign origin refused");
}

// A user gets a few sockets per group (tabs), not an amplifier.
const extra = [];
for (let i = 0; i < 5; i++) extra.push(await connect(alice));
await sleep(200);
// Auth checks race, so which socket loses is not fixed — only how many.
assert.deepEqual(extra.map((w) => w.closedWith ?? null).sort(), [4429, null, null, null, null],
  "exactly one of 5 sockets from one user in one group should be refused");
extra.forEach((w) => w.close());
await sleep(200);
console.log("· presence sockets capped per user");

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

// ------------------------------------------------------- delivery hints

const hintUrl = BASE.replace(/^http/, "ws") + "/api/live";
const listen = (user, origin = ORIGIN) => new Promise((resolve, reject) => {
  const ws = new WebSocket(hintUrl, { headers: { ...(user ? { cookie: user.cookie } : {}), ...(origin ? { origin } : {}) } });
  ws.hints = [];
  ws.on("message", (d) => ws.hints.push(JSON.parse(d)));
  ws.on("close", (code) => { ws.closedWith = code; });
  ws.on("open", () => resolve(ws));
  ws.on("error", reject);
});

const anon = await listen(null);
const alien = await listen(alice, "https://evil.example");
await sleep(200);
assert.equal(anon.closedWith, 4401, "hints need a session");
assert.equal(alien.closedWith, 4403, "hints refuse foreign origins");

// Bob's session was revoked above; give him a fresh one.
const bob2 = { ...bob, cookie: "dp_session=hk-bob-2" };
await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
  [bob.id, sha256("hk-bob-2")]);
const hb = await listen(bob2);
const ho = await listen(outsider);
await sleep(100);
const posted = await post({ kind: "application" });
await sleep(200);
assert.deepEqual(hb.hints, [{ t: "log", g: gid, s: posted.json.seq }], "a member gets a hint for the new seq");
assert.equal(ho.hints.length, 0, "a non-member gets nothing");
hb.close(); ho.close();
console.log("· delivery hints reach members only, and need a session and our origin");

await q("DELETE FROM users WHERE handle = ANY($1)",
  [["hk_alice", "hk_bob", "hk_expired", "hk_claimant", "hk_outsider", "hk_drainer", "hk_nosy"]]);
await pool.end();
await closeChallenges();
console.log("\nALL HOUSEKEEPING ASSERTIONS PASSED");
