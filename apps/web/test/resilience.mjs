/**
 * The paths the happy-path suites never touched, against the LIVE origin.
 *
 * - Two members sending at the same time, no reloads: each must read the
 *   other's messages (the old client jumped its cursor past anything that
 *   landed between its own sends).
 * - A device invited into a second room without reloading (KeyPackages are
 *   single-use; the old client held exactly one for its whole life).
 * - Removal seen from the removed side: one notice, input disabled, no
 *   error-banner storm.
 * - Re-invite after removal: the removed device rejoins from the new Welcome
 *   and reads what follows; its earlier transcript survives a reload.
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const APP = ORIGIN + "/app/";
const rnd = () => Math.random().toString(36).slice(2, 8);

async function newUser(browser, handle) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    const t = m.text();
    // 401 is the signed-out probe on first paint; 404 on the log is how a
    // removed member learns it was removed. Both are designed answers.
    if (m.type() === "error" && !/status of (401|404)/.test(t)) errors.push("console: " + t);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  await page.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByPlaceholder("ghost_01").fill(handle);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
  return { context, page, errors, handle };
}

const createRoom = async (u, slug) => {
  await u.page.getByRole("button", { name: "New channel" }).click();
  await u.page.getByPlaceholder("war-room").fill(slug);
  await u.page.getByRole("button", { name: "Create", exact: true }).click();
  await u.page.getByText(slug, { exact: true }).first().waitFor({ timeout: 60000 });
  await u.page.getByText(/^epoch \d+$/).waitFor({ timeout: 30000 });
};
const invite = async (u, handle) => {
  await u.page.getByRole("button", { name: "Invite" }).click();
  await u.page.getByPlaceholder("ghost_01").last().fill(handle);
  await u.page.getByRole("button", { name: "Invite", exact: true }).last().click();
  await u.page.getByText(new RegExp(`Invited ${handle}`)).waitFor({ timeout: 60000 });
};
// The invitee's channel list refreshes on its welcome poll; opening the room
// accepts the Welcome.
const openRoom = async (u, slug) => {
  await u.page.getByText(slug, { exact: true }).first().waitFor({ timeout: 60000 });
  await u.page.getByText(slug, { exact: true }).first().click();
  await u.page.getByText(/^epoch \d+$/).waitFor({ timeout: 60000 });
};
const say = async (u, text) => {
  await u.page.getByPlaceholder(/Encrypted before it leaves/).fill(text);
  await u.page.getByRole("button", { name: "Send" }).click();
  await u.page.getByText(text, { exact: true }).waitFor({ timeout: 30000 });
};
const sees = (u, text) => u.page.getByText(text, { exact: true }).waitFor({ timeout: 60000 });

const browser = await chromium.launch();
const alice = await newUser(browser, "rs_a_" + rnd());
const bob = await newUser(browser, "rs_b_" + rnd());
console.log("· registered", alice.handle, "and", bob.handle);

// ------------------------------------------------------------- room one

const room1 = "one-" + rnd();
await createRoom(alice, room1);
await invite(alice, bob.handle);
await openRoom(bob, room1);
console.log("· bob joined", room1);

// Simultaneous sends, no reloads, several rounds.
const tag = rnd();
await Promise.all([say(alice, `a1 ${tag}`), say(bob, `b1 ${tag}`)]);
await Promise.all([sees(alice, `b1 ${tag}`), sees(bob, `a1 ${tag}`)]);
// One page cannot fill and send two drafts at once, so alice's two sends are
// sequential on her side while bob's runs concurrently with them.
await Promise.all([(async () => { await say(alice, `a2 ${tag}`); await say(alice, `a3 ${tag}`); })(), say(bob, `b2 ${tag}`)]);
await Promise.all([sees(alice, `b2 ${tag}`), sees(bob, `a2 ${tag}`), sees(bob, `a3 ${tag}`)]);
for (const u of [alice, bob]) {
  const undecryptable = await u.page.getByText(/undecryptable/).count();
  assert.equal(undecryptable, 0, `${u.handle} has undecryptable rows after concurrent sends`);
}
console.log("· concurrent senders read each other's messages; nothing undecryptable");

// ------------------------------------------------------------- room two

const room2 = "two-" + rnd();
await createRoom(alice, room2);
await invite(alice, bob.handle);           // bob's second invite: needs a second KeyPackage
await openRoom(bob, room2);
await say(alice, `second room ${tag}`);
await sees(bob, `second room ${tag}`);
console.log("· bob was invited into a second room without reloading");

// ------------------------------------------------------- removal, seen by bob

await alice.page.getByText(room1, { exact: true }).first().click();
await bob.page.getByText(room1, { exact: true }).first().click();
await alice.page.getByRole("button", { name: "Room members" }).click();
await alice.page.getByRole("button", { name: `Remove ${bob.handle}` }).click();
await alice.page.getByText(new RegExp(`${bob.handle} removed`)).waitFor({ timeout: 30000 });
await alice.page.getByRole("button", { name: "Close" }).click();
await bob.page.getByText(/no longer a member of this room/).waitFor({ timeout: 30000 });
await bob.page.getByText("removed from room").waitFor({ timeout: 30000 });
await bob.page.waitForTimeout(6000);                       // several polls' worth
assert.equal(await bob.page.getByText(/no longer a member/).count(), 1, "the removal notice must appear once, not per poll");
assert.equal(await bob.page.getByRole("alert").count(), 0, "removal must not raise an error banner every poll");
assert.ok(await bob.page.getByPlaceholder("Removed from this room").isDisabled(), "input must be disabled after removal");
console.log("· removed member sees one notice, disabled input, no banner storm");

// The other room is untouched by the removal.
await bob.page.getByText(room2, { exact: true }).first().click();
await say(bob, `still here ${tag}`);
await alice.page.getByText(room2, { exact: true }).first().click();
await sees(alice, `still here ${tag}`);
await alice.page.getByText(room1, { exact: true }).first().click();
await bob.page.getByText(room1, { exact: true }).first().click();

// --------------------------------------------------------------- re-invite

await invite(alice, bob.handle);
await bob.page.getByText(/Rejoined from a fresh invite/).waitFor({ timeout: 60000 });
await say(alice, `welcome back ${tag}`);
await sees(bob, `welcome back ${tag}`);
await say(bob, `glad to be back ${tag}`);
await sees(alice, `glad to be back ${tag}`);
console.log("· removed device rejoined from a new Welcome and both directions work");

// Bob's earlier transcript and the rejoin survive a reload.
await bob.page.reload({ waitUntil: "networkidle" });
await bob.page.getByText(room1, { exact: true }).first().click();
await sees(bob, `a1 ${tag}`);
await sees(bob, `welcome back ${tag}`);
await bob.page.getByText(/^epoch \d+$/).waitFor({ timeout: 30000 });
console.log("· transcript across removal and rejoin survived a reload");

const allErrors = [...alice.errors, ...bob.errors];
if (allErrors.length) {
  console.log("\nPAGE ERRORS:\n  " + allErrors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nRESILIENCE PASSED (no page errors)");
}
await browser.close();
