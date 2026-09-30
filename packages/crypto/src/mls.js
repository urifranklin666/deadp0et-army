/**
 * Isomorphic MLS client.
 *
 * Runs unchanged in Node and the browser: no Node built-ins, no Buffer, and
 * no WebCrypto signature algorithm (see SUITE below). The server never sees
 * anything this module treats as secret — it only ever receives the byte
 * strings returned by the wire() helpers.
 */
// ts-mls resolves its crypto backends with dynamic import(). Pull them in
// eagerly so the dependency is explicit rather than discovered at runtime, and
// so a bundler cannot strand them behind a lazy chunk.
//
// IMPORTANT for any consumer: do NOT use top-level await in the module that
// bootstraps this client. TLA in an entry chunk deadlocks Rollup/Vite's
// dynamic import() loading — the chunks are never even requested, and
// getCiphersuiteImpl hangs forever without throwing. Wrap startup in an async
// IIFE (or an exported async init) instead. Verified: with TLA every suite
// needing a dynamic import hangs; without it, all resolve in ~0.1s.
import "@hpke/ml-kem";
import "@noble/post-quantum/ml-dsa.js";

import {
  getCiphersuiteFromName, nobleCryptoProvider,
  generateKeyPackage, createGroup, createCommit, joinGroup,
  createApplicationMessage, processPrivateMessage,
  encodeMlsMessage, decodeMlsMessage,
  encodeGroupState, decodeGroupState, mlsExporter,
  defaultCapabilities, defaultLifetime, emptyPskIndex,
  defaultKeyRetentionConfig, defaultLifetimeConfig, defaultKeyPackageEqualityConfig,
  defaultPaddingConfig, defaultAuthenticationService,
} from "ts-mls";
// Not re-exported from the index, but a public subpath ("./*.js" in ts-mls's
// exports map). Needed to learn WHICH member sent an application message.
import { decryptSenderData } from "ts-mls/privateMessage.js";

/**
 * ClientState is GroupState & { clientConfig }, but encodeGroupState only
 * round-trips the GroupState half — restoring without re-attaching a config
 * fails later with "cannot read properties of undefined (reading
 * 'paddingConfig')". ts-mls does not re-export defaultClientConfig from its
 * index, so rebuild it from the five pieces that ARE public rather than
 * reaching into a deep subpath.
 */
const CLIENT_CONFIG = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: defaultAuthenticationService,
};

/**
 * Post-quantum end to end: ML-KEM1024 key exchange, ML-DSA87 signatures.
 *
 * ML-DSA comes from @noble/post-quantum in pure JS, so this suite touches no
 * WebCrypto signature algorithm. That matters: every *_Ed25519 suite needs
 * WebCrypto Ed25519, which only reached Chrome 137, and ts-mls's
 * nobleCryptoProvider does NOT avoid it — its signature impl prefers
 * crypto.subtle whenever it merely exists.
 */
/** MLSMessage is (protocol & content): omitting `version` yields bytes that
 * encode without complaint but decode back to undefined. */
const MLS_VERSION = "mls10";

export const SUITE = "MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87";

export const b64 = (u8) => {
  // Chunked to avoid blowing the argument limit on large ratchet trees.
  let s = "";
  const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  for (let i = 0; i < a.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

export const unb64 = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const utf8 = new TextEncoder();
const fromUtf8 = (u8) => new TextDecoder().decode(u8);

/**
 * The identity a KeyPackage's credential claims. Anyone can write any
 * identity into their own KeyPackage, so an inviter must check this against
 * the handle they meant to add — otherwise a member could join as someone
 * else, and every message they sent would be attributed to that someone.
 */
export function keyPackageIdentity(encoded) {
  const msg = decode(encoded);
  if (msg.wireformat !== "mls_key_package") throw new Error("not a key package");
  const cred = msg.keyPackage.leafNode.credential;
  return cred.credentialType === "basic" ? fromUtf8(cred.identity) : null;
}

/** Stable identifier for a KeyPackage, used to address its Welcome. */
export async function keyPackageRef(encoded) {
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

const decode = (bytes) => {
  const res = decodeMlsMessage(bytes, 0);
  if (!res) throw new Error("undecodable MLS message");
  return Array.isArray(res) ? res[0] : res;
};

export class MlsClient {
  #cs; #state; #kp; #presence;

  constructor(identity) { this.identity = identity; }

  static async create(identity) {
    const c = new MlsClient(identity);
    c.#cs = await nobleCryptoProvider.getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    return c;
  }

  get epoch() { return this.#state ? Number(this.#state.groupContext.epoch) : null; }
  get groupId() { return this.#state ? this.#state.groupContext.groupId : null; }

  /** Generate a KeyPackage and keep its private half locally. */
  async newKeyPackage() {
    const kp = await generateKeyPackage(
      { credentialType: "basic", identity: utf8.encode(this.identity) },
      defaultCapabilities(), defaultLifetime, [], this.#cs);
    this.#kp = kp;
    const encoded = encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_key_package", keyPackage: kp.publicPackage });
    return { encoded, ref: await keyPackageRef(encoded) };
  }

  /** Found a new group; this client becomes its first member. */
  async createGroup(groupId) {
    if (!this.#kp) throw new Error("call newKeyPackage() first");
    this.#state = await createGroup(groupId, this.#kp.publicPackage, this.#kp.privatePackage, [], this.#cs);
    return this.#state;
  }

  /**
   * Commit an add for each supplied KeyPackage.
   * Returns the wire bytes for the commit plus one Welcome per new member.
   * The caller is responsible for submitting these AT the epoch they were
   * built against — the server rejects a commit for a superseded epoch.
   */
  async addMembers(encodedKeyPackages) {
    const proposals = encodedKeyPackages.map((bytes) => {
      const msg = decode(bytes);
      if (msg.wireformat !== "mls_key_package") throw new Error("not a key package");
      return { proposalType: "add", add: { keyPackage: msg.keyPackage } };
    });
    const builtAtEpoch = this.epoch;
    const res = await createCommit(
      { state: this.#state, cipherSuite: this.#cs },
      { extraProposals: proposals, ratchetTreeExtension: true });
    this.#state = res.newState;
    return {
      builtAtEpoch,
      commit: encodeMlsMessage(res.commit),
      welcome: res.welcome ? encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_welcome", welcome: res.welcome }) : null,
    };
  }

  /** Join from a Welcome produced by someone else's add commit. */
  async joinFromWelcome(encodedWelcome) {
    if (!this.#kp) throw new Error("call newKeyPackage() first");
    const msg = decode(encodedWelcome);
    if (msg.wireformat !== "mls_welcome") throw new Error("not a welcome");
    this.#state = await joinGroup(
      msg.welcome, this.#kp.publicPackage, this.#kp.privatePackage, emptyPskIndex, this.#cs);
    return this.#state;
  }

  /** Encrypt once for the whole group. */
  async encrypt(text) {
    const res = await createApplicationMessage(this.#state, utf8.encode(text), this.#cs);
    this.#state = res.newState;
    return encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_private_message", privateMessage: res.privateMessage });
  }

  /**
   * Apply one log entry. Returns the plaintext for application messages, or
   * null for commits/proposals (which only advance state). Entries must be
   * applied in server `seq` order.
   */
  async apply(encoded) {
    return (await this.applyWithSender(encoded)).text;
  }

  /**
   * apply(), plus the identity of the member who sent it.
   *
   * `sender` is the credential identity of the sending leaf. It is
   * authenticated, not merely claimed: processing verifies the content's
   * signature against that leaf's key, and would throw otherwise. It is null
   * for commits/proposals and when the sender can't be resolved.
   */
  async applyWithSender(encoded) {
    const msg = decode(encoded);
    if (msg.wireformat !== "mls_private_message") return { text: null, sender: null };
    const sender = await this.#senderOf(msg.privateMessage).catch(() => null);
    const res = await processPrivateMessage(this.#state, msg.privateMessage, emptyPskIndex, this.#cs);
    this.#state = res.newState;
    return res.kind === "applicationMessage"
      ? { text: fromUtf8(res.message), sender }
      : { text: null, sender: null };
  }

  /** Resolve a private message's sending leaf to its credential identity. */
  async #senderOf(pm) {
    const s = this.#state;
    // Messages from the current epoch use its secrets; a straggler from an
    // earlier one uses whatever ts-mls kept for that epoch.
    const data = BigInt(pm.epoch) === BigInt(s.groupContext.epoch)
      ? { senderDataSecret: s.keySchedule.senderDataSecret, ratchetTree: s.ratchetTree }
      : s.historicalReceiverData?.get(pm.epoch);
    if (!data) return null;
    const sd = await decryptSenderData(pm, data.senderDataSecret, this.#cs);
    const node = sd && data.ratchetTree[sd.leafIndex * 2];   // leaf i lives at node 2i
    if (node?.nodeType !== "leaf") return null;
    const cred = node.leaf.credential;
    return cred.credentialType === "basic" ? fromUtf8(cred.identity) : null;
  }

  // -------------------------------------------------------------- presence
  //
  // Ephemeral traffic (cursors) must NOT go through application messages:
  // each one advances the sender's ratchet, and at pointer-event rates that
  // would blow past the receivers' skipped-key window, grow the ordered log
  // without bound, and persist throwaway data forever.
  //
  // Instead derive a symmetric key with the MLS exporter (RFC 9420 §8.5).
  // Every member at the same epoch derives the SAME key from the group
  // secret, and a new epoch derives a new one — so presence inherits the
  // group's forward secrecy while costing the ratchet nothing.

  /** AES-GCM key shared by all members of the current epoch. */
  async presenceKey() {
    if (!this.#state) throw new Error("no group");
    const epoch = this.epoch;
    if (this.#presence?.epoch === epoch) return this.#presence.key;

    const raw = await mlsExporter(
      this.#state.keySchedule.exporterSecret,
      "deadp0et presence",
      new Uint8Array(0),
      32,
      this.#cs
    );
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    this.#presence = { epoch, key };
    return key;
  }

  /** Encrypt an ephemeral packet. Returns nonce||ciphertext. */
  async sealPresence(obj) {
    const key = await this.presenceKey();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, pt));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0);
    out.set(ct, nonce.length);
    return out;
  }

  /** Decrypt an ephemeral packet; null if it isn't for our epoch. */
  async openPresence(bytes) {
    try {
      const key = await this.presenceKey();
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf.subarray(0, 12) }, key, buf.subarray(12));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch {
      // A peer one epoch ahead/behind simply won't decrypt. Not an error.
      return null;
    }
  }

  // ------------------------------------------------------------ persistence
  //
  // This is what has to survive a page reload. Without it a refresh loses
  // group membership outright: the ratchet state is gone and the server
  // cannot help, because it never had the keys.

  /** Serialize group state. Null before a group is created or joined. */
  exportState() {
    return this.#state ? encodeGroupState(this.#state) : null;
  }

  /**
   * Serialize this device's key package. PrivateKeyPackage is three raw
   * Uint8Arrays, so no ts-mls encoder is needed — there isn't one.
   */
  exportKeyPackage() {
    if (!this.#kp) return null;
    return {
      public: b64(encodeMlsMessage({
        version: MLS_VERSION, wireformat: "mls_key_package", keyPackage: this.#kp.publicPackage,
      })),
      init: b64(this.#kp.privatePackage.initPrivateKey),
      hpke: b64(this.#kp.privatePackage.hpkePrivateKey),
      sig: b64(this.#kp.privatePackage.signaturePrivateKey),
    };
  }

  /** Rehydrate from exportKeyPackage() / exportState() output. */
  static async restore(identity, { keyPackage, state } = {}) {
    const c = await MlsClient.create(identity);
    if (keyPackage) {
      const msg = decode(unb64(keyPackage.public));
      if (msg.wireformat !== "mls_key_package") throw new Error("not a key package");
      c.#kp = {
        publicPackage: msg.keyPackage,
        privatePackage: {
          initPrivateKey: unb64(keyPackage.init),
          hpkePrivateKey: unb64(keyPackage.hpke),
          signaturePrivateKey: unb64(keyPackage.sig),
        },
      };
    }
    if (state) {
      const dec = decodeGroupState(state, 0);
      const gs = Array.isArray(dec) ? dec[0] : dec;
      if (!gs) throw new Error("corrupt group state");
      c.#state = { ...gs, clientConfig: CLIENT_CONFIG };
    }
    return c;
  }
}
