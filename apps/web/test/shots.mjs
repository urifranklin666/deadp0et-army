/**
 * Screenshot every console surface, for design passes.
 *
 *   MODE=live node test/shots.mjs    — the deployed build
 *   MODE=dist node test/shots.mjs    — ./dist served in place of it
 *
 * Either way the API is the live one (WebAuthn checks the RP ID, so it has to
 * be the real origin), which means each run registers two throwaway users and
 * founds one channel there, exactly as e2e.mjs does. Output: $OUT or
 * /tmp/deadp0et-shots/<mode>/*.png at 2x.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const MODE = process.env.MODE || "live";
const OUT = process.env.OUT || `/tmp/deadp0et-shots/${MODE}`;
const DIST = path.resolve("dist");
const ORIGIN = "https://deadp0et.army";
const APP = ORIGIN + "/app/";
const rnd = () => Math.random().toString(36).slice(2, 7);
fs.mkdirSync(OUT, { recursive: true });

async function wire(context) {
  if (MODE !== "dist") return;
  await context.route(`${ORIGIN}/app/**`, (route) => {
    const u = new URL(route.request().url());
    let rel = u.pathname.replace(/^\/app\/?/, "");
    if (!rel || !/\.[a-z0-9]+$/i.test(rel)) rel = "index.html";
    const file = path.join(DIST, rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "nope" });
    return route.fulfill({ path: file });
  });
}

async function newUser(browser, handle, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await wire(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { const t = m.text(); if (m.type() === "error" && !/status of 401/.test(t)) errors.push("console: " + t); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
  return { context, page, errors, handle, cdp };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });
const settle = (page, ms = 700) => page.waitForTimeout(ms);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

// Sign-in screen, both sizes, plus its error state.
for (const [tag, vp] of [["desk", DESK], ["phone", PHONE]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  await wire(ctx);
  const p = await ctx.newPage();
  await p.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
  await settle(p);
  await shot(p, `auth-${tag}`);
  await ctx.close();
}

const alice = await newUser(browser, "shot_a_" + rnd(), DESK);
await alice.page.getByPlaceholder("ghost_01").fill(alice.handle);
await alice.page.getByRole("button", { name: "Create passkey" }).click();
await alice.page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
await settle(alice.page);
await shot(alice.page, "empty-desk");

const slug = "the-raven-" + rnd();
await alice.page.getByRole("button", { name: "New channel" }).click();
await settle(alice.page, 300);
await shot(alice.page, "modal-new-channel");
await alice.page.getByPlaceholder("war-room").fill(slug);
await alice.page.getByRole("button", { name: "Create", exact: true }).click();
await alice.page.getByText(/^epoch \d+$/).waitFor({ timeout: 60000 });
await settle(alice.page);
await shot(alice.page, "channel-empty");

const say = async (u, text) => {
  await u.page.getByPlaceholder(/Encrypted before it leaves/).fill(text);
  await u.page.getByRole("button", { name: "Send" }).click();
  await u.page.getByText(text.replace(/[*`]/g, "").slice(0, 20)).first().waitFor({ timeout: 30000 });
};
await say(alice, "the server is blind. it holds ciphertext and a cursor, nothing it can read.");
await say(alice, "epoch bumps on every membership change — check the `epoch` tag up top.");

// Bob joins and answers, so there is a real second voice.
const bob = await newUser(browser, "shot_b_" + rnd(), DESK);
await bob.page.getByPlaceholder("ghost_01").fill(bob.handle);
await bob.page.getByRole("button", { name: "Create passkey" }).click();
await bob.page.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
await alice.page.getByRole("button", { name: "Invite" }).click();
await alice.page.getByPlaceholder("ghost_01").fill(bob.handle);
await alice.page.getByRole("button", { name: "Invite", exact: true }).last().click();
await bob.page.getByText(slug, { exact: true }).first().click({ timeout: 60000 });
await bob.page.getByText(/^epoch \d+$/).waitFor({ timeout: 30000 });
await say(bob, `@${alice.handle} received. drawing something incriminating on the board now.`);
await say(bob, "**bold claim**: nobody upstream can read this. not even the people who wrote it.");
await alice.page.getByText("bold claim").waitFor({ timeout: 30000 });
// A reply from alice, quoting bob.
await alice.page.locator("li[data-seq]").last().hover();
await alice.page.getByRole("button", { name: /^Reply$/ }).last().click().catch(() => {});
await say(alice, "that is rather the point.");
// Bob types without sending: alice sees the typing line.
await bob.page.getByPlaceholder(/Encrypted before it leaves/).fill("still here, still sealed");
await settle(alice.page, 1500);
await shot(alice.page, "chat-desk");

// Hover a message to show the action bar.
const last = alice.page.locator("li[data-seq]").nth(2);
await last.hover();
await settle(alice.page, 300);
await shot(alice.page, "chat-hover-actions");

// Members popover, switcher, account, search.
await alice.page.getByRole("button", { name: "Members" }).click();
await settle(alice.page, 300);
await shot(alice.page, "members");
await alice.page.keyboard.press("Escape");
await alice.page.mouse.click(640, 400);
await alice.page.keyboard.press("Control+k");
await settle(alice.page, 300);
await shot(alice.page, "switcher");
await alice.page.keyboard.press("Escape");
await alice.page.getByRole("button", { name: "Account" }).click();
await settle(alice.page, 300);
await shot(alice.page, "account");
await alice.page.keyboard.press("Escape");
await alice.page.getByRole("button", { name: "Search messages" }).click();
await alice.page.getByPlaceholder(/Search this channel/).fill("blind");
await settle(alice.page, 400);
await shot(alice.page, "search");
await alice.page.keyboard.press("Escape");

// Canvas with a stroke and bob's cursor.
await alice.page.getByRole("button", { name: "Canvas" }).click();
await settle(alice.page, 400);
await shot(alice.page, "canvas-empty");
const c = await alice.page.locator("canvas").boundingBox();
await alice.page.mouse.move(c.x + 120, c.y + 120);
await alice.page.mouse.down();
for (let i = 0; i < 40; i++) await alice.page.mouse.move(c.x + 120 + i * 9, c.y + 120 + Math.sin(i / 4) * 60);
await alice.page.mouse.up();
await bob.page.getByRole("button", { name: "Canvas" }).click();
const cb = await bob.page.locator("canvas").boundingBox();
await bob.page.mouse.move(cb.x + 300, cb.y + 200);
await bob.page.mouse.move(cb.x + 320, cb.y + 220);
await settle(alice.page, 1200);
await shot(alice.page, "canvas-desk");

// Phone: list, then the open channel.
await alice.page.setViewportSize(PHONE);
await alice.page.getByRole("button", { name: "Chat" }).click();
await settle(alice.page, 500);
await shot(alice.page, "chat-phone");
await alice.page.getByRole("button", { name: "Back to channels" }).click();
await settle(alice.page, 400);
await shot(alice.page, "list-phone");
// Nothing on a phone may push the page wider than the screen.
const overflow = await alice.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("phone horizontal overflow:", overflow);

// Tab-lock screen.
const tab2 = await alice.context.newPage();
await tab2.goto(APP, { waitUntil: "networkidle", timeout: 60000 });
await tab2.getByText("Open in another tab").waitFor({ timeout: 30000 });
await settle(tab2, 300);
await shot(tab2, "elsewhere");

console.log("errors alice:", alice.errors, "bob:", bob.errors);
await browser.close();
console.log("done ->", OUT);
