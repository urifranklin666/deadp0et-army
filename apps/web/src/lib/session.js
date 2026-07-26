import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { MlsClient, SUITE, b64, unb64 } from "@deadp0et/crypto/mls";
import { api } from "./api.js";
import { store, K } from "./db.js";

export { SUITE };

/* --------------------------------------------------------------- identity */

export async function register(handle) {
  const { userId, options } = await api.post("/api/auth/register/start", { handle });
  const attResp = await startRegistration({ optionsJSON: options });
  return api.post("/api/auth/register/finish", { userId, response: attResp });
}

export async function login(handle) {
  const { options } = await api.post("/api/auth/login/start", { handle });
  const assertion = await startAuthentication({ optionsJSON: options });
  return api.post("/api/auth/login/finish", { response: assertion, challenge: options.challenge });
}

/**
 * Ensure this browser has a registered device and a published KeyPackage.
 *
 * The KeyPackage private half lives only here, so it is generated once and
 * persisted; regenerating on every load would orphan any Welcome already
 * addressed to the previous one.
 */
export async function ensureDevice(handle) {
  let saved = await store.get(K.keyPackage(handle));
  let client;

  if (saved) {
    client = await MlsClient.restore(handle, { keyPackage: saved });
  } else {
    client = await MlsClient.create(handle);
    await client.newKeyPackage();
    saved = client.exportKeyPackage();
    await store.set(K.keyPackage(handle), saved);
  }

  // The MLS credential identity doubles as the device's stable fingerprint,
  // so a reload maps back to the same device row instead of creating another.
  const { deviceId } = await api.registerDevice("web", saved.public.slice(0, 512));
  await store.set(K.device(handle), deviceId);

  // Publish (idempotent server-side: duplicate refs are ignored).
  const kp = client.exportKeyPackage();
  const ref = b64(await sha256(unb64(kp.public)));
  await api.publishKeyPackages(deviceId, SUITE, [{ ref, keyPackage: kp.public }]).catch(() => {});

  return { deviceId, keyPackage: saved };
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/* ------------------------------------------------------------ group session */

/**
 * One MLS group, kept in sync with the server log.
 *
 * Decrypted plaintext is cached locally because MLS application messages can
 * only be decrypted ONCE — applying a message advances the ratchet, so a
 * second pass over the same log entry cannot recover it. Losing the local
 * cache therefore loses readable history even though the ciphertext is still
 * on the server. The cursor and the cache must advance together.
 */
export class GroupSession {
  constructor(handle, deviceId, channel) {
    this.handle = handle;
    this.deviceId = deviceId;
    this.channel = channel;
    this.groupId = null;
    this.client = null;
    this.cursor = 0;
    this.history = [];
  }

  get epoch() { return this.client ? this.client.epoch : null; }

  async #persist() {
    const state = this.client.exportState();
    if (state) await store.set(K.groupState(this.handle, this.groupId), state);
    await store.set(K.cursor(this.handle, this.groupId), this.cursor);
    await store.set(K.history(this.handle, this.groupId), this.history);
  }

  /** Restore from local storage, or create the group if we are its founder. */
  async open(groupIdB64) {
    const kp = await store.get(K.keyPackage(this.handle));

    if (groupIdB64) {
      this.groupId = groupIdB64;
      const state = await store.get(K.groupState(this.handle, groupIdB64));
      if (!state) return false;              // known group, but not joined on this device
      this.client = await MlsClient.restore(this.handle, { keyPackage: kp, state });
      this.cursor = (await store.get(K.cursor(this.handle, groupIdB64))) || 0;
      this.history = (await store.get(K.history(this.handle, groupIdB64))) || [];
      return true;
    }

    // Founding a new group.
    const raw = crypto.getRandomValues(new Uint8Array(16));
    this.groupId = b64(raw);
    this.client = await MlsClient.restore(this.handle, { keyPackage: kp });
    await this.client.createGroup(raw);
    await api.createGroup(this.channel.id, this.groupId, SUITE);
    await this.#persist();
    return true;
  }

  /** Accept a pending Welcome for this device, if one exists. */
  async tryJoin() {
    const { welcomes } = await api.welcomes(this.deviceId);
    const mine = welcomes.find((w) => w.groupId === this.groupId);
    if (!mine) return false;

    const kp = await store.get(K.keyPackage(this.handle));
    this.client = await MlsClient.restore(this.handle, { keyPackage: kp });
    await this.client.joinFromWelcome(unb64(mine.welcome));
    // Start reading after the commit that added us; earlier traffic is not
    // decryptable with the keys we were given, by design.
    this.cursor = mine.joinedAtSeq || 0;
    this.history = [];
    await api.ackWelcomes(this.deviceId, [mine.id]);
    await this.#persist();
    return true;
  }

  /** Pull new log entries and apply them in order. */
  async sync() {
    if (!this.client) return { applied: 0 };
    const { messages } = await api.messages(this.groupId, this.cursor);
    let applied = 0;
    for (const m of messages) {
      try {
        const text = await this.client.apply(unb64(m.payload));
        if (text !== null) {
          this.history.push({
            seq: m.seq, text, at: m.createdAt,
            mine: m.senderDeviceId === this.deviceId,
          });
        }
        applied++;
      } catch (e) {
        // A message we cannot apply must not block the cursor forever, but it
        // also must not be silently dropped — surface it in the transcript.
        this.history.push({ seq: m.seq, error: String(e.message), at: m.createdAt });
      }
      this.cursor = m.seq;
    }
    if (messages.length) await this.#persist();
    return { applied };
  }

  async send(text) {
    const ct = await this.client.encrypt(text);
    const { seq } = await api.postMessage(this.groupId, {
      kind: "application", senderDeviceId: this.deviceId, payload: b64(ct),
    });
    // Our own message is never echoed back through apply() — the sender's
    // ratchet has already moved past it — so record it directly.
    this.history.push({ seq, text, at: new Date().toISOString(), mine: true });
    this.cursor = Math.max(this.cursor, seq);
    await this.#persist();
    return seq;
  }

  /** Add another user by handle: claim their KeyPackage, commit, send Welcome. */
  async invite(handle) {
    const { keyPackages } = await api.claimKeyPackages(handle, SUITE);
    const add = await this.client.addMembers(keyPackages.map((k) => unb64(k.keyPackage)));
    await api.postMessage(this.groupId, {
      kind: "commit",
      epoch: add.builtAtEpoch,
      senderDeviceId: this.deviceId,
      payload: b64(add.commit),
      welcomes: keyPackages.map((k) => ({
        ref: k.ref, deviceId: k.deviceId, welcome: b64(add.welcome),
      })),
    });
    await this.#persist();
    return keyPackages.length;
  }
}
