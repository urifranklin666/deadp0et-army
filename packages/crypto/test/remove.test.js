import assert from "node:assert/strict";
import { MlsClient } from "../src/mls.js";

const A = await MlsClient.create("remove_alice");
const B = await MlsClient.create("remove_bob");
await A.newKeyPackage();
const bkp = await B.newKeyPackage();
await A.createGroup(crypto.getRandomValues(new Uint8Array(16)));
const add = await A.addMembers([bkp.encoded]);
await B.joinFromWelcome(add.welcome);
assert.deepEqual(A.members().map((m) => m.identity).sort(), ["remove_alice", "remove_bob"]);

const removal = await A.removeMember("remove_bob");
assert.equal(removal.removedLeaves, 1);
assert.deepEqual(A.members().map((m) => m.identity), ["remove_alice"]);
// The delivery service revokes Bob in the same transaction that stores this
// commit, so Bob never receives it and remains at the old epoch.
const after = await A.encrypt("after removal");
await assert.rejects(() => B.apply(after), /removed|active|group|sender|decrypt|invalid|ghash/i);
console.log("MLS REMOVE PASSED — old-epoch member cannot decrypt after removal");
