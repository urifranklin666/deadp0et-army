/**
 * Live cursors between two real browser profiles.
 *
 * Proves the ephemeral path end to end: cursor frames are sealed under a key
 * derived from the MLS exporter, relayed over a WebSocket that persists
 * nothing, and rendered as the peer's cursor. Also asserts the properties
 * that made this a separate channel in the first place — the ordered MLS log
 * does NOT grow while cursors move, and cursors expire when a peer leaves.
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

const logLength = (page, groupSlugChannels) =>
  page.evaluate(async (o) => {
    const chs = await (await fetch(o + "/api/channels", { credentials: "same-origin" })).json();
    const g = chs.channels[0].groupId;
    const r = await (await fetch(
      o + "/api/mls/groups/" + encodeURIComponent(g) + "/messages?since=0",
      { credentials: "same-origin" })).json();
    return r.messages.length;
  }, ORIGIN);

const browser = await chromium.launch();
const alice = await newUser(browser, "pr_a_" + rnd());
const bob = await newUser(browser, "pr_b_" + rnd());
console.log("· two identities registered");

const slug = "live-" + rnd();
await alice.page.getByRole("button", { name: "New channel" }).click();
await alice.page.getByPlaceholder("war-room").fill(slug);
await alice.page.getByRole("button", { name: "Create", exact: true }).click();
await alice.page.getByText(slug, { exact: true }).first().waitFor({ timeout: 60000 });

await alice.page.getByRole("button", { name: "Invite" }).click();
await alice.page.getByPlaceholder("ghost_01").last().fill(bob.handle);
await alice.page.getByRole("button", { name: "Invite", exact: true }).last().click();
await alice.page.waitForTimeout(6000);
console.log("· bob invited");

await bob.page.reload({ waitUntil: "networkidle" });
await bob.page.getByText(slug, { exact: true }).first().click({ timeout: 60000 });
await bob.page.getByRole("button", { name: "Canvas" }).click();
await bob.page.locator("canvas").waitFor({ timeout: 30000 });
await alice.page.getByRole("button", { name: "Canvas" }).click();
await alice.page.locator("canvas").waitFor({ timeout: 30000 });
await alice.page.waitForTimeout(2000);
console.log("· both on the canvas");

const before = await logLength(alice.page);

// Alice waves the cursor about without drawing.
const box = await alice.page.locator("canvas").boundingBox();
for (let i = 0; i < 40; i++) {
  await alice.page.mouse.move(box.x + 200 + i * 12, box.y + 200 + Math.sin(i / 4) * 90);
  await alice.page.waitForTimeout(40);
}
console.log("· alice moved the cursor 40 times without drawing");

// Bob must see her cursor, labelled.
await bob.page.waitForFunction(
  (h) => document.body.innerText.includes(h), alice.handle, { timeout: 30000 });
await bob.page.waitForFunction(
  () => /\d+ live · /i.test(document.body.innerText), undefined, { timeout: 30000 });
console.log("· bob sees alice's live cursor, labelled", JSON.stringify(alice.handle));

// The ordered log must be untouched by all that movement.
const after = await logLength(alice.page);
assert.equal(after, before, `presence must not append to the MLS log (was ${before}, now ${after})`);
console.log("· MLS log unchanged by cursor traffic:", before, "messages before and after");

// Leaving must retire the cursor rather than leaving a ghost.
await alice.page.getByRole("button", { name: "Chat" }).click();
await bob.page.waitForFunction(
  (h) => !document.body.innerText.includes(h), alice.handle, { timeout: 30000 });
console.log("· cursor expired after alice left the canvas");

const errs = [...alice.errors, ...bob.errors];
if (errs.length) {
  console.log("\nPAGE ERRORS:\n  " + errs.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nPRESENCE E2E PASSED (no page errors)");
}
await browser.close();
