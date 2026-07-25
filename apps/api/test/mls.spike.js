/**
 * MLS spike — does ts-mls give us what the web client needs?
 *
 * Proves, with no server involved yet:
 *   1. a post-quantum ciphersuite (ML-KEM) is usable
 *   2. Alice creates a group, adds Bob via Commit + Welcome
 *   3. Bob joins from the Welcome and decrypts Alice's application message
 *   4. a third member can be added to the existing group
 *   5. group messages are encrypted ONCE for the whole group
 *
 * (5) is the property that makes MLS the right fit for a shared canvas:
 * pairwise Double Ratchet would need one ciphertext per recipient device.
 */
import assert from "node:assert/strict";
import {
  getCiphersuiteFromName, nobleCryptoProvider,
  generateKeyPackage, createGroup, createCommit, joinGroup,
  createApplicationMessage, processPrivateMessage,
  defaultCapabilities, defaultLifetime, emptyPskIndex,
} from "ts-mls";

// Ciphersuite choice, decided by browser testing rather than taste:
//
// Any *_Ed25519 suite depends on WebCrypto Ed25519, which only reached Chrome
// in 137 — verified failing on Chrome 131 with "generateKey: Unrecognized
// name". Note that ts-mls's nobleCryptoProvider does NOT save you: its
// signature impl prefers WebCrypto whenever crypto.subtle merely exists, and
// only falls back to @noble/curves when subtle is absent. So in any browser it
// takes the WebCrypto path regardless of provider.
//
// ML-DSA87 signatures come from @noble/post-quantum (pure JS) and touch no
// WebCrypto signature algorithm at all, so this suite works on older engines
// AND is post-quantum end to end. Verified passing in Chrome 151 and Node.
const SUITE = "MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87";
const cs = await nobleCryptoProvider.getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
console.log("· ciphersuite ready:", SUITE);

const utf8 = new TextEncoder();
const str = (u8) => new TextDecoder().decode(u8);

const mkMember = async (name) => ({
  name,
  ...(await generateKeyPackage(
    { credentialType: "basic", identity: utf8.encode(name) },
    defaultCapabilities(), defaultLifetime, [], cs
  )),
});

const alice = await mkMember("alice");
const bob = await mkMember("bob");
const carol = await mkMember("carol");
console.log("· generated 3 key packages");

// Alice founds the group.
let aliceState = await createGroup(
  utf8.encode("canvas-room-01"), alice.publicPackage, alice.privatePackage, [], cs);
console.log("· alice created group");

// Add Bob: one Commit, one Welcome.
const addBob = await createCommit(
  { state: aliceState, cipherSuite: cs },
  { extraProposals: [{ proposalType: "add", add: { keyPackage: bob.publicPackage } }],
    ratchetTreeExtension: true }
);
aliceState = addBob.newState;
assert.ok(addBob.welcome, "commit adding a member must produce a Welcome");
console.log("· alice committed add(bob) and produced a Welcome");

let bobState = await joinGroup(
  addBob.welcome, bob.publicPackage, bob.privatePackage, emptyPskIndex, cs);
console.log("· bob joined from the Welcome");

assert.deepEqual(aliceState.groupContext.groupId, bobState.groupContext.groupId,
  "alice and bob must be in the same group");
assert.equal(aliceState.groupContext.epoch, bobState.groupContext.epoch,
  "alice and bob must agree on the epoch");
console.log("· group id + epoch agree (epoch", String(aliceState.groupContext.epoch) + ")");

// One ciphertext, whole group.
const MSG = "canvas op: rect(12,40,180,90) #ff2247";
const app = await createApplicationMessage(aliceState, utf8.encode(MSG), cs);
aliceState = app.newState;

const recv = await processPrivateMessage(
  bobState, app.privateMessage, emptyPskIndex, cs);
bobState = recv.newState;
assert.equal(recv.kind, "applicationMessage", "expected an application message");
assert.equal(str(recv.message), MSG, "bob did not recover alice's plaintext");
console.log("· bob decrypted:", JSON.stringify(str(recv.message)));

// The wire bytes must not contain the plaintext.
const wire = app.privateMessage.ciphertext;
assert.ok(!Buffer.from(wire).includes(Buffer.from(MSG, "utf8")),
  "plaintext leaked into the ciphertext");
console.log("· wire bytes contain no plaintext");

// Grow the group: Bob adds Carol, Alice follows the same commit.
const addCarol = await createCommit(
  { state: bobState, cipherSuite: cs },
  { extraProposals: [{ proposalType: "add", add: { keyPackage: carol.publicPackage } }],
    ratchetTreeExtension: true }
);
bobState = addCarol.newState;
const aliceFollows = await processPrivateMessage(
  aliceState, addCarol.commit.privateMessage, emptyPskIndex, cs);
aliceState = aliceFollows.newState;

let carolState = await joinGroup(
  addCarol.welcome, carol.publicPackage, carol.privatePackage, emptyPskIndex, cs);
assert.equal(aliceState.groupContext.epoch, carolState.groupContext.epoch,
  "everyone must land on the same epoch after the second commit");
console.log("· carol added; all three agree on epoch", String(carolState.groupContext.epoch));

// Single ciphertext readable by both other members.
const MSG2 = "canvas op: stroke(#22d3ee)";
const app2 = await createApplicationMessage(bobState, utf8.encode(MSG2), cs);
bobState = app2.newState;
const forAlice = await processPrivateMessage(aliceState, app2.privateMessage, emptyPskIndex, cs);
const forCarol = await processPrivateMessage(carolState, app2.privateMessage, emptyPskIndex, cs);
assert.equal(str(forAlice.message), MSG2);
assert.equal(str(forCarol.message), MSG2);
console.log("· one ciphertext decrypted by both alice and carol (group-native fan-out)");

console.log("\nMLS SPIKE PASSED — viable for the browser client");
