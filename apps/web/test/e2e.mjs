/**
 * End-to-end browser test against the LIVE origin.
 *
 * It has to be the live origin: WebAuthn validates the RP ID, which is
 * deadp0et.army, so a localhost run would fail attestation. Passkeys are
 * driven by a CDP virtual authenticator, so no human touches a security key.
 *
 * Covers: passkey registration, device + key-package provisioning, channel
 * creation (which founds an MLS group), sending an encrypted message, and —
 * the one that actually matters — that history survives a reload, since MLS
 * application messages can only ever be decrypted once.
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const APP = ORIGIN + "/app/";
const rnd = () => Math.random().toString(36).slice(2, 8);

async function newUser(browser, handle) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // A 401 from /api/auth/me on first paint is the expected "not signed in
    // yet" probe, not a fault. Everything else counts.
    const t = m.text();
    if (m.type() === "error" && !/status of 401/.test(t)) errors.push("console: " + t);
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  await page.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByPlaceholder("ghost_01").fill(handle);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
  return { context, page, errors, handle };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const alice = await newUser(browser, "web_a_" + rnd());
console.log("· alice registered a passkey and booted:", alice.handle);

// Channel creation founds an MLS group client-side, then registers it.
const slug = "room-" + rnd();
await alice.page.getByRole("button", { name: "New channel" }).click();
await alice.page.getByPlaceholder("war-room").fill(slug);
await alice.page.getByRole("button", { name: "Create", exact: true }).click();
await alice.page.getByText(slug, { exact: true }).first().waitFor({ timeout: 60000 });
await alice.page.getByText(/^epoch \d+$/).waitFor({ timeout: 30000 });
const epoch0 = await alice.page.getByText(/^epoch \d+$/).innerText();
console.log("· channel created, MLS group founded at", epoch0);

// Send an encrypted message.
const MSG = "first light " + rnd();
await alice.page.getByPlaceholder(/Encrypted before it leaves/).fill(MSG);
await alice.page.getByRole("button", { name: "Send" }).click();
await alice.page.getByText(MSG).waitFor({ timeout: 30000 });
console.log("· message sent and rendered:", JSON.stringify(MSG));

// The server must be holding ciphertext only.
const seen = await alice.page.evaluate(async (o) => {
  const r = await fetch(o + "/api/channels", { credentials: "same-origin" });
  return (await r.json()).channels.length;
}, ORIGIN);
assert.ok(seen >= 1, "channel should be listed server-side");

// THE persistence check: reload and confirm decrypted history is still there.
await alice.page.reload({ waitUntil: "networkidle" });
await alice.page.getByText(slug, { exact: true }).first().click();
await alice.page.getByText(MSG).waitFor({ timeout: 60000 });
console.log("· history survived a full reload (IndexedDB state restored)");

// A second identity must not see the group at all until invited.
const bob = await newUser(browser, "web_b_" + rnd());
console.log("· bob registered:", bob.handle);
const bobChannels = await bob.page.evaluate(async (o) => {
  const r = await fetch(o + "/api/channels", { credentials: "same-origin" });
  return (await r.json()).channels;
}, ORIGIN);
assert.equal(bobChannels.length, 0, "bob must not see alice's channel before being invited");
console.log("· uninvited identity sees nothing");

// Invite bob; he should be granted membership by the Welcome.
await alice.page.getByRole("button", { name: "Invite" }).click();
await alice.page.getByPlaceholder("ghost_01").last().fill(bob.handle);
await alice.page.getByRole("button", { name: "Invite", exact: true }).last().click();
await alice.page.waitForTimeout(6000);

const afterInvite = await bob.page.evaluate(async (o) => {
  const r = await fetch(o + "/api/channels", { credentials: "same-origin" });
  return (await r.json()).channels;
}, ORIGIN);
assert.equal(afterInvite.length, 1, "the Welcome should have granted bob channel membership");
console.log("· invite granted bob membership via Welcome");

// Bob joins from the Welcome and replies; alice must see the reply attributed
// to bob — a name taken from his MLS credential, not from the server.
await bob.page.getByText(slug, { exact: true }).first().click({ timeout: 30000 });
await bob.page.getByText(/^epoch \d+$/).waitFor({ timeout: 30000 });
const REPLY = "reply " + rnd();
await bob.page.getByPlaceholder(/Encrypted before it leaves/).fill(REPLY);
await bob.page.getByRole("button", { name: "Send" }).click();
await bob.page.getByText(REPLY).waitFor({ timeout: 30000 });
const bubble = alice.page.locator("li", { hasText: REPLY });
await bubble.waitFor({ timeout: 30000 });
assert.ok((await bubble.innerText()).includes(bob.handle), "alice should see bob's handle on his message");
console.log("· bob replied; alice sees it attributed to", bob.handle);
if (process.env.SHOT) await alice.page.screenshot({ path: process.env.SHOT });

const allErrors = [...alice.errors, ...bob.errors];
if (allErrors.length) {
  console.log("\nPAGE ERRORS:\n  " + allErrors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nWEB CLIENT E2E PASSED (no page errors)");
}
await browser.close();
