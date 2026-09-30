/**
 * One account, two devices.
 *
 * Alice's passkey is synced to a second browser (simulated by copying the
 * credential between CDP virtual authenticators). Signing in there creates a
 * second device: it sees her channels — membership is per user — but holds
 * no group keys, so it can't read them. From the first device she invites
 * her own handle, which adds only the device that's missing, and the second
 * device joins and reads what's sent from then on.
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const APP = ORIGIN + "/app/";
const rnd = () => Math.random().toString(36).slice(2, 8);

async function device(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push("console: " + m.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
  return { context, page, errors, cdp, authenticatorId };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const handle = "md_" + rnd();

// Laptop: register, found a channel, say something.
const laptop = await device(browser);
await laptop.page.getByPlaceholder("ghost_01").fill(handle);
await laptop.page.getByRole("button", { name: "Create passkey" }).click();
await laptop.page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
const slug = "both-" + rnd();
await laptop.page.getByRole("button", { name: "New channel" }).click();
await laptop.page.getByPlaceholder("war-room").fill(slug);
await laptop.page.getByRole("button", { name: "Create", exact: true }).click();
await laptop.page.getByPlaceholder(/Encrypted before it leaves/).waitFor({ timeout: 30000 });
console.log("· laptop registered and founded", slug);

// The passkey "syncs" to the phone.
const phone = await device(browser);
const { credentials } = await laptop.cdp.send("WebAuthn.getCredentials", { authenticatorId: laptop.authenticatorId });
assert.equal(credentials.length, 1);
await phone.cdp.send("WebAuthn.addCredential", { authenticatorId: phone.authenticatorId, credential: credentials[0] });

// Phone: sign in with the same passkey. It's a new device: it lists the
// channel but can't read it.
await phone.page.getByPlaceholder("ghost_01").fill(handle);
await phone.page.getByRole("button", { name: "Sign in" }).click();
await phone.page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
await phone.page.getByText(slug, { exact: true }).click();
await phone.page.getByText(/This device isn't a member yet/).waitFor({ timeout: 30000 });
console.log("· phone signed in with the synced passkey: sees the channel, holds no keys");

// Laptop invites its own handle: only the phone is missing, so only the
// phone is added.
await laptop.page.getByRole("button", { name: "Invite" }).click();
await laptop.page.getByPlaceholder("ghost_01").last().fill(handle);
await laptop.page.getByRole("button", { name: "Invite", exact: true }).last().click();
await laptop.page.getByText(/Invited .*\(1 device\)/).waitFor({ timeout: 30000 });
console.log("· laptop invited its own handle: exactly 1 device added");

// The phone joins on its own (Welcome hint) and reads what comes next.
await phone.page.getByPlaceholder(/Encrypted before it leaves/).waitFor({ timeout: 30000 });
const MSG = "from the laptop " + rnd();
await laptop.page.getByPlaceholder(/Encrypted before it leaves/).fill(MSG);
await laptop.page.getByRole("button", { name: "Send" }).click();
await phone.page.getByText(MSG).waitFor({ timeout: 30000 });
const REPLY = "from the phone " + rnd();
await phone.page.getByPlaceholder(/Encrypted before it leaves/).fill(REPLY);
await phone.page.getByRole("button", { name: "Send" }).click();
await laptop.page.getByText(REPLY).waitFor({ timeout: 30000 });
console.log("· both devices read each other: one account, two leaves");

const errors = [...laptop.errors, ...phone.errors];
if (errors.length) {
  console.log("\nPAGE ERRORS:\n  " + errors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nMULTI-DEVICE PASSED (no page errors)");
}
await browser.close();
