/**
 * MLS delivery service, driven entirely over HTTP.
 *
 * Three members, a real post-quantum MLS group, and the property that
 * actually matters for a delivery service: two members committing against the
 * same epoch must not both be accepted, or the group forks irrecoverably.
 */
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { MlsClient, SUITE, b64, unb64 } from "../../../packages/crypto/src/mls.js";
import { q, pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:8790";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

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
  return { status: r.status, ok: r.ok, json };
};
const must = async (...args) => {
  const r = await api(...args);
  if (!r.ok) throw new Error(`${args[1]} ${args[2]} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

/** A device row is still the unit of delivery, shared with the Signal path. */
async function registerDevice(user, name) {
  const { rows } = await q(
    `INSERT INTO devices(user_id, name, registration_id, identity_key)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [user.id, name, 1 + Math.floor(Math.random() * 16000), Buffer.alloc(32)]);
  return rows[0].id;
}

// ------------------------------------------------------------------- setup

const alice = await seedUser("mls_alice");
const bob = await seedUser("mls_bob");
const carol = await seedUser("mls_carol");
const aDev = await registerDevice(alice, "alice-web");
const bDev = await registerDevice(bob, "bob-web");
const cDev = await registerDevice(carol, "carol-web");
console.log("· seeded 3 users + devices");

const A = await MlsClient.create("mls_alice");
const B = await MlsClient.create("mls_bob");
const C = await MlsClient.create("mls_carol");

// Every device publishes a KeyPackage others can claim.
for (const [user, dev, client] of [[bob, bDev, B], [carol, cDev, C]]) {
  const kp = await client.newKeyPackage();
  const res = await must(user, "POST", "/api/mls/key-packages", {
    deviceId: dev, ciphersuite: SUITE,
    keyPackages: [{ ref: b64(kp.ref), keyPackage: b64(kp.encoded) }],
  });
  assert.equal(res.available, 1);
}
await A.newKeyPackage();
console.log("· key packages published (suite:", SUITE + ")");

// --------------------------------------------------------- group creation

const channel = await must(alice, "POST", "/api/channels",
  { slug: "canvas-" + crypto.randomBytes(3).toString("hex"), kind: "canvas" });
const groupIdBytes = crypto.randomBytes(16);
await A.createGroup(new Uint8Array(groupIdBytes));
const grp = await must(alice, "POST", "/api/mls/groups", {
  channelId: channel.id, groupId: b64(new Uint8Array(groupIdBytes)), ciphersuite: SUITE,
});
const GID = encodeURIComponent(b64(new Uint8Array(groupIdBytes)));
assert.equal(grp.epoch, 0, "a new group starts at epoch 0");
console.log("· group created at epoch 0");

// ------------------------------------------------------------- adding bob

const claimed = await must(alice, "GET", `/api/mls/key-packages/mls_bob?ciphersuite=${encodeURIComponent(SUITE)}&groupId=${GID}`);
assert.equal(claimed.keyPackages.length, 1);

// Claiming twice must fail — a KeyPackage is single-use.
const again = await api(alice, "GET", `/api/mls/key-packages/mls_bob?ciphersuite=${encodeURIComponent(SUITE)}&groupId=${GID}`);
assert.equal(again.status, 409, "a claimed key package must not be reissued");
console.log("· key package claimed exactly once (second claim 409s)");

const addBob = await A.addMembers([unb64(claimed.keyPackages[0].keyPackage)]);
const posted = await must(alice, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "commit", epoch: addBob.builtAtEpoch, senderDeviceId: aDev,
  payload: b64(addBob.commit),
  welcomes: [{ ref: claimed.keyPackages[0].ref, deviceId: bDev, welcome: b64(addBob.welcome) }],
});
addBob.confirm();   // the delivery service accepted it; only now adopt the new epoch
assert.equal(posted.epoch, 0, "the commit belongs to the epoch it transitions from");
console.log("· alice committed add(bob) at epoch 0 -> seq", posted.seq);

// ------------------------------------------- THE property: no forked epoch

// Alice's client already advanced, but a stale replica would still hold
// epoch 0. Replaying a commit built against epoch 0 must now be refused.
const stale = await api(alice, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "commit", epoch: 0, senderDeviceId: aDev, payload: b64(addBob.commit),
});
assert.equal(stale.status, 409, "a second commit at epoch 0 must be rejected");
assert.match(stale.json.error, /epoch conflict/, "should report an epoch conflict");
console.log("· fork rejected:", stale.json.error);

const now = await must(alice, "GET", `/api/mls/groups/${GID}`);
assert.equal(now.epoch, 1, "group should have advanced to epoch 1");
console.log("· group is at epoch 1");

// ------------------------------------------------------------- bob joins

const inbox = await must(bob, "GET", `/api/mls/devices/${bDev}/welcomes`);
assert.equal(inbox.welcomes.length, 1, "bob should have exactly one welcome");
await B.joinFromWelcome(unb64(inbox.welcomes[0].welcome));
await must(bob, "POST", `/api/mls/devices/${bDev}/welcomes/ack`, { ids: [inbox.welcomes[0].id] });
assert.equal(A.epoch, B.epoch, "alice and bob must agree on the epoch");
console.log("· bob joined from welcome; both at epoch", B.epoch);

const acked = await must(bob, "GET", `/api/mls/devices/${bDev}/welcomes`);
assert.equal(acked.welcomes.length, 0, "acked welcome must not be redelivered");

// ------------------------------------------------------- application flow

const MSG = "canvas op: rect(12,40,180,90) #ff2247";
const ct = await A.encrypt(MSG);
const sent = await must(alice, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "application", senderDeviceId: aDev, payload: b64(ct),
});
console.log("· alice sent one ciphertext (seq " + sent.seq + ")");

// The server must be storing something it cannot read.
const stored = await q("SELECT payload FROM mls_messages WHERE seq=$1", [sent.seq]);
assert.ok(!stored.rows[0].payload.includes(Buffer.from(MSG, "utf8")),
  "plaintext leaked into the stored payload");
console.log("· stored payload contains no plaintext");

// Bob replays the log from where his welcome placed him.
const log = await must(bob, "GET", `/api/mls/groups/${GID}/messages?since=${posted.seq}`);
let received = null;
for (const m of log.messages) received = (await B.apply(unb64(m.payload))) ?? received;
assert.equal(received, MSG, "bob failed to recover alice's plaintext");
console.log("· bob replayed the log and decrypted:", JSON.stringify(received));

// --------------------------------------------------- growing to 3 members

// A stranger to the group cannot claim into it, and a member cannot smuggle a
// Welcome onto an application message or onto a commit for a package someone
// else claimed: both are how a removed user could be re-granted log access.
const strangerClaim = await api(carol, "GET", `/api/mls/key-packages/mls_bob?ciphersuite=${encodeURIComponent(SUITE)}&groupId=${GID}`);
assert.equal(strangerClaim.status, 404, "non-members must not claim key packages into the group");
const noGroup = await api(alice, "GET", `/api/mls/key-packages/mls_bob?ciphersuite=${encodeURIComponent(SUITE)}`);
assert.equal(noGroup.status, 400, "a claim must name the group it is for");
const cClaim = await must(bob, "GET", `/api/mls/key-packages/mls_carol?ciphersuite=${encodeURIComponent(SUITE)}&groupId=${GID}`);
const smuggled = await api(alice, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "application", senderDeviceId: aDev, payload: b64(ct),
  welcomes: [{ ref: cClaim.keyPackages[0].ref, deviceId: cDev, welcome: b64(ct) }],
});
assert.equal(smuggled.status, 400, "welcomes must be refused on non-commit messages");
const epochBefore = (await must(alice, "GET", `/api/mls/groups/${GID}`)).epoch;
const notMine = await api(alice, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "commit", epoch: epochBefore, senderDeviceId: aDev, payload: b64(ct),
  welcomes: [{ ref: cClaim.keyPackages[0].ref, deviceId: cDev, welcome: b64(ct) }],
});
assert.equal(notMine.status, 400, "a welcome must match a package the poster claimed");
assert.equal((await must(alice, "GET", `/api/mls/groups/${GID}`)).epoch, epochBefore,
  "a rejected commit must roll the epoch bump back");
const carolStill = await q("SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2", [channel.id, carol.id]);
assert.equal(carolStill.rowCount, 0, "rejected welcomes must not grant membership");
console.log("· welcomes are tied to the poster's own claim, on commits only");

// Bob was never explicitly added to the channel — his Welcome granted it.
const bobMember = await q(
  "SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2", [channel.id, bob.id]);
assert.equal(bobMember.rowCount, 1, "being welcomed should grant channel membership");

const addCarol = await B.addMembers([unb64(cClaim.keyPackages[0].keyPackage)]);
const carolCommit = await must(bob, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "commit", epoch: addCarol.builtAtEpoch, senderDeviceId: bDev,
  payload: b64(addCarol.commit),
  welcomes: [{ ref: cClaim.keyPackages[0].ref, deviceId: cDev, welcome: b64(addCarol.welcome) }],
});
addCarol.confirm();
console.log("· bob committed add(carol) at epoch", addCarol.builtAtEpoch, "-> seq", carolCommit.seq);

// Alice must follow bob's commit to stay in sync.
const tail = await must(alice, "GET", `/api/mls/groups/${GID}/messages?since=${sent.seq}`);
for (const m of tail.messages) await A.apply(unb64(m.payload));

const cInbox = await must(carol, "GET", `/api/mls/devices/${cDev}/welcomes`);
await C.joinFromWelcome(unb64(cInbox.welcomes[0].welcome));
assert.equal(B.epoch, C.epoch, "bob and carol must agree on the epoch");
console.log("· carol joined; group at epoch", C.epoch);

// One ciphertext, read by both other members.
const MSG2 = "canvas op: stroke(#22d3ee)";
const ct2 = await B.encrypt(MSG2);
await must(bob, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "application", senderDeviceId: bDev, payload: b64(ct2),
});
assert.equal(await A.apply(ct2), MSG2, "alice could not read bob's message");
assert.equal(await C.apply(ct2), MSG2, "carol could not read bob's message");
console.log("· one ciphertext decrypted by both alice and carol");

// ------------------------------------------------------ owner removes carol

const roster = await must(alice, "GET", `/api/mls/groups/${GID}/members`);
assert.ok(roster.canRemove, "channel owner should be allowed to remove members");
assert.ok(roster.members.some((m) => m.handle === "mls_carol"));

const removeCarol = await A.removeMember("mls_carol");
await must(alice, "POST", `/api/mls/groups/${GID}/messages`, {
  kind: "commit", epoch: removeCarol.builtAtEpoch, senderDeviceId: aDev,
  payload: b64(removeCarol.commit), removeHandle: "mls_carol",
});
removeCarol.confirm();
const carolAfter = await api(carol, "GET", `/api/mls/groups/${GID}/messages`);
assert.equal(carolAfter.status, 404, "removed member must lose delivery-service access atomically");
const postRemoval = await A.encrypt("new epoch excludes carol");
await assert.rejects(() => C.apply(postRemoval), /invalid|ghash|decrypt|epoch/i,
  "old-epoch member must not decrypt post-removal traffic");
console.log("· owner removal advanced MLS and revoked carol's server access");

// ------------------------------------------------------------ authz check

const outsider = await seedUser("mls_outsider");
const peek = await api(outsider, "GET", `/api/mls/groups/${GID}/messages`);
assert.equal(peek.status, 404, "a non-member must not read the group log");
console.log("· non-member cannot read the log (404)");

await q("DELETE FROM users WHERE handle = ANY($1)",
  [["mls_alice", "mls_bob", "mls_carol", "mls_outsider"]]);
await pool.end();
console.log("\nALL MLS DELIVERY-SERVICE ASSERTIONS PASSED");
