/**
 * Desktop notifications say who and where — never what.
 *
 * Bob turns notifications on and his tab goes to the background. Alice
 * writes in the channel he has open and in another he's in: he gets one
 * notification naming alice (by her verified key) and the channel, and one
 * saying there's activity elsewhere. Neither contains the message text,
 * which would otherwise end up in the OS notification centre.
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const APP = ORIGIN + "/app/";
const rnd = () => Math.random().toString(36).slice(2, 8);

async function user(browser, handle, { background = false } = {}) {
  const context = await browser.newContext();
  if (background) {
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    // Record what would be shown, and make the page look backgrounded.
    await context.addInitScript(() => {
      window.__notes = [];
      window.Notification = class {
        static permission = "granted";
        static requestPermission() { return Promise.resolve("granted"); }
        constructor(title, opts) { window.__notes.push({ title, body: opts?.body }); }
        close() {}
      };
      Object.defineProperty(document, "visibilityState", { get: () => window.__vis || "visible" });
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push("console: " + m.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByPlaceholder("ghost_01").fill(handle);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
  return { page, errors, handle };
}

async function channel(u, slug) {
  await u.page.getByRole("button", { name: "New channel" }).click();
  await u.page.getByPlaceholder("war-room").fill(slug);
  await u.page.getByRole("button", { name: "Create", exact: true }).click();
  await u.page.getByPlaceholder(/Encrypted before it leaves/).waitFor({ timeout: 30000 });
}

async function invite(u, handle) {
  await u.page.getByRole("button", { name: "Invite" }).click();
  await u.page.getByPlaceholder("ghost_01").last().fill(handle);
  await u.page.getByRole("button", { name: "Invite", exact: true }).last().click();
  await u.page.getByText(new RegExp(`Invited ${handle}`)).waitFor({ timeout: 30000 });
}

async function say(u, text) {
  await u.page.getByPlaceholder(/Encrypted before it leaves/).fill(text);
  await u.page.getByRole("button", { name: "Send" }).click();
  await u.page.getByText(text).waitFor({ timeout: 30000 });
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const alice = await user(browser, "nt_a_" + rnd());
const bob = await user(browser, "nt_b_" + rnd(), { background: true });

const main = "main-" + rnd();
const side = "side-" + rnd();
await channel(alice, side);
await invite(alice, bob.handle);
await channel(alice, main);
await invite(alice, bob.handle);

// Bob opens main and turns notifications on.
await bob.page.getByText(main, { exact: true }).click({ timeout: 30000 });
await bob.page.getByPlaceholder(/Encrypted before it leaves/).waitFor({ timeout: 30000 });
await bob.page.getByRole("button", { name: "Account" }).click();
await bob.page.getByRole("button", { name: "Turn on desktop notifications" }).click();
await bob.page.evaluate(() => { window.__vis = "hidden"; });
console.log("· bob turned notifications on and went to the background");

const SECRET = "the vault code is " + rnd();
await say(alice, SECRET);
await bob.page.waitForFunction(() => window.__notes.length > 0, null, { timeout: 30000 });
let notes = await bob.page.evaluate(() => window.__notes);
assert.equal(notes[0].title, `#${main}`);
assert.match(notes[0].body, new RegExp(`from ${alice.handle}$`), "names the sender");
console.log("· notified:", JSON.stringify(notes[0]));

// Activity in a channel bob isn't looking at: where, not what.
await alice.page.getByText(side, { exact: true }).click();
await alice.page.getByPlaceholder(/Encrypted before it leaves/).waitFor({ timeout: 30000 });
await say(alice, SECRET + " (again)");
await bob.page.waitForFunction(() => window.__notes.some((n) => /New activity/.test(n.body)), null, { timeout: 30000 });
notes = await bob.page.evaluate(() => window.__notes);
assert.ok(notes.some((n) => n.body === `New activity in #${side}`));

for (const n of notes) {
  assert.ok(!`${n.title} ${n.body}`.includes("vault code"), "a notification must never contain message text");
}
console.log("· activity elsewhere notified by channel only; no notification carried message text");

// Reading back through history isn't interrupted: with bob scrolled up, a
// new message leaves his place alone and offers a button to jump down.
await alice.page.getByText(main, { exact: true }).click();
await alice.page.getByPlaceholder(/Encrypted before it leaves/).waitFor({ timeout: 30000 });
await bob.page.setViewportSize({ width: 900, height: 420 });
for (let i = 0; i < 12; i++) await say(alice, `filler ${i} ${rnd()}`);
const scroller = bob.page.getByRole("log", { name: "Messages" });
await bob.page.getByText(/^filler 11 /).waitFor({ timeout: 30000 });
await scroller.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
await say(alice, "while bob reads back " + rnd());
const jump = bob.page.getByRole("button", { name: /^\d+ new messages?$/ });
await jump.waitFor({ timeout: 30000 });
assert.equal(await scroller.evaluate((el) => el.scrollTop), 0, "bob's reading position is left alone");
await jump.click();
await jump.waitFor({ state: "detached", timeout: 10000 });
assert.ok(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80),
  "the button takes him to the latest message");
console.log("· a new message doesn't yank a reader who scrolled up; a button takes them down");

const errors = [...alice.errors, ...bob.errors];
if (errors.length) {
  console.log("\nPAGE ERRORS:\n  " + errors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nNOTIFICATIONS PASSED (no page errors)");
}
await browser.close();
