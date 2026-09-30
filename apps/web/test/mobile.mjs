/**
 * The console at phone width: one pane at a time, nothing wider than the
 * screen, and every control reachable.
 *
 * At 390px the sidebar and the conversation can't share the screen, so the
 * channel list and an open channel take turns (with a Back button).
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const rnd = () => Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push("console: " + m.text());
});
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true },
});

const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

await page.goto(ORIGIN + "/app/", { waitUntil: "networkidle", timeout: 60000 });
await page.getByPlaceholder("ghost_01").fill("mob_" + rnd());
await page.getByRole("button", { name: "Create passkey" }).click();
await page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
assert.equal(await overflow(), 0, "channel list must fit a phone");

const slug = "pocket-" + rnd();
await page.getByRole("button", { name: "New channel" }).click();
await page.getByPlaceholder("war-room").fill(slug);
await page.getByRole("button", { name: "Create", exact: true }).click();
const composer = page.getByPlaceholder(/Encrypted before it leaves/);
await composer.waitFor({ timeout: 30000 });
assert.equal(await page.getByText("Channels", { exact: true }).isVisible(), false,
  "an open channel takes the whole screen");
for (const name of ["Chat", "Canvas", "Members", "Invite", "Send", "Back to channels"]) {
  assert.ok(await page.getByRole("button", { name, exact: true }).isVisible(), `${name} should be reachable`);
}
await composer.fill("sent from a phone");
await page.getByRole("button", { name: "Send" }).click();
await page.getByText("sent from a phone").waitFor({ timeout: 30000 });
assert.equal(await overflow(), 0, "an open conversation must fit a phone");
console.log("· conversation fits at 390px with every control reachable");

await page.getByRole("button", { name: "Canvas" }).click();
await page.getByText(/strokes/i).first().waitFor({ timeout: 15000 });
assert.equal(await overflow(), 0, "the canvas must fit a phone");
console.log("· canvas fits");

await page.getByRole("button", { name: "Back to channels" }).click();
await page.getByText(slug, { exact: true }).waitFor({ timeout: 15000 });
assert.equal(await overflow(), 0);
await page.getByText(slug, { exact: true }).click();
await page.getByRole("button", { name: "Back to channels" }).waitFor({ timeout: 15000 });
console.log("· Back returns to the list, and the list reopens the channel");

if (errors.length) {
  console.log("\nPAGE ERRORS:\n  " + errors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nMOBILE LAYOUT PASSED (no page errors)");
}
await browser.close();
