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
  defaultCapabilities, defaultLifetime, emptyPskIndex,
} from "ts-mls";

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
  #cs; #state; #kp;

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
    const msg = decode(encoded);
    if (msg.wireformat !== "mls_private_message") return null;
    const res = await processPrivateMessage(this.#state, msg.privateMessage, emptyPskIndex, this.#cs);
    this.#state = res.newState;
    return res.kind === "applicationMessage" ? fromUtf8(res.message) : null;
  }
}
