/**
 * GroupSession, driven from Node against a LOCAL api.
 *
 * The browser suites need the live origin because of WebAuthn. The session
 * layer doesn't: sessions are seeded straight into Postgres, IndexedDB is
 * in-memory, and fetch is pointed at the api with the right cookie. That
 * makes the MLS bookkeeping in session.js testable on every change.
 *
 * Covers the properties that are easy to break and silent when broken:
 *  - a send never skips other members' unfetched messages
 *  - concurrent send/sync never corrupts the ratchet
 *  - a device can be invited to more than one group (key-package pool)
 *  - a refused commit rolls local state back instead of forking the device
 *
 *   BASE=http://127.0.0.1:8790 node apps/web/test/session.test.mjs
 */
import "fake-indexeddb/auto";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { q, pool } from "../../api/src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:8790";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

// session.js calls fetch with relative paths and relies on the browser's
// cookie jar. Stand in for both; `as()` picks whose cookie rides along.
let cookie = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (path, init = {}) =>
  realFetch(BASE + path, { ...init, headers: { ...(init.headers || {}), cookie } });
const as = (user) => { cookie = user.cookie; };

const { GroupSession, ensureDevice } = await import("../src/lib/session.js");
const { api } = await import("../src/lib/api.js");

async function seedUser(handle) {
  await q("DELETE FROM users WHERE handle=$1", [handle]);
  const { rows } = await q("INSERT INTO users(handle) VALUES ($1) RETURNING id", [handle]);
  const token = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
    [rows[0].id, sha256(token)]);
  return { id: rows[0].id, handle, cookie: `dp_session=${token}` };
}

const texts = (s) => s.history.filter((h) => h.text !== undefined && !h.mine).map((h) => h.text);
const errors = (s) => s.history.filter((h) => h.error);
const settle = () => new Promise((r) => setTimeout(r, 50));

const alice = await seedUser("sess_alice");
const bob = await seedUser("sess_bob");

as(alice); const aDev = (await ensureDevice(alice.handle)).deviceId;
as(bob); const bDev = (await ensureDevice(bob.handle)).deviceId;
const pooled = await q(
  "SELECT count(*)::int AS n FROM mls_key_packages WHERE device_id=$1 AND claimed_at IS NULL", [bDev]);
assert.ok(pooled.rows[0].n >= 3, "a device should publish a pool of key packages");
console.log("· devices provisioned; bob has", pooled.rows[0].n, "unclaimed key packages");

/** Alice founds a channel and brings bob in. Returns both sides' sessions. */
async function room(slug) {
  as(alice);
  const ch = await api.createChannel(slug + "-" + crypto.randomBytes(3).toString("hex"), "chat");
  const A = new GroupSession(alice.handle, aDev, ch);
  await A.open(null);
  await A.invite(bob.handle);

  as(bob);
  const B = new GroupSession(bob.handle, bDev, { ...ch, groupId: A.groupId });
  assert.equal(await B.open(A.groupId), false, "bob has no local state yet");
  assert.equal(await B.tryJoin(), true, "bob should join from the welcome");
  await settle();                                   // let the post-join top-up finish
  assert.equal(A.epoch, B.epoch, "both sides agree on the epoch");
  return { A, B };
}

// ------------------------------------------------ a send must not skip

const { A, B } = await room("skip");

as(bob); await B.send("from bob, while alice was not looking");
// Alice sends WITHOUT syncing first. Her cursor is behind bob's message.
as(alice); await A.send("from alice");
await A.sync();
assert.deepEqual(texts(A), ["from bob, while alice was not looking"],
  "alice's own send must not jump her cursor past bob's message");
assert.equal(errors(A).length, 0, "alice should not try to decrypt her own message");
as(bob); await B.sync();
assert.deepEqual(texts(B), ["from alice"]);
assert.equal(errors(B).length, 0);
console.log("· sending never skips another member's unfetched message");

// ---------------------------------------- concurrent send + sync is safe

as(alice);
const N = 12;
await Promise.all(Array.from({ length: N }, (_, i) =>
  i % 2 ? A.sync() : A.send(`burst ${i}`)));
as(bob); await B.sync();
const burst = texts(B).filter((t) => t.startsWith("burst"));
assert.equal(burst.length, N / 2, "every concurrent send should decrypt");
assert.equal(errors(B).length, 0, "no ratchet corruption under concurrency");
console.log("· interleaved send/sync keeps the ratchet consistent (", burst.length, "msgs )");

// ------------------------------------------ a device joins a second group

const second = await room("second");
as(alice); await second.A.send("second room works");
as(bob); await second.B.sync();
assert.deepEqual(texts(second.B), ["second room works"]);
console.log("· bob joined a second group from a pooled key package");

const left = await q(
  "SELECT count(*)::int AS n FROM mls_key_packages WHERE device_id=$1 AND claimed_at IS NULL", [bDev]);
assert.ok(left.rows[0].n >= 3, "the pool should be topped up after joins");
console.log("· pool refilled to", left.rows[0].n);

// ----------------------------------------- refused commit rolls back

const carol = await seedUser("sess_carol");
as(carol); await ensureDevice(carol.handle);

as(alice);
const epochBefore = A.epoch;
const realPost = api.postMessage;
api.postMessage = async (gid, body) => {
  if (body.kind === "commit") throw Object.assign(new Error("simulated epoch conflict"), { status: 409 });
  return realPost(gid, body);
};
await assert.rejects(A.invite(carol.handle), /simulated/);
api.postMessage = realPost;
assert.equal(A.epoch, epochBefore, "a refused commit must not leave alice in a newer epoch");

await A.send("still in step after a refused commit");
as(bob); await B.sync();
assert.ok(texts(B).includes("still in step after a refused commit"),
  "bob must still read alice after her rollback");
assert.equal(errors(B).length, 0);
console.log("· refused commit rolled back; alice still in step with the group");

await q("DELETE FROM users WHERE handle = ANY($1)", [["sess_alice", "sess_bob", "sess_carol"]]);
await pool.end();
console.log("\nALL SESSION ASSERTIONS PASSED");
