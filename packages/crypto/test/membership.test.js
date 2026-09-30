/**
 * Membership secrecy, at the MLS-client level, no server involved.
 *
 * The two properties a group's membership exists to guarantee:
 *   - a member removed by a commit can't read anything sent after it, even
 *     having processed that commit (it must not derive the next epoch)
 *   - a member added by a commit can't read anything sent before it
 *
 * ts-mls < 1.6.4 broke the first for single-member removals (no UpdatePath),
 * so this runs on every `pnpm test`, and a library bump that regresses it
 * fails here first.
 */
import assert from "node:assert/strict";
import { MlsClient } from "../src/mls.js";

async function member(name) {
  const c = await MlsClient.create(name);
  return { c, kp: await c.newKeyPackage() };
}
const readable = async (client, bytes) => {
  try { return await client.apply(bytes); } catch { return undefined; }
};

const a = await member("a");
const b = await member("b");
const c = await member("c");
await a.c.createGroup(crypto.getRandomValues(new Uint8Array(16)));
const add = await a.c.addMembers([b.kp.encoded, c.kp.encoded]);
await b.c.joinFromWelcome(add.welcome);
await c.c.joinFromWelcome(add.welcome);

// ------------------------------------------------ removal locks you out

for (const n of [1, 2]) {
  // Removing one member and removing two take different paths through the
  // library; check both.
  const extra = [];
  for (let i = 0; i < n - 1; i++) {
    const x = await member(`x${i}`);
    const addX = await a.c.addMembers([x.kp.encoded]);
    await b.c.apply(addX.commit); await c.c.apply(addX.commit);
    await x.c.joinFromWelcome(addX.welcome);
    extra.push(x);
  }
  const victims = [c, ...extra];
  const rm = await a.c.removeMembers(victims.map((v) => v.c.identity));
  await b.c.apply(rm.commit);
  for (const v of victims) await readable(v.c, rm.commit);     // as a real client would
  const secret = await a.c.encrypt(`after removing ${n}`);
  assert.equal(await b.c.apply(secret), `after removing ${n}`, "a remaining member reads on");
  for (const v of victims) {
    assert.equal(await readable(v.c, secret), undefined, `a removed member read on (removing ${n})`);
    assert.equal(v.c.active, false, "the removed member's state reports itself inactive");
  }
  console.log(`· removing ${n} member(s): the removed can't read what follows`);
  // Put c back for the next round.
  if (n === 1) {
    const again = await member("c");
    Object.assign(c, again);
    const re = await a.c.addMembers([c.kp.encoded]);
    await b.c.apply(re.commit);
    await c.c.joinFromWelcome(re.welcome);
  }
}

// ------------------------------------------ joining doesn't open the past

const before = await a.c.encrypt("before d joined");
await b.c.apply(before);
const d = await member("d");
const addD = await a.c.addMembers([d.kp.encoded]);
await b.c.apply(addD.commit);
await d.c.joinFromWelcome(addD.welcome);
assert.equal(await readable(d.c, before), undefined, "a new member read a message from before it joined");
const after = await a.c.encrypt("after d joined");
assert.equal(await d.c.apply(after), "after d joined");
console.log("· a new member reads from its join on, never before");

console.log("\nALL MEMBERSHIP SECRECY ASSERTIONS PASSED");
