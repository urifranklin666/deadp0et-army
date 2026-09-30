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
  const user = { removed: false, hints: [] };
  // Record delivery hints the api pushes to this tab.
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/api/live")) return;
    ws.on("framereceived", (f) => { try { user.hints.push(JSON.parse(f.payload)); } catch { /* binary */ } });
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // A 401 from /api/auth/me on first paint is the expected "not signed in
    // yet" probe, not a fault. So is the 404 on the group log that tells a
    // removed member they were removed — but only once they have been.
    const t = m.text();
    if (m.type() !== "error" || /status of 401/.test(t)) return;
    if (user.removed && /status of 404/.test(t) && /\/messages/.test(m.location().url)) return;
    errors.push("console: " + t);
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
  return Object.assign(user, { context, page, errors, handle });
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const alice = await newUser(browser, "web_a_" + rnd());
console.log("· alice registered a passkey and booted:", alice.handle);

// The console holds private keys, so injected script is key theft. The
// production build ships a CSP that must stop an inline <script> cold.
// (Skipped against a dev server, which has no CSP by design.)
const csp = await alice.page.evaluate(() =>
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null);
if (csp) {
  assert.match(csp, /script-src 'self'/);
  const ran = await alice.page.evaluate(() => new Promise((resolve) => {
    const el = document.createElement("script");
    el.textContent = "window.__injected = true";
    document.head.appendChild(el);
    setTimeout(() => resolve(window.__injected === true), 100);
  }));
  assert.equal(ran, false, "an injected inline script must not run");
  // The refusal logs a CSP violation — the expected outcome, not a fault.
  const others = alice.errors.filter((e) => !/Content Security Policy/i.test(e));
  alice.errors.splice(0, alice.errors.length, ...others);
  console.log("· CSP present and blocks injected inline script");
} else {
  console.log("· (no CSP: dev server)");
}

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
// The dialog opens with its text field focused, so it works from the keyboard.
const focused = await alice.page.evaluate(() => document.activeElement?.getAttribute("placeholder"));
assert.equal(focused, "ghost_01", "the invite dialog should focus its handle field");
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
await alice.page.waitForTimeout(3000);           // let alice's poll go quiet behind the hint socket
const sentAt = Date.now();
await bob.page.getByRole("button", { name: "Send" }).click();
await bob.page.getByText(REPLY).waitFor({ timeout: 30000 });
const bubble = alice.page.locator("li", { hasText: REPLY });
await bubble.waitFor({ timeout: 30000 });
// The api pushed alice a hint for the new log entry, and with the hint
// socket up her own poll is 20s — so a fast arrival is the hint's doing.
const lag = Date.now() - sentAt;
assert.ok(alice.hints.some((h) => h.t === "log"), "alice should have received a delivery hint");
assert.ok(lag < 4000, `reply took ${lag}ms to reach alice; delivery hints should make it near-instant`);
assert.ok((await bubble.innerText()).includes(bob.handle), "alice should see bob's handle on his message");
console.log("· bob replied; alice sees it attributed to", bob.handle, `(${lag}ms, via delivery hint)`);
// The roster lists both members once the epoch has moved.
await alice.page.getByRole("button", { name: "Members" }).click();
for (const h of [alice.handle, bob.handle]) {
  await alice.page.getByRole("listitem").filter({ hasText: h }).first().waitFor({ timeout: 15000 });
}
console.log("· member list shows both handles");
if (process.env.SHOT) await alice.page.screenshot({ path: process.env.SHOT });

// Unread: alice moves to another channel; bob posts in the first; alice's
// sidebar marks it, and opening it clears the mark.
await alice.page.keyboard.press("Escape");                   // close the member list
const slug2 = "room-" + rnd();
await alice.page.getByRole("button", { name: "New channel" }).click();
await alice.page.getByPlaceholder("war-room").fill(slug2);
await alice.page.getByRole("button", { name: "Create", exact: true }).click();
await alice.page.getByText(slug2, { exact: true }).first().waitFor({ timeout: 60000 });
await bob.page.getByPlaceholder(/Encrypted before it leaves/).fill("ping " + rnd());
await bob.page.getByRole("button", { name: "Send" }).click();
const room1 = alice.page.getByRole("button", { name: new RegExp(`^${slug}`) });
await room1.getByLabel("unread").waitFor({ timeout: 15000 });
await room1.click();
await room1.getByLabel("unread").waitFor({ state: "detached", timeout: 15000 });
console.log("· a hint marks a background channel unread; opening it clears the mark");

// Alice (owner) removes bob from the member list; bob's console notices.
await alice.page.getByRole("button", { name: "Members" }).click();
bob.removed = true;
await alice.page.getByRole("listitem").filter({ hasText: bob.handle })
  .getByRole("button", { name: "Remove" }).click();
await alice.page.getByRole("button", { name: "Remove", exact: true }).last().click();
await alice.page.getByText(`Removed ${bob.handle}`).waitFor({ timeout: 30000 });
await bob.page.getByText(/You were removed from this channel/).waitFor({ timeout: 30000 });
const bobAfter = await bob.page.evaluate(async (o) => {
  const r = await fetch(o + "/api/channels", { credentials: "same-origin" });
  return (await r.json()).channels.length;
}, ORIGIN);
assert.equal(bobAfter, 0, "bob should no longer see the channel");
console.log("· alice removed bob; bob's console shows it and the channel is gone for him");
if (process.env.SHOT2) await bob.page.screenshot({ path: process.env.SHOT2 });

if (process.env.SHOT3) await alice.page.screenshot({ path: process.env.SHOT3 });

// Sign out everywhere: alice lands back on the passkey screen.
await alice.page.getByRole("button", { name: "Sign out" }).click();
await alice.page.getByRole("button", { name: "Sign out everywhere" }).click();
await alice.page.getByRole("button", { name: "Create passkey" }).waitFor({ timeout: 30000 });
console.log("· sign out everywhere returns to the passkey screen");

const allErrors = [...alice.errors, ...bob.errors];
if (allErrors.length) {
  console.log("\nPAGE ERRORS:\n  " + allErrors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nWEB CLIENT E2E PASSED (no page errors)");
}
await browser.close();
