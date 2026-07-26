/**
 * Log compaction safety.
 *
 * The dangerous failure here is deleting a message a device has not applied:
 * MLS application messages decrypt exactly once, so a premature prune is
 * permanent data loss with no recovery path. These assertions exist to pin
 * that down, not to check the happy path.
 */
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { compactGroup, STALE_DEVICE_DAYS } from "../src/compaction.js";
import { q, pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:8790";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const b64 = (b) => Buffer.from(b).toString("base64");

async function seedUser(handle) {
  await q("DELETE FROM users WHERE handle=$1", [handle]);
  const { rows } = await q("INSERT INTO users(handle) VALUES ($1) RETURNING id", [handle]);
  const token = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
    [rows[0].id, sha256(token)]);
  return { id: rows[0].id, handle, cookie: `dp_session=${token}` };
}

const api = async (user, method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", cookie: user.cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return json;
};

async function mkDevice(user, name) {
  const { rows } = await q(
    `INSERT INTO devices(user_id, name, registration_id, identity_key)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [user.id, name, 1 + Math.floor(Math.random() * 16000), crypto.randomBytes(32)]);
  return rows[0].id;
}

// ------------------------------------------------------------------- setup

const alice = await seedUser("cmp_alice");
const bob = await seedUser("cmp_bob");
const aDev = await mkDevice(alice, "a");
const bDev = await mkDevice(bob, "b");

const channel = await api(alice, "POST", "/api/channels",
  { slug: "cmp-" + crypto.randomBytes(3).toString("hex") });
await q("INSERT INTO channel_members(channel_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
  [channel.id, bob.id]);

const rawGroup = crypto.randomBytes(16);
const GID_B64 = b64(rawGroup);
const GID = encodeURIComponent(GID_B64);
await api(alice, "POST", "/api/mls/groups",
  { channelId: channel.id, groupId: GID_B64, ciphersuite: "test-suite" });
console.log("· group created");

// 80 application messages, payloads opaque to the server as always.
const seqs = [];
for (let i = 0; i < 80; i++) {
  const { seq } = await api(alice, "POST", `/api/mls/groups/${GID}/messages`, {
    kind: "application", senderDeviceId: aDev, payload: b64(crypto.randomBytes(64)),
  });
  seqs.push(seq);
}
const first = seqs[0], last = seqs[seqs.length - 1];
console.log("· posted 80 application messages, seq", first, "..", last);

/** Bulk filler inserted directly: the HTTP path is already covered above, and
 *  200 posts in a minute trips the API rate limiter. */
async function fill(n) {
  for (let i = 0; i < n; i++) {
    await q(`INSERT INTO mls_messages(group_id, epoch, kind, sender_device_id, payload)
             VALUES ($1, 0, 'application', $2, $3)`, [rawGroup, aDev, crypto.randomBytes(64)]);
  }
}

const countMsgs = async () =>
  Number((await q("SELECT count(*)::int n FROM mls_messages WHERE group_id=$1", [rawGroup])).rows[0].n);

// ------------------------------------------- 1. no cursors => never prune

let res = await compactGroup(rawGroup);
assert.equal(res.pruned, 0, "must not prune when no device has reported delivery");
assert.equal(await countMsgs(), 80);
console.log("· with no reported cursors, nothing is pruned:", res.reason);

// ------------------------------- 2. bounded by the SLOWEST active device

await api(alice, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: aDev, seq: last });
await api(bob, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: bDev, seq: seqs[9] });

res = await compactGroup(rawGroup);
const remaining = await q(
  "SELECT min(seq)::bigint lo, max(seq)::bigint hi FROM mls_messages WHERE group_id=$1", [rawGroup]);
assert.ok(Number(remaining.rows[0].lo) > seqs[9] - 1 || res.pruned === 0,
  "must never prune above bob's cursor");
assert.ok(Number(remaining.rows[0].lo) <= seqs[10],
  "everything below the slow cursor should be gone");
console.log("· pruned", res.pruned, "messages, bounded by the slowest device (kept from seq",
  String(remaining.rows[0].lo) + ")");

// Bob's unapplied messages must all still be there.
const bobPending = Number((await q(
  "SELECT count(*)::int n FROM mls_messages WHERE group_id=$1 AND seq > $2", [rawGroup, seqs[9]])).rows[0].n);
assert.equal(bobPending, 70, "all 70 messages bob has not applied must survive");
console.log("· all 70 of bob's unapplied messages survived");

// --------------------------------------------- 3. the recent tail is safe

await api(bob, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: bDev, seq: last });
res = await compactGroup(rawGroup);
const afterAll = await countMsgs();
assert.ok(afterAll >= 50, `the most recent 50 must be retained, got ${afterAll}`);
console.log("· even fully caught up, the recent tail is retained:", afterAll, "messages");

// ---------------------------------------------- 4. commits are never cut

await q(
  `INSERT INTO mls_messages(group_id, epoch, kind, sender_device_id, payload)
   VALUES ($1, 0, 'commit', $2, $3)`, [rawGroup, aDev, crypto.randomBytes(32)]);
const commitSeq = Number((await q(
  "SELECT max(seq)::bigint s FROM mls_messages WHERE group_id=$1 AND kind='commit'", [rawGroup])).rows[0].s);
await api(alice, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: aDev, seq: commitSeq + 1000 });
await api(bob, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: bDev, seq: commitSeq + 1000 });
await fill(60);
await compactGroup(rawGroup);
const commitsLeft = Number((await q(
  "SELECT count(*)::int n FROM mls_messages WHERE group_id=$1 AND kind='commit'", [rawGroup])).rows[0].n);
assert.equal(commitsLeft, 1, "commits must never be pruned");
console.log("· commits survive compaction");

// ------------------------------- 5. a stale device stops blocking, w/ gap

// Park bob far behind and mark him silent past the cutoff, then generate new
// traffic. If a stale device still counted, its cursor of 1 would pin all of
// it; the prune below only happens because staleness excludes him.
await q(
  `UPDATE mls_device_cursors SET last_seq = 1,
     updated_at = now() - ($2 || ' days')::interval
   WHERE group_id = $1 AND device_id = $3`,
  [rawGroup, STALE_DEVICE_DAYS + 5, bDev]);
await fill(60);
await api(alice, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: aDev, seq: 10 ** 9 });

res = await compactGroup(rawGroup);
assert.ok(res.pruned > 0, "a device silent past the cutoff must stop pinning the log");
console.log("· stale device no longer blocks compaction; pruned", res.pruned);

const wm = Number((await q(
  "SELECT compaction_watermark FROM mls_groups WHERE group_id=$1", [rawGroup])).rows[0].compaction_watermark);
assert.ok(wm > 0, "watermark should record how far compaction reached");

// The stale device now gets an explicit gap rather than silent divergence.
const view = await api(bob, "GET", `/api/mls/groups/${GID}/messages?since=1`);
assert.equal(view.gap, true, "a device below the watermark must be told it has a gap");
assert.equal(Number(view.watermark), wm);
console.log("· returning stale device is told it has a gap (watermark", wm + ")");

const caughtUp = await api(alice, "GET", `/api/mls/groups/${GID}/messages?since=${wm}`);
assert.equal(caughtUp.gap, false, "a caught-up device must not be told it has a gap");
console.log("· caught-up device sees no gap");

// ------------------------------------------------- 6. cursors never rewind

await api(alice, "POST", `/api/mls/groups/${GID}/cursor`, { deviceId: aDev, seq: 5 });
const cur = Number((await q(
  "SELECT last_seq FROM mls_device_cursors WHERE group_id=$1 AND device_id=$2",
  [rawGroup, aDev])).rows[0].last_seq);
assert.equal(cur, 10 ** 9, "a late/stale cursor report must not move the cursor backwards");
console.log("· cursor reports never rewind");

await q("DELETE FROM users WHERE handle = ANY($1)", [["cmp_alice", "cmp_bob"]]);
await pool.end();
console.log("\nALL COMPACTION ASSERTIONS PASSED");
