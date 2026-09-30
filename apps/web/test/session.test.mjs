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

const { GroupSession, ensureDevice, topUpKeyPackages } = await import("../src/lib/session.js");
const { api } = await import("../src/lib/api.js");
const { store, K } = await import("../src/lib/db.js");
const { MlsClient, SUITE, b64, unb64 } = await import("@deadp0et/crypto/mls");

const { decodeMlsMessage } = await import("ts-mls");

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

// ----------------------------------- founding never reuses a published leaf

// Every package this device has published: the primary plus the pool.
const published = [(await store.get(K.keyPackage(alice.handle)))?.public,
  ...Object.values((await store.get(K.keyPackagePool(alice.handle))) || {}).map((k) => k.public)];
const leafKeys = published.filter(Boolean).map((pub) => {
  const msg = decodeMlsMessage(unb64(pub), 0);
  return Buffer.from((Array.isArray(msg) ? msg[0] : msg).keyPackage.leafNode.hpkePublicKey);
});
const founded = Buffer.from(A.client.exportState());
assert.ok(leafKeys.length >= 1 && leafKeys.every((k) => !founded.includes(k)),
  "a founder's leaf must not reuse any published KeyPackage");
console.log("· founder's leaf is fresh; no published KeyPackage reused");

as(bob); await B.send("from bob, while alice was not looking");
// Alice sends WITHOUT syncing first. Her cursor is behind bob's message.
as(alice); await A.send("from alice");
await A.sync();
assert.deepEqual(texts(A), ["from bob, while alice was not looking"],
  "alice's own send must not jump her cursor past bob's message");
assert.equal(errors(A).length, 0, "alice should not try to decrypt her own message");
assert.deepEqual(A.history.map((h) => h.text),
  ["from bob, while alice was not looking", "from alice"],
  "the transcript must stay in log order even though alice's send was recorded first");
as(bob); await B.sync();
assert.deepEqual(texts(B), ["from alice"]);
assert.equal(B.history.find((h) => h.text === "from alice").from, alice.handle,
  "a message should be attributed to its sender's MLS credential");
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

// ------------------------------------- the pool survives concurrent top-ups

// Several refills racing (boot, and joins in two groups at once) must not
// lose any private half whose public half was published.
const dave = await seedUser("sess_dave");
as(dave);
const dDev = (await ensureDevice(dave.handle)).deviceId;
await q("UPDATE mls_key_packages SET claimed_at = now() WHERE device_id=$1", [dDev]);   // drain it
await Promise.all([1, 2, 3].map(() => topUpKeyPackages(dave.handle, dDev)));
const pooledRefs = Object.keys((await store.get(K.keyPackagePool(dave.handle))) || {});
const { rows: onServer } = await q(
  "SELECT encode(ref,'base64') AS ref FROM mls_key_packages WHERE device_id=$1 AND claimed_at IS NULL", [dDev]);
assert.ok(onServer.length >= 3, "the refill should publish packages");
assert.ok(onServer.every((r) => pooledRefs.includes(r.ref)),
  "every published package must still have its private half locally");
console.log("· concurrent refills keep every published package openable");

// ------------------------------------ an invitee can't pose as someone else

// Mallory publishes a KeyPackage whose credential says "sess_alice". Anyone
// inviting mallory must refuse it, or mallory's messages would read as alice's.
const mallory = await seedUser("sess_mallory");
as(mallory);
const mDev = (await ensureDevice(mallory.handle)).deviceId;
await q("UPDATE mls_key_packages SET claimed_at = now() WHERE device_id=$1", [mDev]);  // only the forgery left
const forger = await MlsClient.create(alice.handle);
const forged = await forger.newKeyPackage();
await api.publishKeyPackages(mDev, SUITE, [{ ref: b64(forged.ref), keyPackage: b64(forged.encoded) }]);
as(bob);
const epochBeforeForgery = B.epoch;
await assert.rejects(B.invite(mallory.handle), /claims to be "sess_alice"/);
assert.equal(B.epoch, epochBeforeForgery, "a refused invitee must not change the group");
console.log("· invite refuses a key package whose credential names someone else");

// ----------------------------------------- refused commit rolls back

const carol = await seedUser("sess_carol");
as(carol); const cDev = (await ensureDevice(carol.handle)).deviceId;

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

// ------------------------------- lost responses: ask the log what happened

// Never reached the server: no status, nothing in the log → roll back.
as(alice);
const beforeLost = A.epoch;
api.postMessage = async (gid, body) => {
  if (body.kind === "commit") throw new TypeError("fetch failed");   // offline before sending
  return realPost(gid, body);
};
await assert.rejects(A.invite(carol.handle), /fetch failed/);
api.postMessage = realPost;
assert.equal(A.epoch, beforeLost, "a commit that never landed must be rolled back");

// Landed, but the response was lost: keep the new epoch, and carol joins it.
api.postMessage = async (gid, body) => {
  const res = await realPost(gid, body);
  if (body.kind === "commit") throw new TypeError("connection reset");
  return res;
};
await A.invite(carol.handle);
api.postMessage = realPost;
assert.equal(A.epoch, beforeLost + 1, "a commit that landed must be kept");
as(carol);
const Cs = new GroupSession(carol.handle, cDev, A.channel);
Cs.groupId = A.groupId;
assert.equal(await Cs.tryJoin(), true, "carol should join from the commit that did land");
assert.equal(Cs.epoch, A.epoch, "carol and alice agree after a lost response");
console.log("· lost responses resolved from the log: rolled back if absent, kept if landed");

await settle();                                     // let fire-and-forget cursor reports land
await q("DELETE FROM users WHERE handle = ANY($1)", [["sess_alice", "sess_bob", "sess_carol", "sess_dave", "sess_mallory"]]);
await pool.end();
console.log("\nALL SESSION ASSERTIONS PASSED");
