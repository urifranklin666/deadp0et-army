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
// Each simulated user also gets their own address, as real users would —
// otherwise they'd all share 127.0.0.1's per-address rate-limit budget.
let cookie = null;
let addr = "10.200.0.1";
const addrs = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = (path, init = {}) =>
  realFetch(BASE + path, { ...init, headers: { ...(init.headers || {}), cookie, "x-forwarded-for": addr } });
const as = (user) => {
  cookie = user.cookie;
  if (!addrs.has(user.handle)) addrs.set(user.handle, `10.200.${addrs.size + 1}.1`);
  addr = addrs.get(user.handle);
};

const { GroupSession, ensureDevice, topUpKeyPackages } = await import("../src/lib/session.js");
const { api } = await import("../src/lib/api.js");
const { store, K, belongsTo } = await import("../src/lib/db.js");
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

/** sync() takes one page (200) per call, as the app's loop does; drain it. */
async function drain(s) {
  for (let i = 0; i < 50; i++) {
    const before = s.cursor;
    const r = await s.sync();
    if (r.recovered || r.removed || s.cursor === before) return r;
  }
}
const texts = (s) => s.history.filter((h) => h.text !== undefined && !h.mine).map((h) => h.text);
const errors = (s) => s.history.filter((h) => h.error);
const settle = () => new Promise((r) => setTimeout(r, 50));
/** Every transcript key stored for one group (the index and its chunks). */
async function histKeys(handle, groupId) {
  const found = [];
  const prefix = `hist:${handle}:${groupId}`;
  await store.deleteWhere((k) => { if (String(k).startsWith(prefix)) found.push(String(k)); return false; });
  return found.sort();
}

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

// ------------------------------------------- persistence is all-or-nothing

// If any value in the batch can't be stored, none of it is: a cursor must
// never land without the state and transcript it belongs to.
await store.set("atomic:a", "old");
await assert.rejects(store.setMany([["atomic:a", "new"], ["atomic:b", () => "not cloneable"]]));
assert.equal(await store.get("atomic:a"), "old", "a failed batch must leave earlier keys untouched");
assert.equal(await store.get("atomic:b"), undefined);
console.log("· group state, cursor and transcript are persisted atomically");

// Account deletion wipes every key this browser holds for that handle, and
// nothing belonging to anyone else.
await store.setMany([["kp:zed", 1], ["gs:zed:g1", 2], ["cur:zed:g1", 3], ["kp:zedd", 4], ["gs:other:zed", 5]]);
assert.equal(await store.deleteWhere(belongsTo("zed")), 3);
assert.equal(await store.get("kp:zedd"), 4, "a handle sharing a prefix is untouched");
assert.equal(await store.get("gs:other:zed"), 5, "a group id that happens to match is untouched");
await store.delMany(["kp:zedd", "gs:other:zed"]);
console.log("· deleting an account wipes exactly that handle's local keys");

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

as(alice);
await assert.rejects(A.invite(bob.handle), /already in this group/,
  "re-inviting someone whose devices are all in the group should say so, not add duplicates");

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

// A KeyPackage whose credential says "sess_alice" sits in mallory's slot.
// The server refuses such uploads, so plant it directly — this is what a
// compromised server could hand out. The inviter must still refuse it, or
// mallory's messages would read as alice's.
const mallory = await seedUser("sess_mallory");
as(mallory);
const mDev = (await ensureDevice(mallory.handle)).deviceId;
await q("UPDATE mls_key_packages SET claimed_at = now() WHERE device_id=$1", [mDev]);  // only the forgery left
const forger = await MlsClient.create(alice.handle);
const forged = await forger.newKeyPackage();
await assert.rejects(api.publishKeyPackages(mDev, SUITE, [{ ref: b64(forged.ref), keyPackage: b64(forged.encoded) }]),
  /must name the uploading user/, "the server refuses an impostor upload");
await q("INSERT INTO mls_key_packages(device_id, ciphersuite, ref, key_package) VALUES ($1,$2,$3,$4)",
  [mDev, SUITE, Buffer.from(forged.ref), Buffer.from(forged.encoded)]);
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

// ----------------------------------------------------------------- removal

// Only an owner/admin may remove; a plain member's attempt is refused by the
// server and must leave the refuser's MLS state untouched.
as(bob); await B.sync();
const bobEpoch = B.epoch;
await assert.rejects(B.remove(carol.handle), /owner or admin/);
assert.equal(B.epoch, bobEpoch, "a refused removal must roll back");

as(alice);
assert.ok(A.members().includes(carol.handle));
await A.remove(carol.handle);
assert.ok(!A.members().includes(carol.handle), "carol's leaf should be gone from alice's tree");
const still = await q(
  "SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2", [A.channel.id, carol.id]);
assert.equal(still.rowCount, 0, "removal should revoke channel membership");

await A.send("after carol left");
as(bob); await B.sync();
assert.ok(texts(B).includes("after carol left"), "remaining members keep reading");
assert.equal(B.epoch, A.epoch);

// Carol notices, and even handed the ciphertext directly cannot read it.
as(carol);
const carolKeys = Cs.client;                  // her last state, before she learns of it
const carolCursorBefore = Cs.cursor;
const r = await Cs.sync();
assert.equal(r.removed, true, "the removed device should learn it was removed");
assert.ok(Cs.history.some((h) => h.notice?.includes("removed")));
// The strong form: carol's old keys process everything in order — the
// removal commit included, as a real client would — and still can't read
// what alice sent afterwards. (ts-mls < 1.6.4 left single-member removals
// without an UpdatePath, which let the removed member derive the next
// epoch and read on.)
const { rows: tail } = await q(
  `SELECT kind, payload, sender_device_id FROM mls_messages WHERE group_id=$1 AND seq > $2 ORDER BY seq`,
  [Buffer.from(A.groupId, "base64"), carolCursorBefore]);
let readAfter = null;
for (const m of tail) {
  if (m.sender_device_id === cDev) continue;
  try {
    const t = await carolKeys.apply(new Uint8Array(m.payload));
    if (t && t.includes("after carol left")) readAfter = t;
  } catch { /* expected once removed */ }
}
assert.equal(readAfter, null, "a removed member must not decrypt anything sent after the removal");
assert.equal(carolKeys.active, false, "processing its own removal leaves the old state inactive");
console.log("· owner removed carol: access revoked, and later messages are unreadable to her");

// Her device forgot the group, so a later re-invite joins afresh.
assert.equal(Cs.client, null);
assert.equal(await store.get(K.groupState(carol.handle, A.groupId)), undefined,
  "a removed device should wipe the group's keys");
as(alice); await A.invite(carol.handle);
as(carol);
assert.equal(await Cs.tryJoin(), true, "a removed member can be invited back");
as(alice); await A.send("welcome back");
as(carol); await Cs.sync();
assert.ok(texts(Cs).includes("welcome back"));
console.log("· a removed member forgets the group and can be re-invited");

// ----------------------------------------------------- leaving + reconcile

// Bob leaves the second room. His access ends and his device forgets it...
as(bob);
const { A: A2, B: B2 } = second;
B2.saveDraft("half-written reply");
await new Promise((r) => setTimeout(r, 400));          // saved once typing pauses (250 ms)
assert.equal(await store.get(K.draft(bob.handle, A2.groupId)), "half-written reply", "a draft is saved");
await B2.leave();
assert.equal(await store.get(K.draft(bob.handle, A2.groupId)), undefined, "leaving deletes the channel's draft");
assert.equal(B2.client, null);
assert.equal(await store.get(K.groupState(bob.handle, A2.groupId)), undefined,
  "leaving should wipe the group's keys from this device");
assert.deepEqual(await histKeys(bob.handle, A2.groupId), [], "and its transcript, every chunk of it");
const bobIn = await q(
  "SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2", [A2.channel.id, bob.id]);
assert.equal(bobIn.rowCount, 0, "leaving should end channel membership");

// ...but his MLS leaf is still in the tree until an owner reconciles.
as(alice);
assert.ok(A2.members().includes(bob.handle));
assert.equal(await A2.reconcile(), 1, "the owner's client should remove the leaver's leaf");
assert.ok(!A2.members().includes(bob.handle), "bob's leaf should be gone after reconcile");
assert.equal(await A2.reconcile(), 0, "nothing left to reconcile");

// The owner cannot leave their own channel.
await assert.rejects(A2.leave(), /owner cannot leave/);
console.log("· leaving ends access and wipes local keys; the owner's client prunes the leaf");

// Re-invited before anyone reconciled: the old leaf goes in the same commit.
const third = await room("third");
as(bob); await third.B.leave();
as(alice);
assert.ok(third.A.members().includes(bob.handle), "bob's old leaf is still there");
await third.A.invite(bob.handle);
const bobLeaves = third.A.client.members().filter((m) => m.identity === bob.handle).length;
assert.equal(bobLeaves, 1, "the re-invite should replace bob's old leaf, not sit beside it");
const B3 = new GroupSession(bob.handle, bDev, third.A.channel);
B3.groupId = third.A.groupId;
as(bob); assert.equal(await B3.tryJoin(), true);
as(alice); await third.A.send("third time");
as(bob); await B3.sync();
assert.ok(texts(B3).includes("third time"));
console.log("· re-inviting a leaver replaces their stale leaf in the same commit");

// --------------------------------- no key reuse across a crash mid-send

// The post lands but the tab "dies" before send() finishes. Reloading from
// storage and sending again must not reuse the lost message's key: bob has
// to be able to read both.
as(alice);
const crashPost = api.postMessage;
api.postMessage = async (gid, body) => { await crashPost(gid, body); throw new TypeError("tab closed"); };
await assert.rejects(third.A.send("sent just before the crash"), /tab closed/);
api.postMessage = crashPost;
const reloaded = new GroupSession(alice.handle, aDev, third.A.channel);
assert.equal(await reloaded.open(third.A.groupId), true);
await reloaded.send("sent after reloading");
as(bob); await B3.sync();
assert.ok(texts(B3).includes("sent just before the crash"));
assert.ok(texts(B3).includes("sent after reloading"),
  "the reloaded device must not reuse the crashed send's key");
assert.equal(errors(B3).length, 0);
console.log("· a crash after posting doesn't lead to key reuse on reload");

// --------------------------------- no fork across a crash mid-commit

// The server takes alice's add commit, then the tab dies before the new
// epoch is saved (here: the post-commit save throws). On reload the pending
// note is settled against the log: the commit landed, so alice must come
// back in the NEW epoch, still in step with bob.
as(alice);
// "The tab dies" = the first save attempted after the commit POST succeeds.
const realSetMany = store.setMany;
const postForCrash = api.postMessage;
let committed = false;
api.postMessage = async (gid, body) => {
  const r = await postForCrash(gid, body);
  if (body.kind === "commit") committed = true;
  return r;
};
store.setMany = async (...args) => {
  if (committed) { committed = false; throw new Error("tab closed"); }
  return realSetMany(...args);
};
await assert.rejects(reloaded.invite(carol.handle), /tab closed/);
store.setMany = realSetMany;
api.postMessage = postForCrash;
const serverEpoch = (await api.group(reloaded.groupId)).epoch;
const again = new GroupSession(alice.handle, aDev, reloaded.channel);
assert.equal(await again.open(reloaded.groupId), true);
assert.equal(again.epoch, serverEpoch, "the reloaded device must resume in the epoch its commit created");
await again.send("still in step after a crash mid-commit");
as(bob); await B3.sync();
assert.ok(texts(B3).includes("still in step after a crash mid-commit"));
assert.equal(errors(B3).length, 0);
console.log("· a crash mid-commit resumes in the right epoch instead of forking");

// The outcome can't be checked right away (response lost AND the log read
// fails), so the pending note stays — and then the tab keeps syncing past
// its own commit before reloading. The note must not roll back a commit
// that landed.
as(alice);
const lostPost = api.postMessage;
const lostRead = api.messages;
let failNextRead = false;
api.postMessage = async (gid, body) => {
  const r = await lostPost(gid, body);
  if (body.kind === "commit") { failNextRead = true; throw new TypeError("connection reset"); }
  return r;
};
api.messages = async (...a) => {
  if (failNextRead) { failNextRead = false; throw new TypeError("offline"); }
  return lostRead(...a);
};
const dave2 = dave;   // any user with devices not in this room
await assert.rejects(again.invite(dave2.handle), /connection reset/);
api.postMessage = lostPost;
api.messages = lostRead;
assert.ok(await store.get(K.pendingCommit(alice.handle, again.groupId)), "the undetermined commit leaves a note");
await again.sync();                                    // steps over its own commit...
assert.equal(await store.get(K.pendingCommit(alice.handle, again.groupId)), undefined,
  "...which settles the note: it landed");
const afterSync = new GroupSession(alice.handle, aDev, again.channel);
await afterSync.open(again.groupId);
assert.equal(afterSync.epoch, (await api.group(again.groupId)).epoch,
  "reloading after syncing past a landed commit keeps the new epoch");
console.log("· an unsettled commit note is settled by syncing past it, never rolled back wrongly");

// ---------------------------------------------- recovering from a gap

// Bob's device goes quiet for longer than compaction waits for anyone; the
// log is pruned past what he applied. When he returns he must notice the gap,
// drop his board, ask for a snapshot, and converge on alice's board.
const gapRoom = await room("gap");
as(alice);
for (let i = 0; i < 600; i++) {           // well past what ts-mls ratchets over by default (200)
  gapRoom.A.strokes.push([{ c: "#f43f5e", w: 2, p: [[i, i], [i + 1, i + 1]] }]);
  await gapRoom.A.flushCanvas();
}
await drain(gapRoom.A);
// sync() reports the cursor fire-and-forget; make sure it has landed.
await api.reportCursor(gapRoom.A.groupId, aDev, gapRoom.A.cursor);
await q(`UPDATE mls_device_cursors SET updated_at = now() - interval '40 days'
          WHERE group_id=$1 AND device_id=$2`, [Buffer.from(gapRoom.A.groupId, "base64"), bDev]);
const { compactGroup } = await import("../../api/src/compaction.js");
const pruned = await compactGroup(Buffer.from(gapRoom.A.groupId, "base64"));
assert.ok(pruned.pruned > 0, "compaction should prune past bob's stale cursor");

as(bob);
const r1 = await gapRoom.B.sync();
assert.equal(r1.recovered, true, "bob should detect the gap");
assert.ok(gapRoom.B.history.some((h) => h.notice?.includes("compacted")), "and say so in the transcript");
// Alice sees the request and answers after a short random delay.
as(alice);
await drain(gapRoom.A);
await new Promise((r) => setTimeout(r, 2200));
as(bob);
await drain(gapRoom.B);
assert.ok(pruned.pruned > 200, `the gap should exceed ts-mls's default forward-ratchet limit (pruned ${pruned.pruned})`);
assert.equal(errors(gapRoom.B).length, 0,
  `bob must decrypt everything after the gap: ${errors(gapRoom.B).map((e) => e.error)[0]}`);
assert.equal(gapRoom.B.strokes.length, gapRoom.A.strokes.length,
  "after the snapshot, bob's board matches alice's");
console.log("· a device past a compaction gap recovers the board from a peer's snapshot");

// ------------------------------- undeclared removal: audited, then healed

// Bob is a plain member. A modified client lets him commit carol's removal
// without declaring it, so the server (which can't read commits) accepts it
// and still lists carol. Alice's client must show who did it, and — as
// owner — put carol back.
as(bob);
await drain(B);
const silent = await B.client.removeMembers(carol.handle);
await api.postMessage(B.groupId, { kind: "commit", epoch: silent.builtAtEpoch, senderDeviceId: bDev, payload: b64(silent.commit) });
await store.set(K.groupState(bob.handle, B.groupId), B.client.exportState());

as(alice);
await drain(A);
const audit = A.history.find((h) => h.audit);
assert.ok(audit, "alice's transcript should record the removal");
assert.equal(audit.from, bob.handle, "attributed to bob by his signing key");
assert.deepEqual(audit.audit.removed, [carol.handle]);
assert.ok(!A.members().includes(carol.handle));
assert.ok(await A.reconcile() >= 1, "the owner's reconcile should re-add carol");
assert.ok(A.members().includes(carol.handle), "carol is back in the tree");

// Carol's device processes the removal, notices it can't follow the group
// any more, forgets it — and joins afresh from the owner's healing Welcome.
as(carol);
// The report to the server fails the first time; it must not be lost.
const realReport = api.reportEvicted;
api.reportEvicted = async () => { throw new TypeError("offline"); };
const evicted = await drain(Cs).catch((e) => ({ threw: e.message }));
api.reportEvicted = realReport;
assert.equal(Cs.client, null, "carol's device should notice it was removed");
assert.equal(await store.get(K.evictionReport(carol.handle, Cs.groupId)), true, "the unsent report is kept");
await Cs.retryEvictionReport();
assert.equal(await store.get(K.evictionReport(carol.handle, Cs.groupId)), undefined, "and cleared once delivered");
const { rows: [ev] } = await q(
  "SELECT evicted_at FROM mls_group_devices WHERE group_id=$1 AND device_id=$2", [Buffer.from(Cs.groupId, "base64"), cDev]);
assert.ok(ev?.evicted_at, "the server now knows this device was evicted");
void evicted;
assert.equal(await Cs.tryJoin(), true, "and rejoin from the heal");
as(alice); await A.send("after the heal");
as(carol); await drain(Cs);
assert.ok(texts(Cs).includes("after the heal"), "carol reads again after being healed back in");
console.log("· an undeclared removal is audited by the remover's key and healed by the owner");

// ------------------------------------------- attribution survives outages

// If the key directory can't be reached, messages must not be branded
// "unverified" for good: they wait, and the next sync resolves them.
{
  // A sender bob has never resolved (a cached key would never hit the outage).
  as(alice); await A.invite(dave.handle);
  as(dave);
  const Ds = new GroupSession(dave.handle, dDev, A.channel);
  Ds.groupId = A.groupId;
  assert.equal(await Ds.tryJoin(), true);
  await Ds.send("while the directory is down");
  as(bob);
  const realIdentities = api.identities;
  let asked = 0;
  api.identities = async () => { asked++; throw new TypeError("offline"); };
  await drain(B);
  api.identities = realIdentities;
  assert.ok(asked > 0, "the lookup was attempted (and failed)");
  const e = B.history.find((h) => h.text === "while the directory is down");
  assert.ok(e && !e.unverified && e.pendingKey, "a failed lookup leaves the message pending, not unverified");
  await drain(B);
  const e2 = B.history.find((h) => h.text === "while the directory is down");
  assert.equal(e2.from, dave.handle, "the next sync resolves it");
  assert.ok(!e2.pendingKey && !e2.unverified);
}
console.log("· a directory outage delays attribution instead of marking messages unverified");

// ---------------------------------------- legacy leaves get registered

// A group from before the key directory: the founder's leaf was never
// uploaded, so nothing registered its key. Reopening registers it, with proof.
{
  as(alice);
  const leafKey = A.client.members().find((m) => m.identity === alice.handle);
  await q("DELETE FROM mls_signature_keys WHERE user_id=$1", [alice.id]);
  await store.del(K.leafRegistered(alice.handle, A.groupId));
  const reopened = new GroupSession(alice.handle, aDev, A.channel);
  await reopened.open(A.groupId);
  await settle(); await settle();
  const { rows } = await q("SELECT count(*)::int AS n FROM mls_signature_keys WHERE user_id=$1", [alice.id]);
  assert.ok(leafKey && rows[0].n >= 1, "reopening should register this device's leaf key");
}
console.log("· reopening a group registers a legacy leaf's key, with proof");

// ------------------------------------ attribution by key, not credential

// The worst case for credentials: mallory builds a KeyPackage with HER OWN
// registered signature key but a credential saying "sess_alice", and an
// inviter running a modified client (no identity check) adds it. MLS
// verifies mallory's signatures fine — it's her key — so only attributing
// by the key's registered owner exposes her.
{
  const tsmls = await import("ts-mls");
  const cs = await tsmls.nobleCryptoProvider.getCiphersuiteImpl(tsmls.getCiphersuiteFromName(SUITE));
  const mPool = (await store.get(K.keyPackagePool(mallory.handle))) || {};
  const [, mine] = Object.entries(mPool)[0];
  const decoded = tsmls.decodeMlsMessage(unb64(mine.public), 0);
  const mPub = (Array.isArray(decoded) ? decoded[0] : decoded).keyPackage.leafNode.signaturePublicKey;
  const forgedKp = await tsmls.generateKeyPackageWithKey(
    { credentialType: "basic", identity: new TextEncoder().encode(alice.handle) },
    tsmls.defaultCapabilities(), tsmls.defaultLifetime, [],
    { signKey: unb64(mine.sig), publicKey: mPub }, cs);
  const forgedBytes = tsmls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: forgedKp.publicPackage });
  const forgedRef = b64(new Uint8Array(await crypto.webcrypto.subtle.digest("SHA-256", forgedBytes)));

  // Mallory keeps the private half where her device will look for it...
  mPool[forgedRef] = {
    public: b64(forgedBytes), init: b64(forgedKp.privatePackage.initPrivateKey),
    hpke: b64(forgedKp.privatePackage.hpkePrivateKey), sig: b64(forgedKp.privatePackage.signaturePrivateKey),
  };
  await store.set(K.keyPackagePool(mallory.handle), mPool);
  // ...and it's the only package of hers left to claim (planted: the server
  // would refuse to accept its upload, and a real attacker would use the
  // modified client to add it without any upload at all).
  await q("UPDATE mls_key_packages SET claimed_at = now() WHERE device_id=$1 AND claimed_at IS NULL", [mDev]);
  await q("INSERT INTO mls_key_packages(device_id, ciphersuite, ref, key_package) VALUES ($1,$2,$3,$4)",
    [mDev, SUITE, Buffer.from(unb64(forgedRef)), Buffer.from(forgedBytes)]);

  // The "modified" inviter: alice's client, minus the identity check.
  as(alice);
  const G = gapRoom.A;
  await drain(G);
  const { keyPackages } = await api.claimKeyPackages(mallory.handle, SUITE, G.groupId);
  const add = await G.client.addMembers(keyPackages.map((k) => unb64(k.keyPackage)));
  await api.postMessage(G.groupId, {
    kind: "commit", epoch: add.builtAtEpoch, senderDeviceId: aDev, payload: b64(add.commit),
    welcomes: keyPackages.map((k) => ({ ref: k.ref, deviceId: k.deviceId, welcome: b64(add.welcome) })),
  });
  await store.set(K.groupState(alice.handle, G.groupId), G.client.exportState());

  as(mallory);
  const M = new GroupSession(mallory.handle, mDev, G.channel);
  M.groupId = G.groupId;
  assert.equal(await M.tryJoin(), true);
  assert.ok(M.client.members().some((m) => m.identity === alice.handle && m.leafIndex !== undefined));
  await M.send("hi, it's alice");

  as(bob);
  await drain(gapRoom.B);
  const seen = gapRoom.B.history.find((h) => h.text === "hi, it's alice");
  assert.ok(seen, "bob receives the message");
  assert.equal(seen.from, mallory.handle, "attribution follows the signing key's registered owner");
  assert.equal(seen.claimed, alice.handle, "and flags the credential's false claim");
}
console.log("· a leaf claiming someone else's name is attributed to its key's real owner, flagged");

// ------------------------------- the transcript is saved in chunks

// A long transcript: a save must write only the chunk that changed, not the
// whole history, and a reload must put the chunks back together in order.
{
  const { A: L } = await room("long");
  as(alice);
  for (let i = 0; i < 600; i++) L.history.push({ seq: 0, at: "2026-01-01T00:00:00Z", notice: `old line ${i}` });
  await L.send("first after the backlog");        // writes every chunk once

  const realSave = store.setMany;
  let written = [];
  store.setMany = async (entries, deletes) => {
    written = entries.map(([k]) => k).filter((k) => k.startsWith("hist:"));
    return realSave(entries, deletes);
  };
  await L.send("second after the backlog");
  store.setMany = realSave;
  const lastChunk = Math.floor((L.history.length - 1) / 250);
  assert.deepEqual(written.sort(), [K.history(alice.handle, L.groupId), K.historyChunk(alice.handle, L.groupId, lastChunk)].sort(),
    "a new message rewrites only the last chunk (and the index)");

  const L2 = new GroupSession(alice.handle, aDev, L.channel);
  assert.equal(await L2.open(L.groupId), true);
  assert.deepEqual(L2.history, L.history, "a reload reassembles the transcript in order");

  // A transcript stored as one array (before chunking) still loads, and is
  // converted at the next save.
  const legacy = [...L.history];
  await store.delMany(await histKeys(alice.handle, L.groupId));
  await store.set(K.history(alice.handle, L.groupId), legacy);
  const L3 = new GroupSession(alice.handle, aDev, L.channel);
  assert.equal(await L3.open(L.groupId), true);
  assert.deepEqual(L3.history, legacy, "a pre-chunking transcript loads as it was");
  await L3.send("after the upgrade");
  assert.deepEqual(await store.get(K.history(alice.handle, L.groupId)), { chunks: Math.ceil(L3.history.length / 250) });
  const L4 = new GroupSession(alice.handle, aDev, L.channel);
  await L4.open(L.groupId);
  assert.deepEqual(L4.history, L3.history, "and is stored as chunks from then on");
}
console.log("· the transcript is stored in chunks; a new message rewrites only the last one");

await settle();                                     // let fire-and-forget cursor reports land
await q("DELETE FROM users WHERE handle = ANY($1)", [["sess_alice", "sess_bob", "sess_carol", "sess_dave", "sess_mallory"]]);
await pool.end();
console.log("\nALL SESSION ASSERTIONS PASSED");
