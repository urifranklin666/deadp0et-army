import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const APP = ORIGIN + "/app/";
const rnd = () => Math.random().toString(36).slice(2, 8);

async function newUser(browser, handle) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(m.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol:"ctap2", transport:"internal", hasResidentKey:true, hasUserVerification:true, isUserVerified:true, automaticPresenceSimulation:true } });
  await page.goto(APP, { waitUntil:"networkidle", timeout:60000 });
  await page.getByPlaceholder("ghost_01").fill(handle);
  await page.getByRole("button", { name:"Create passkey" }).click();
  await page.getByRole("button", { name:"New channel" }).waitFor({ timeout:90000 });
  return { context, page, errors, handle };
}

const browser = await chromium.launch();
const alice = await newUser(browser, "ms_a_" + rnd());

// Recovery export is encrypted and rejects the wrong passphrase.
await alice.page.getByRole("button", { name:"Device recovery" }).click();
await alice.page.getByPlaceholder("12+ characters, stored nowhere").fill("correct horse battery staple");
const dlPromise = alice.page.waitForEvent("download");
await alice.page.getByRole("button", { name:/Export encrypted backup/ }).click();
const download = await dlPromise;
const file = await download.path();
const outer = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
assert.equal(outer.format, "deadp0et-recovery");
assert.ok(outer.ciphertext && !JSON.stringify(outer).includes(alice.handle), "outer recovery file must expose ciphertext, not the handle or records");
await alice.page.locator('input[type="file"]').setInputFiles(file);
await alice.page.getByPlaceholder("12+ characters, stored nowhere").fill("wrong passphrase indeed");
await alice.page.getByRole("button", { name:"Restore", exact:true }).click();
await alice.page.getByText(/passphrase is wrong or the file was modified/i).waitFor();
await alice.page.getByRole("button", { name:"Close" }).click();
console.log("· encrypted recovery exported; wrong passphrase rejected");

const bob = await newUser(browser, "ms_b_" + rnd());
const slug = "milestone-" + rnd();
await alice.page.getByRole("button", { name:"New channel" }).click();
await alice.page.getByPlaceholder("war-room").fill(slug);
await alice.page.getByRole("button", { name:"Create", exact:true }).click();
await alice.page.getByText(slug, { exact:true }).first().waitFor();
await alice.page.getByText(/synced/i).waitFor({ timeout:30000 });
console.log("· sync health reached synced state");

await alice.page.getByRole("button", { name:"Invite" }).click();
await alice.page.getByPlaceholder("ghost_01").last().fill(bob.handle);
await alice.page.getByRole("button", { name:"Invite", exact:true }).last().click();
await alice.page.waitForTimeout(1000);
await alice.page.getByRole("button", { name:"Room members" }).click();
await alice.page.getByText(`@${bob.handle}`).waitFor();
await alice.page.getByRole("button", { name:`Remove ${bob.handle}` }).click();
await alice.page.getByText(new RegExp(`${bob.handle} removed`)).waitFor({ timeout:30000 });
const bobChannels = await bob.page.evaluate(async () => (await (await fetch("/api/channels")).json()).channels);
assert.equal(bobChannels.length, 0, "removed member must lose channel access");
console.log("· owner roster removal advanced MLS and revoked channel access");

const errors = [...alice.errors, ...bob.errors];
if (errors.length) { console.error(errors); process.exitCode = 1; }
else console.log("\nFIRST PRODUCT MILESTONE PASSED");
await browser.close();
