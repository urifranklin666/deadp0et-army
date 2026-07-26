import { chromium } from "playwright";
const SP = process.env.SP;
const APP = "https://deadp0et.army/app/";
const rnd = () => Math.random().toString(36).slice(2, 7);
const b = await chromium.launch();

// auth screen
const c1 = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p1 = await c1.newPage();
await p1.goto(APP, { waitUntil: "networkidle" });
await p1.screenshot({ path: `${SP}/app-1-auth.png` });

// signed in, with a channel and messages
const cdp = await c1.newCDPSession(p1);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol:"ctap2", transport:"internal", hasResidentKey:true, hasUserVerification:true, isUserVerified:true, automaticPresenceSimulation:true }});
await p1.getByPlaceholder("ghost_01").fill("shot_" + rnd());
await p1.getByRole("button", { name: "Create passkey" }).click();
await p1.getByRole("button", { name: "New channel" }).waitFor({ timeout: 90000 });
await p1.screenshot({ path: `${SP}/app-2-empty.png` });

const slug = "war-room-" + rnd();
p1.once("dialog", d => d.accept(slug));
await p1.getByRole("button", { name: "New channel" }).click();
await p1.getByText(slug, { exact: true }).first().waitFor({ timeout: 60000 });
for (const m of ["relay mesh is up. 42 nodes green.", "canvas op: rect(12,40,180,90) #ff2247", "burn the epoch when we're done"]) {
  await p1.getByPlaceholder(/Encrypted before it leaves/).fill(m);
  await p1.getByRole("button", { name: "Send" }).click();
  await p1.getByText(m).waitFor({ timeout: 30000 });
}
await p1.waitForTimeout(1200);
await p1.screenshot({ path: `${SP}/app-3-chat.png` });

// mobile
const c2 = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p2 = await c2.newPage();
await p2.goto(APP, { waitUntil: "networkidle" });
await p2.screenshot({ path: `${SP}/app-4-mobile.png` });
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("mobile horizontal overflow:", overflow);
await b.close();
