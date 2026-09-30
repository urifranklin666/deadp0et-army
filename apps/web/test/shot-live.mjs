import { chromium } from "playwright";
const SP = process.env.SP, APP = "https://deadp0et.army/app/";
const rnd = () => Math.random().toString(36).slice(2,7);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
async function mk(handle){
  const c = await b.newContext({ viewport:{width:1280,height:800} });
  const p = await c.newPage();
  const cdp = await c.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await p.goto(APP,{waitUntil:"networkidle"});
  await p.getByPlaceholder("ghost_01").fill(handle);
  await p.getByRole("button",{name:"Create passkey"}).click();
  await p.getByRole("button",{name:"New channel"}).waitFor({timeout:90000});
  return p;
}
const A = await mk("nyx_"+rnd()), Bp = await mk("vex_"+rnd());
const slug = "situation-"+rnd();
await A.getByRole("button",{name:"New channel"}).click();
await A.getByPlaceholder("war-room").fill(slug);
await A.screenshot({ path: `${SP}/live-1-modal.png` });      // modal shot
await A.getByRole("button",{name:"Create",exact:true}).click();
await A.getByText(slug,{exact:true}).first().waitFor({timeout:60000});

const bobHandle = await Bp.evaluate(async () => (await (await fetch("/api/auth/me",{credentials:"same-origin"})).json()).user.handle);
await A.getByRole("button",{name:"Invite"}).click();
await A.getByPlaceholder("ghost_01").last().fill(bobHandle);
await A.getByRole("button",{name:"Invite",exact:true}).last().click();
await A.waitForTimeout(6000);

await Bp.reload({waitUntil:"networkidle"});
await Bp.getByText(slug,{exact:true}).first().click({timeout:60000});
await Bp.getByRole("button",{name:"Canvas"}).click();
await Bp.locator("canvas").waitFor({timeout:30000});
await A.getByRole("button",{name:"Canvas"}).click();
await A.locator("canvas").waitFor({timeout:30000});
await A.waitForTimeout(1500);

const box = await A.locator("canvas").boundingBox();
const stroke = async (pts,page) => {
  const bb = await page.locator("canvas").boundingBox();
  await page.mouse.move(bb.x+pts[0][0], bb.y+pts[0][1]); await page.mouse.down();
  for (const [x,y] of pts.slice(1)) await page.mouse.move(bb.x+x, bb.y+y,{steps:8});
  await page.mouse.up(); await page.waitForTimeout(600);
};
await stroke([[150,150],[300,230],[450,150],[600,250]], A);
await Bp.getByLabel("Colour #e879f9").click();
await stroke([[180,380],[340,430],[500,360]], Bp);
// Park alice's cursor mid-canvas so it renders in bob's shot.
for (let i=0;i<12;i++){ await A.mouse.move(box.x+520+i*6, box.y+300+i*3); await A.waitForTimeout(60); }
await Bp.waitForTimeout(1200);
await Bp.screenshot({ path: `${SP}/live-2-cursor.png` });
console.log("captured");
await b.close();
