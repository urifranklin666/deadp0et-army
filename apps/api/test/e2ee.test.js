/**
 * End-to-end proof that the relay is actually a relay.
 *
 * Two devices perform a real PQXDH handshake (X25519 + Kyber1024) and Double
 * Ratchet exchange using Signal's own libsignal, talking only through the
 * public HTTP API. The test asserts both that the plaintext round-trips AND
 * that what the server stored is ciphertext not containing the plaintext.
 *
 * Sessions are seeded directly in the DB because WebAuthn needs an
 * authenticator; every other step goes over HTTP exactly as a client would.
 */
import crypto from "node:crypto";
import assert from "node:assert/strict";
import * as si from "@signalapp/libsignal-client";
import { q, pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:8790";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

// libsignal returns Uint8Array, whose .toString("base64") silently yields
// "5,212,120,..." instead of base64. Always go through Buffer.from first.
const enc = (u8) => Buffer.from(u8).toString("base64");
const dec = (s) => Buffer.from(String(s), "base64");

async function seedUser(handle) {
  await q("DELETE FROM users WHERE handle=$1", [handle]);
  const { rows } = await q("INSERT INTO users(handle) VALUES ($1) RETURNING id", [handle]);
  const token = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
    [rows[0].id, sha256(token)]);
  return { id: rows[0].id, handle, cookie: `dp_session=${token}` };
}

const api = async (user, method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", cookie: user.cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return json;
};

/**
 * Minimal in-memory libsignal stores — a real client would persist these.
 *
 * Extends IdentityKeyStore specifically: that base class supplies a concrete
 * getIdentityKeyPair() derived from getIdentityKey(), and the native layer
 * calls it. The other four store bases are empty, so duck typing covers them.
 */
class Stores extends si.IdentityKeyStore {
  constructor(identity, registrationId) {
    super();
    this.identity = identity; this.registrationId = registrationId;
    this.sessions = new Map(); this.identities = new Map();
    this.preKeys = new Map(); this.signedPreKeys = new Map(); this.kyberPreKeys = new Map();
    this.usedKyber = new Set();
  }
  // SessionStore
  async saveSession(addr, rec) { this.sessions.set(addr.toString(), rec); }
  async getSession(addr) { return this.sessions.get(addr.toString()) ?? null; }
  async getExistingSessions(addrs) { return addrs.map((a) => this.sessions.get(a.toString())); }
  // IdentityKeyStore
  async getIdentityKey() { return this.identity.privateKey; }
  async getLocalRegistrationId() { return this.registrationId; }
  async saveIdentity(addr, key) { this.identities.set(addr.toString(), key); return 0; }
  async isTrustedIdentity() { return true; }
  async getIdentity(addr) { return this.identities.get(addr.toString()) ?? null; }
  // PreKeyStore
  async savePreKey(id, rec) { this.preKeys.set(id, rec); }
  async getPreKey(id) { return this.preKeys.get(id); }
  async removePreKey(id) { this.preKeys.delete(id); }
  // SignedPreKeyStore
  async saveSignedPreKey(id, rec) { this.signedPreKeys.set(id, rec); }
  async getSignedPreKey(id) { return this.signedPreKeys.get(id); }
  // KyberPreKeyStore
  async saveKyberPreKey(id, rec) { this.kyberPreKeys.set(id, rec); }
  async getKyberPreKey(id) { return this.kyberPreKeys.get(id); }
  async markKyberPreKeyUsed(id) { this.usedKyber.add(id); }
}

/** Generate device key material and register it with the server. */
async function provisionDevice(user, name) {
  const identity = si.IdentityKeyPair.generate();
  const registrationId = 1 + Math.floor(Math.random() * 16000);
  const stores = new Stores(identity, registrationId);

  const spkId = 1, spkPriv = si.PrivateKey.generate();
  const spkPub = spkPriv.getPublicKey();
  const spkSig = identity.privateKey.sign(spkPub.serialize());
  await stores.saveSignedPreKey(spkId,
    si.SignedPreKeyRecord.new(spkId, Date.now(), spkPub, spkPriv, spkSig));

  const otpkId = 1, otpkPriv = si.PrivateKey.generate();
  const otpkPub = otpkPriv.getPublicKey();
  await stores.savePreKey(otpkId, si.PreKeyRecord.new(otpkId, otpkPub, otpkPriv));

  // PQXDH: Kyber1024 prekey, signed by the identity key.
  const kyberId = 1, kyberPair = si.KEMKeyPair.generate();
  const kyberPub = kyberPair.getPublicKey();
  const kyberSig = identity.privateKey.sign(kyberPub.serialize());
  await stores.saveKyberPreKey(kyberId,
    si.KyberPreKeyRecord.new(kyberId, Date.now(), kyberPair, kyberSig));

  const { deviceId } = await api(user, "POST", "/api/devices", {
    name, registrationId,
    identityKey: enc(identity.publicKey.serialize()),
    signedPreKey: {
      keyId: spkId,
      publicKey: enc(spkPub.serialize()),
      signature: enc(spkSig),
    },
    kyberPreKey: {
      keyId: kyberId,
      publicKey: enc(kyberPub.serialize()),
      signature: enc(kyberSig),
    },
    oneTimePreKeys: [{ keyId: otpkId, publicKey: enc(otpkPub.serialize()) }],
  });
  return { deviceId, identity, registrationId, stores };
}

// ---------------------------------------------------------------- run

const alice = await seedUser("alice_test");
const bob = await seedUser("bob_test");
console.log("· seeded two users");

const aDev = await provisionDevice(alice, "alice-laptop");
const bDev = await provisionDevice(bob, "bob-phone");
console.log("· provisioned two devices with real libsignal keys");

// Alice fetches Bob's public bundle and builds a session (PQXDH).
const { bundles } = await api(alice, "GET", `/api/keys/${bob.handle}`);
assert.equal(bundles.length, 1, "expected exactly one bundle for bob");
const nb = bundles[0];
assert.ok(nb.preKey, "server should have handed out a one-time prekey");

const bobAddr = si.ProtocolAddress.new(bob.handle, 1);
const aliceAddr = si.ProtocolAddress.new(alice.handle, 1);
assert.ok(nb.kyberPreKey, "bundle must carry PQXDH Kyber material");
const bundle = si.PreKeyBundle.new(
  nb.registrationId, 1,
  nb.preKey.keyId, si.PublicKey.deserialize(dec(nb.preKey.publicKey)),
  nb.signedPreKey.keyId, si.PublicKey.deserialize(dec(nb.signedPreKey.publicKey)),
  dec(nb.signedPreKey.signature),
  si.PublicKey.deserialize(dec(nb.identityKey)),
  nb.kyberPreKey.keyId, si.KEMPublicKey.deserialize(dec(nb.kyberPreKey.publicKey)),
  dec(nb.kyberPreKey.signature)
);
await si.processPreKeyBundle(bundle, bobAddr, aliceAddr, aDev.stores, aDev.stores);
console.log("· X3DH handshake completed against server-supplied bundle");

// The one-time prekey must now be spent — that is what makes it one-time.
const second = await api(alice, "GET", `/api/keys/${bob.handle}`);
assert.equal(second.bundles[0].preKey, null, "one-time prekey was handed out twice");
console.log("· one-time prekey correctly consumed (not reissued)");

// Encrypt and relay.
const PLAINTEXT = "the vault is sealed; burn after reading";
const ct = await si.signalEncrypt(Buffer.from(PLAINTEXT, "utf8"), bobAddr, aliceAddr, aDev.stores, aDev.stores);
const ch = await api(alice, "POST", "/api/channels", { slug: "test-" + crypto.randomBytes(3).toString("hex") });
await api(alice, "POST", `/api/channels/${ch.id}/envelopes`, {
  senderDeviceId: aDev.deviceId,
  envelopes: [{ targetDeviceId: bDev.deviceId, type: ct.type(), body: enc(ct.serialize()) }],
});
console.log("· ciphertext relayed through the API");

// The server must be holding something it cannot read.
const stored = await q("SELECT body FROM envelopes WHERE target_device_id=$1", [bDev.deviceId]);
assert.equal(stored.rowCount, 1);
assert.ok(!stored.rows[0].body.includes(Buffer.from(PLAINTEXT)),
  "FAIL: plaintext found in the database");
console.log("· stored envelope contains no plaintext");

// Bob pulls and decrypts.
const { envelopes } = await api(bob, "GET", `/api/devices/${bDev.deviceId}/envelopes`);
assert.equal(envelopes.length, 1, "bob should have exactly one envelope");
const incoming = si.PreKeySignalMessage.deserialize(dec(envelopes[0].body));
const pt = await si.signalDecryptPreKey(
  incoming, aliceAddr, bobAddr,
  bDev.stores, bDev.stores, bDev.stores, bDev.stores, bDev.stores
);
assert.equal(Buffer.from(pt).toString("utf8"), PLAINTEXT, "decrypted text did not match");
console.log("· bob decrypted:", JSON.stringify(Buffer.from(pt).toString("utf8")));

// Ack, and confirm it isn't redelivered.
await api(bob, "POST", `/api/devices/${bDev.deviceId}/ack`, { ids: [envelopes[0].id] });
const after = await api(bob, "GET", `/api/devices/${bDev.deviceId}/envelopes`);
assert.equal(after.envelopes.length, 0, "acked envelope was redelivered");
console.log("· ack honoured; no redelivery");

// Until Bob replies, Alice must keep sending PreKey messages — she has no
// proof he has processed the handshake yet. This is correct protocol
// behaviour, not a bug, so assert it explicitly.
const ct2 = await si.signalEncrypt(Buffer.from("second", "utf8"), bobAddr, aliceAddr, aDev.stores, aDev.stores);
assert.equal(ct2.type(), si.CiphertextMessageType.PreKey,
  "pre-reply messages should still be PreKey type");
console.log("· pre-reply message correctly still PreKey type");

// Bob replies; that reply is a ratcheted Whisper message.
const REPLY = "received. burning now.";
const rct = await si.signalEncrypt(Buffer.from(REPLY, "utf8"), aliceAddr, bobAddr, bDev.stores, bDev.stores);
assert.equal(rct.type(), si.CiphertextMessageType.Whisper, "bob's reply should be Whisper");
const rpt = await si.signalDecrypt(
  si.SignalMessage.deserialize(rct.serialize()), bobAddr, aliceAddr, aDev.stores, aDev.stores);
assert.equal(Buffer.from(rpt).toString("utf8"), REPLY, "alice failed to decrypt the reply");
console.log("· bidirectional round-trip ok, alice decrypted:", JSON.stringify(REPLY));

// Now that the ratchet has turned, Alice's next message is a Whisper too.
const ct3 = await si.signalEncrypt(Buffer.from("third", "utf8"), bobAddr, aliceAddr, aDev.stores, aDev.stores);
assert.equal(ct3.type(), si.CiphertextMessageType.Whisper, "ratchet should have advanced");
console.log("· ratchet advanced to Whisper after reply");

await q("DELETE FROM users WHERE handle = ANY($1)", [["alice_test", "bob_test"]]);
await pool.end();
console.log("\nALL E2EE ASSERTIONS PASSED");
