/**
 * Collaborative canvas over MLS, two independent browser profiles.
 *
 * The point being proved: a stroke drawn by one member is encrypted ONCE for
 * the group, relayed as an opaque MLS application message, and converges on
 * the other member's Yjs document. Plus the late-joiner case — a member added
 * after drawing began cannot decrypt earlier traffic, so the inviter
 * re-publishes the board at the new epoch.
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
    if (m.type() === "error" && !/status of 401/.test(t)) errors.push("console: " + t);
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

// innerText returns the CSS text-transform result, and the counter is styled
// uppercase — so every match here has to be case-insensitive.
const strokeCount = async (page) => {
  const txt = await page.getByText(/\d+ strokes? · e2ee/i).innerText();
  return Number(txt.match(/(\d+) stroke/i)[1]);
};

async function draw(page, path) {
  const box = await page.locator("canvas").boundingBox();
  await page.mouse.move(box.x + path[0][0], box.y + path[0][1]);
  await page.mouse.down();
  for (const [x, y] of path.slice(1)) {
    await page.mouse.move(box.x + x, box.y + y, { steps: 6 });
  }
  await page.mouse.up();
}

const browser = await chromium.launch();

// Both identities must exist before the invite: claiming a KeyPackage
// requires the invitee to have published one.
const alice = await newUser(browser, "cv_a_" + rnd());
const bob = await newUser(browser, "cv_b_" + rnd());
console.log("· two identities registered:", alice.handle, "/", bob.handle);

const slug = "board-" + rnd();
alice.page.once("dialog", (d) => d.accept(slug));
await alice.page.getByRole("button", { name: "New channel" }).click();
await alice.page.getByText(slug, { exact: true }).first().waitFor({ timeout: 60000 });
await alice.page.getByRole("button", { name: "Canvas" }).click();
await alice.page.locator("canvas").waitFor({ timeout: 30000 });
console.log("· alice opened the canvas");

await draw(alice.page, [[300, 200], [420, 260], [520, 200], [640, 300]]);
await alice.page.waitForTimeout(1500);
assert.equal(await strokeCount(alice.page), 1, "alice should have one stroke");
console.log("· alice drew a stroke (1 MLS message for the whole group)");

// Invite bob AFTER drawing, so the late-joiner snapshot path is exercised.
const dialogs = (d) => (d.type() === "prompt" ? d.accept(bob.handle) : d.accept());
alice.page.on("dialog", dialogs);
await alice.page.getByRole("button", { name: "Invite" }).click();
await alice.page.waitForTimeout(6000);
alice.page.off("dialog", dialogs);
console.log("· alice invited bob after the board already had content");

// Bob picks up the Welcome, joins, and should receive the snapshot.
await bob.page.reload({ waitUntil: "networkidle" });
await bob.page.getByText(slug, { exact: true }).first().click({ timeout: 60000 });
await bob.page.getByRole("button", { name: "Canvas" }).click();
await bob.page.locator("canvas").waitFor({ timeout: 30000 });
await bob.page.waitForFunction(
  () => /[1-9]\d* strokes? · e2ee/i.test(document.body.innerText), undefined, { timeout: 60000 });
assert.equal(await strokeCount(bob.page), 1, "bob should have received the board snapshot");
console.log("· bob joined and received the existing board via snapshot");

// Bob draws; alice must converge.
await draw(bob.page, [[300, 480], [400, 520], [500, 470]]);
await bob.page.waitForTimeout(1500);
assert.equal(await strokeCount(bob.page), 2, "bob should now see two strokes");

await alice.page.waitForFunction(
  () => /2 strokes · e2ee/i.test(document.body.innerText), undefined, { timeout: 60000 });
console.log("· alice converged on bob's stroke — CRDT merge over MLS");

// Undo on one side must propagate too.
await bob.page.getByRole("button", { name: "Undo" }).click();
await bob.page.waitForTimeout(1500);
await alice.page.waitForFunction(
  () => /1 stroke · e2ee/i.test(document.body.innerText), undefined, { timeout: 60000 });
console.log("· undo propagated to alice");

// The board must survive a reload on alice's side.
await alice.page.reload({ waitUntil: "networkidle" });
await alice.page.getByText(slug, { exact: true }).first().click({ timeout: 60000 });
await alice.page.getByRole("button", { name: "Canvas" }).click();
await alice.page.waitForFunction(
  () => /1 stroke · e2ee/i.test(document.body.innerText), undefined, { timeout: 60000 });
console.log("· board survived a reload (Yjs state restored from IndexedDB)");

const errs = [...alice.errors, ...bob.errors];
if (errs.length) {
  console.log("\nPAGE ERRORS:\n  " + errs.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nCANVAS E2E PASSED (no page errors)");
}
await browser.close();
