/**
 * The marketing site must actually hand off to the live console.
 *
 * Also guards the honesty split: the marketing page must describe what the
 * repository actually implements and must keep the audit warning visible.
 */
import { chromium } from "playwright";
import assert from "node:assert/strict";

const ORIGIN = process.env.ORIGIN || "https://deadp0et.army";
const browser = await chromium.launch();
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
// Navigating into /app/ makes the console probe /api/auth/me while signed
// out; that 401 is the expected "not authenticated" answer, not a fault.
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/status of 401/.test(t)) errors.push("console: " + t);
});

await page.goto(ORIGIN + "/", { waitUntil: "networkidle", timeout: 60000 });
assert.match(await page.title(), /DEADP0ET/, "marketing page should load");
console.log("· marketing site loaded");

// Every console CTA must be a real anchor, not an onClick trap.
const hrefs = await page.$$eval('a[href="/app/"]', (els) => els.length);
assert.ok(hrefs >= 2, `expected several /app/ anchors, found ${hrefs}`);
console.log("· console anchors on the page:", hrefs);

// The hero CTA navigates for real.
await page.getByRole("link", { name: /Open the console/i }).first().click();
await page.waitForURL(/\/app\/?$/, { timeout: 60000 });
await page.getByRole("button", { name: "Create passkey" }).waitFor({ timeout: 60000 });
console.log("· hero CTA lands on the console auth screen");

// Nav CTA from a fresh load.
await page.goto(ORIGIN + "/", { waitUntil: "networkidle" });
await page.getByRole("link", { name: /^Open console$/i }).first().click();
await page.waitForURL(/\/app\/?$/, { timeout: 60000 });
console.log("· nav CTA lands on the console");

// The proof panel describes the actual trust model, not fictional infrastructure.
await page.goto(ORIGIN + "/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Post-quantum MLS/i }).click();
await page.getByText(/ML-KEM1024 \+ ML-DSA87/).waitFor({ timeout: 30000 });
await page.getByText(/not audited/i).first().waitFor({ timeout: 30000 });
assert.equal(await page.getByText(/42 relay jurisdictions/i).count(), 0,
  "the page must not claim fictional relay infrastructure");
console.log("· proof panel and audit warning are honest");

// Mobile: the console link is reachable without a desktop nav.
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
mp.on("pageerror", (e) => errors.push("mobile pageerror: " + e.message));
await mp.goto(ORIGIN + "/", { waitUntil: "networkidle" });
await mp.getByRole("button", { name: "Toggle menu" }).click();
await mp.getByRole("link", { name: /Open console/i }).first().click();
await mp.waitForURL(/\/app\/?$/, { timeout: 60000 });
console.log("· mobile menu reaches the console");
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.equal(overflow, 0, "no horizontal overflow on mobile");

if (errors.length) {
  console.log("\nPAGE ERRORS:\n  " + errors.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("\nMARKETING FUNNEL PASSED (no page errors)");
}
await browser.close();
