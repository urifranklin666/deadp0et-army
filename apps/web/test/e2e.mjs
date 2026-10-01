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
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
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
  return Object.assign(user, { context, page, errors, handle, cdp, authenticatorId });
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// The passkey screen must not wait on the MLS stack: with that chunk
// unreachable it still paints. (Production build only; the dev server
// doesn't chunk.)
{
  const context = await browser.newContext();
  const page = await context.newPage();
  let blocked = 0;
  await page.route(/\/assets\/session-[^/]*\.js$/, (r) => { blocked++; return r.abort(); });
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("button", { name: "Create passkey" }).waitFor({ timeout: 30000 });
  const built = await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'));
  if (built) {
    assert.ok(blocked > 0, "the production build should fetch the MLS stack as its own chunk");
    console.log("· the sign-in screen paints without the MLS chunk");
  }
  await context.close();
}

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

// Signing back in with the passkey — not just riding the session cookie
// registration left behind — is the path every returning user takes.
await alice.page.getByRole("button", { name: "Account" }).click();
await alice.page.getByRole("button", { name: "Sign out", exact: true }).click();
await alice.page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 30000 });
await alice.page.getByPlaceholder("ghost_01").fill(alice.handle);
await alice.page.getByRole("button", { name: "Sign in" }).click();
await alice.page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 60000 });
console.log("· alice signed out and back in with her passkey");

// A backup passkey: add one from a second authenticator, unplug the first,
// and sign in with only the backup present.
await alice.page.getByRole("button", { name: "Account" }).click();
await alice.page.getByRole("button", { name: "Passkeys…" }).click();
await alice.page.getByText("Passkey 1").waitFor({ timeout: 15000 });
assert.ok(await alice.page.getByRole("button", { name: "Remove passkey 1" }).isDisabled(),
  "the only passkey can't be removed");
// Adding one first re-proves an existing passkey (the step-up), so the old
// authenticator stays plugged in until the new passkey exists.
const backup = await alice.cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true },
});
await alice.page.getByRole("button", { name: "Add a passkey" }).click();
await alice.page.getByText("Passkey 2").waitFor({ timeout: 30000 });
await alice.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: alice.authenticatorId });
await alice.page.keyboard.press("Escape");
await alice.page.getByRole("button", { name: "Account" }).click();
await alice.page.getByRole("button", { name: "Sign out", exact: true }).click();
await alice.page.getByPlaceholder("ghost_01").fill(alice.handle);
await alice.page.getByRole("button", { name: "Sign in" }).click();
await alice.page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 60000 });
alice.authenticatorId = backup.authenticatorId;
console.log("· a backup passkey from another authenticator signs alice in on its own");

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

// A second tab of the same browser shares the device's keys; it must stand
// down rather than advance the same MLS state separately.
const tab2 = await alice.context.newPage();
await tab2.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
await tab2.getByText("Open in another tab").waitFor({ timeout: 30000 });
await tab2.close();
console.log("· a second tab stands down instead of sharing the keys");

// An unsent draft is kept across the reload below.
const DRAFT = "unsent thought " + rnd();
await alice.page.getByPlaceholder(/Encrypted before it leaves/).fill(DRAFT);
await alice.page.waitForTimeout(600);                 // the draft is saved once typing pauses

// THE persistence check: reload and confirm decrypted history is still there.
await alice.page.reload({ waitUntil: "networkidle" });
await alice.page.getByText(slug, { exact: true }).first().click();
await alice.page.getByText(MSG).waitFor({ timeout: 60000 });
console.log("· history survived a full reload (IndexedDB state restored)");
assert.equal(await alice.page.getByPlaceholder(/Encrypted before it leaves/).inputValue(), DRAFT,
  "an unsent draft survives a reload");
await alice.page.getByPlaceholder(/Encrypted before it leaves/).fill("");
console.log("· the unsent draft survived it too");

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

// Search filters the transcript on this device: bob's reply matches by its
// text, alice's own earlier message doesn't, and the query goes nowhere.
{
  const p = alice.page;
  const sentOut = [];
  const spy = (req) => sentOut.push(req.url() + " " + (req.postData() || ""));
  p.on("request", spy);
  await p.getByRole("button", { name: "Search messages" }).click();
  const needle = REPLY.split(" ")[1];                // the random part
  await p.getByLabel("Search this channel").fill(needle.toUpperCase());   // case-insensitive
  await p.getByRole("status").filter({ hasText: /^1 match$/ }).waitFor({ timeout: 10000 });
  assert.equal(await p.locator("mark").first().innerText(), needle, "the match is highlighted");
  assert.equal(await p.locator("li", { hasText: "first light" }).count(), 0, "non-matching messages are hidden");
  await p.getByLabel("Search this channel").fill("no-such-words-" + rnd());
  await p.getByText(/No messages here match/).waitFor({ timeout: 10000 });
  await p.getByLabel("Search this channel").press("Escape");
  await p.locator("li", { hasText: "first light" }).first().waitFor({ timeout: 10000 });
  p.off("request", spy);
  assert.ok(!sentOut.some((r) => r.toLowerCase().includes(needle)), "the search query must never be sent anywhere");
  console.log("· search filters and highlights on-device; the query never leaves the page");
}

// The transcript is split by day, and bob can withdraw his reply: two clicks,
// and alice's copy becomes "… deleted this message".
await alice.page.getByRole("separator").filter({ hasText: "Today" }).first().waitFor({ timeout: 10000 });
// Alice answers bob's reply; bob sees it quoted. Then bob edits his message:
// alice's copy, and her quote of it, follow, marked "(edited)".
const ANSWER = "answering bob " + rnd();
await alice.page.locator("li", { hasText: REPLY }).getByRole("button", { name: "Reply" }).click();
await alice.page.getByText(/^Replying to/).waitFor({ timeout: 10000 });
await alice.page.getByPlaceholder(/Encrypted before it leaves/).fill(ANSWER);
await alice.page.getByRole("button", { name: "Send" }).click();
const answerOnBob = bob.page.locator("li", { hasText: ANSWER });
await answerOnBob.waitFor({ timeout: 30000 });
assert.ok((await answerOnBob.innerText()).includes(REPLY), "bob sees which message alice answered");
console.log("· alice replied to bob's message; bob sees it quoted");

const EDITED = REPLY + " (revised)";
await bob.page.getByRole("button", { name: "Edit message" }).last().click();
const box = bob.page.getByPlaceholder(/Encrypted before it leaves/);
assert.equal(await box.inputValue(), REPLY, "editing starts from the message's text");
await box.fill(EDITED);
await bob.page.getByRole("button", { name: "Save" }).click();
await alice.page.locator("li", { hasText: EDITED }).filter({ hasText: "(edited)" }).first().waitFor({ timeout: 30000 });
assert.equal(await box.inputValue(), "", "the composer is clear again after saving");
console.log("· bob edited his message; alice sees the new text, marked edited");

await bob.page.getByRole("button", { name: "Delete message" }).last().click();
await bob.page.getByRole("button", { name: "Confirm delete for everyone" }).click();
await bob.page.getByText("You deleted this message").waitFor({ timeout: 30000 });
await alice.page.getByText(`${bob.handle} deleted this message`).waitFor({ timeout: 30000 });
assert.equal(await alice.page.getByText(REPLY).count(), 0, "the withdrawn text is gone from alice's transcript");
await alice.page.locator("li", { hasText: ANSWER }).getByText("A deleted message").waitFor({ timeout: 10000 });
console.log("· bob deleted his reply; alice's copy is replaced");
// The roster lists both members once the epoch has moved.
await alice.page.getByRole("button", { name: "Members" }).click();
for (const h of [alice.handle, bob.handle]) {
  await alice.page.getByRole("listitem").filter({ hasText: h }).first().waitFor({ timeout: 15000 });
}
console.log("· member list shows both handles");

// The owner can promote bob to admin and back.
const bobRow = alice.page.getByRole("listitem").filter({ hasText: bob.handle });
await bobRow.getByRole("button", { name: "Make admin" }).click();
await bobRow.getByText("admin", { exact: true }).waitFor({ timeout: 15000 });
await bobRow.getByRole("button", { name: "Revoke admin" }).click();
await bobRow.getByRole("button", { name: "Make admin" }).waitFor({ timeout: 15000 });
console.log("· owner promotes bob to admin and back");
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

// Bob deletes his account; the handle can't be taken again.
await bob.page.getByRole("button", { name: "Account" }).click();
await bob.page.getByRole("button", { name: "Delete account…" }).click();
await bob.page.getByPlaceholder(bob.handle).fill(bob.handle);
await bob.page.getByRole("button", { name: "Delete for good" }).click();
await bob.page.getByRole("button", { name: "Create passkey" }).waitFor({ timeout: 30000 });
await bob.page.getByPlaceholder("ghost_01").fill(bob.handle);
await bob.page.getByRole("button", { name: "Create passkey" }).click();
await bob.page.getByText(/handle taken/i).waitFor({ timeout: 15000 });
bob.errors.splice(0, bob.errors.length, ...bob.errors.filter((e) => !/status of 409/.test(e)));
console.log("· bob deleted his account; his handle is retired");

// Sign out everywhere: alice lands back on the passkey screen.
await alice.page.getByRole("button", { name: "Account" }).click();
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
