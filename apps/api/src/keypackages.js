import "@hpke/ml-kem";
import "@noble/post-quantum/ml-dsa.js";
import { decodeMlsMessage, getCiphersuiteFromName, nobleCryptoProvider } from "ts-mls";
// Public subpaths (ts-mls exports "./*.js"); not re-exported from the index.
import { verifyKeyPackage } from "ts-mls/keyPackage.js";
import { verifyLeafNodeSignatureKeyPackage } from "ts-mls/leafNode.js";

/**
 * Read a serialized KeyPackage and prove it: its own signature and its leaf
 * node's signature must both verify under the leaf's signature key. That is
 * proof the uploader holds the key's private half — without it, anyone could
 * register someone else's PUBLIC key (readable from any group's tree) as
 * their own, and have that person's messages attributed to them.
 *
 * Returns { identity, signatureKey } for a valid package, else null.
 */
const suites = new Map();          // ciphersuite name -> Promise<impl>
function suiteImpl(name) {
  if (!suites.has(name)) suites.set(name, nobleCryptoProvider.getCiphersuiteImpl(getCiphersuiteFromName(name)));
  return suites.get(name);
}

export async function verifiedKeyPackage(bytes) {
  let kp;
  try {
    const dec = decodeMlsMessage(new Uint8Array(bytes), 0);
    const msg = Array.isArray(dec) ? dec[0] : dec;
    if (msg?.wireformat !== "mls_key_package") return null;
    kp = msg.keyPackage;
  } catch {
    return null;
  }
  const cs = await suiteImpl(kp.cipherSuite).catch(() => null);
  if (!cs) return null;
  const ok = await verifyKeyPackage(kp, cs.signature).catch(() => false)
    && await verifyLeafNodeSignatureKeyPackage(kp.leafNode, cs.signature).catch(() => false);
  if (!ok) return null;
  const cred = kp.leafNode.credential;
  return {
    identity: cred.credentialType === "basic" ? Buffer.from(cred.identity).toString("utf8") : null,
    signatureKey: Buffer.from(kp.leafNode.signaturePublicKey),
  };
}
