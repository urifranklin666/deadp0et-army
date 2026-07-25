// Runs the SHARED client module (packages/crypto) in the browser, unmodified.
// If this passes, one code path serves both the web client and Node.
//
// No top-level await here — see the note in packages/crypto/src/mls.js.
import { MlsClient, SUITE, b64, unb64 } from "@deadp0et/crypto/mls";

const out = document.getElementById("out");
const lines = []; const t0 = performance.now();
const log = (s) => { lines.push("[" + ((performance.now()-t0)/1000).toFixed(1) + "s] " + s); out.textContent = lines.join("\n"); };

(async () => {
  try {
    log("suite: " + SUITE);
    const A = await MlsClient.create("alice");
    const B = await MlsClient.create("bob");
    log("clients ready");

    await A.newKeyPackage();
    const bKp = await B.newKeyPackage();
    log("key packages generated");

    await A.createGroup(crypto.getRandomValues(new Uint8Array(16)));
    log("group created at epoch " + A.epoch);

    // Round-trip through base64 exactly as the wire would.
    const add = await A.addMembers([unb64(b64(bKp.encoded))]);
    log("add committed, built at epoch " + add.builtAtEpoch);

    await B.joinFromWelcome(unb64(b64(add.welcome)));
    if (A.epoch !== B.epoch) throw new Error("epoch mismatch " + A.epoch + " vs " + B.epoch);
    log("bob joined; both at epoch " + B.epoch);

    const MSG = "canvas op: rect(12,40,180,90) #ff2247";
    const ct = await A.encrypt(MSG);
    if (new TextDecoder("latin1").decode(ct).includes(MSG)) throw new Error("plaintext leaked into ciphertext");
    const got = await B.apply(unb64(b64(ct)));
    if (got !== MSG) throw new Error("plaintext mismatch: " + got);
    log("bob decrypted: " + JSON.stringify(got));

    log("BROWSER SELF-CHECK PASSED");
    window.__RESULT__ = { ok: true, lines };
  } catch (e) {
    log("FAILED: " + (e && e.message));
    window.__RESULT__ = { ok: false, error: String(e && e.message), lines };
  }
})();
