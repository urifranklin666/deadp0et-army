import * as Y from "yjs";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { MlsClient, SUITE, b64, unb64, keyPackageIdentity } from "@deadp0et/crypto/mls";
import { api } from "./api.js";
import { store, K } from "./db.js";
import { T, decodeEnvelope, encodeEnvelope } from "./envelope.js";

export { SUITE };

// Republish the whole board every N canvas messages. Low enough that a device
// which falls behind has a recent self-contained state to start from, high
// enough that snapshots are a small fraction of the log.
const SNAPSHOT_EVERY = 25;

// KeyPackages are single-use: each invite claims one from the server. Keep a
// small pool published so this device can be added to more than one group,
// and refill it whenever it runs low.
const KP_LOW_WATER = 3;
const KP_TARGET = 8;

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
 * Ensure this browser has a registered device and published KeyPackages.
 *
 * The primary KeyPackage is the device's stable identity (its public half
 * fingerprints the device row), so it is generated once and persisted.
 * Invitable KeyPackages come from a separate pool (see topUpKeyPackages):
 * their private halves are also kept only here, because regenerating them
 * would orphan any Welcome already addressed to one.
 */
export async function ensureDevice(handle) {
  let saved = await store.get(K.keyPackage(handle));

  if (!saved) {
    const client = await MlsClient.create(handle);
    await client.newKeyPackage();
    saved = client.exportKeyPackage();
    await store.set(K.keyPackage(handle), saved);
  }

  // The MLS credential identity doubles as the device's stable fingerprint,
  // so a reload maps back to the same device row instead of creating another.
  const { deviceId } = await api.registerDevice("web", saved.public.slice(0, 512));
  await store.set(K.device(handle), deviceId);

  await topUpKeyPackages(handle, deviceId).catch(() => {});
  return { deviceId, keyPackage: saved };
}

/**
 * Serialise every read-modify-write of the KeyPackage pool. It is shared by
 * all of a handle's group sessions, and a lost write here is not harmless: it
 * drops private halves whose public halves are already on the server, so a
 * later Welcome addressed to one could never be opened.
 */
const poolLocks = new Map();
function withPool(handle, fn) {
  const prev = poolLocks.get(handle) || Promise.resolve();
  const run = prev.then(fn, fn);
  poolLocks.set(handle, run.catch(() => {}));
  return run;
}

/**
 * Keep enough unclaimed KeyPackages on the server for this device to be
 * invited, and forget packages that were claimed but never welcomed.
 *
 * The primary package is never (re)published here: it is the device's
 * identity, and re-sending it would resurrect it as claimable once the
 * server's retention sweep had deleted its claimed row.
 */
export function topUpKeyPackages(handle, deviceId) {
  return withPool(handle, async () => {
    const { available, stale } = await api.keyPackageStatus(deviceId);
    const pool = (await store.get(K.keyPackagePool(handle))) || {};

    let changed = false;
    for (const ref of stale || []) {
      if (pool[ref]) { delete pool[ref]; changed = true; }
    }
    if (available >= KP_LOW_WATER) {
      if (changed) await store.set(K.keyPackagePool(handle), pool);
      return available;
    }

    const fresh = [];
    for (let i = available; i < KP_TARGET; i++) {
      const c = await MlsClient.create(handle);
      await c.newKeyPackage();
      const kp = c.exportKeyPackage();
      const ref = await kpRef(kp);
      pool[ref] = kp;
      fresh.push({ ref, keyPackage: kp.public });
    }
    // Private halves are stored BEFORE the public halves are published, so a
    // Welcome can never arrive for a package this device has already lost.
    await store.set(K.keyPackagePool(handle), pool);
    const res = await api.publishKeyPackages(deviceId, SUITE, fresh);
    return res.available;
  });
}

/** Take one package's private half out of the pool, once it has been used. */
function dropFromPool(handle, ref) {
  return withPool(handle, async () => {
    const pool = (await store.get(K.keyPackagePool(handle))) || {};
    if (!pool[ref]) return;
    delete pool[ref];
    await store.set(K.keyPackagePool(handle), pool);
  });
}

/** The ref the server files a KeyPackage under, and addresses Welcomes by. */
async function kpRef(exported) {
  return b64(await sha256(unb64(exported.public)));
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

    // Shared canvas state. Yjs is a CRDT, so updates are commutative and
    // idempotent — out-of-order or duplicated delivery converges anyway,
    // which pairs well with a log we replay from a cursor.
    this.doc = new Y.Doc();
    this.strokes = this.doc.getArray("strokes");
    this.onCanvasChange = null;
    this.#wireDoc();
  }

  /**
   * Serialise everything that touches MLS state.
   *
   * encrypt() and apply() each read the ratchet, await, then write it back.
   * Interleaving them (a background sync landing mid-send) would let one
   * overwrite the other's advance — at worst re-deriving an already-used
   * key/nonce pair. So every public entry point runs one at a time.
   */
  #queue = Promise.resolve();
  #exclusive(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  get epoch() { return this.client ? this.client.epoch : null; }

  #wireDoc() {
    this.doc.on("update", (update, origin) => {
      // "remote" and "restore" origins came FROM the log or disk; echoing them
      // back would loop. Only locally-authored edits get published.
      if (origin === "remote" || origin === "restore") {
        this.onCanvasChange?.();
        return;
      }
      this.#queueCanvasUpdate(update);
      this.onCanvasChange?.();
    });
  }

  /**
   * Coalesce rapid local edits into one message.
   *
   * A freehand stroke fires an update per pointer sample; publishing each
   * would mean one MLS encryption and one HTTP round trip per few pixels.
   */
  #queueCanvasUpdate(update) {
    this.pendingUpdates ??= [];
    this.pendingUpdates.push(update);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushCanvas().catch(() => {}), 220);
  }

  flushCanvas() { return this.#exclusive(() => this.#flushCanvas()); }

  async #flushCanvas() {
    if (!this.client || !this.pendingUpdates?.length) return;
    const merged = Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];
    await this.#sendEnvelope({ t: T.Y_UPDATE, u: b64(merged) });

    // Periodically republish the whole board. Compaction can only prune what
    // every device has applied, so without a recent snapshot a device that
    // falls behind would have to replay the entire stroke history to catch
    // up. A snapshot makes the tail self-contained.
    this.updatesSinceSnapshot = (this.updatesSinceSnapshot || 0) + 1;
    if (this.updatesSinceSnapshot >= SNAPSHOT_EVERY) {
      try { await this.#sendCanvasSnapshot(); } catch { /* retried next flush */ }
    }
    await this.#persist();
  }

  async #persist() {
    const state = this.client.exportState();
    if (state) await store.set(K.groupState(this.handle, this.groupId), state);
    await store.set(K.cursor(this.handle, this.groupId), this.cursor);
    await store.set(K.history(this.handle, this.groupId), this.history);
    await store.set(K.ydoc(this.handle, this.groupId), Y.encodeStateAsUpdate(this.doc));
  }

  async #restoreDoc() {
    const saved = await store.get(K.ydoc(this.handle, this.groupId));
    if (saved) Y.applyUpdate(this.doc, new Uint8Array(saved), "restore");
  }

  async #sendEnvelope(obj) {
    const ct = await this.client.encrypt(encodeEnvelope(obj));
    const { seq } = await api.postMessage(this.groupId, {
      kind: "application", senderDeviceId: this.deviceId, payload: b64(ct),
    });
    // Deliberately NOT advancing the cursor to `seq`: other members may have
    // posted between our last sync and this send, and jumping past them would
    // skip messages that can never be fetched again. sync() steps over our
    // own entries instead.
    return seq;
  }

  /** Restore from local storage, or create the group if we are its founder. */
  open(groupIdB64) { return this.#exclusive(() => this.#open(groupIdB64)); }

  async #open(groupIdB64) {
    const kp = await store.get(K.keyPackage(this.handle));

    if (groupIdB64) {
      this.groupId = groupIdB64;
      const state = await store.get(K.groupState(this.handle, groupIdB64));
      if (!state) return false;              // known group, but not joined on this device
      this.client = await MlsClient.restore(this.handle, { keyPackage: kp, state });
      this.cursor = (await store.get(K.cursor(this.handle, groupIdB64))) || 0;
      this.history = (await store.get(K.history(this.handle, groupIdB64))) || [];
      await this.#restoreDoc();
      return true;
    }

    // Founding a new group, from a fresh KeyPackage that is never published.
    // Building the founder's leaf from the primary package would put the same
    // leaf keys in this group and in whichever group later claims it —
    // exactly the reuse single-use KeyPackages exist to prevent. The group
    // state keeps the leaf's private keys, so this package needs no storage.
    const raw = crypto.getRandomValues(new Uint8Array(16));
    this.groupId = b64(raw);
    this.client = await MlsClient.create(this.handle);
    await this.client.newKeyPackage();
    await this.client.createGroup(raw);
    await api.createGroup(this.channel.id, this.groupId, SUITE);
    await this.#persist();
    return true;
  }

  /** Accept a pending Welcome for this device, if one exists. */
  tryJoin() { return this.#exclusive(() => this.#tryJoin()); }

  async #tryJoin() {
    const { welcomes } = await api.welcomes(this.deviceId);
    const mine = welcomes.find((w) => w.groupId === this.groupId);
    if (!mine) return false;

    // The Welcome is addressed to one specific KeyPackage; only its private
    // half can open it. Older devices only ever had the primary package.
    const pool = (await store.get(K.keyPackagePool(this.handle))) || {};
    const kp = pool[mine.ref] || (await store.get(K.keyPackage(this.handle)));
    this.client = await MlsClient.restore(this.handle, { keyPackage: kp });
    await this.client.joinFromWelcome(unb64(mine.welcome));
    // Start reading after the commit that added us; earlier traffic is not
    // decryptable with the keys we were given, by design.
    this.cursor = mine.joinedAtSeq || 0;
    this.history = [];
    await api.ackWelcomes(this.deviceId, [mine.id]);
    await this.#persist();
    // The group state now holds everything the join needed; the package's
    // init key has done its job, and keeping it would only weaken forward
    // secrecy. Then replace what the inviter claimed.
    await dropFromPool(this.handle, mine.ref);
    topUpKeyPackages(this.handle, this.deviceId).catch(() => {});
    // The canvas so far is unreadable to us — we lacked the keys. An existing
    // member sends a snapshot after inviting; until it lands the board is blank.
    return true;
  }

  /**
   * Rebuild after the server reports a gap.
   *
   * A gap means messages were compacted away before this device applied them.
   * They are gone for good — MLS decrypts once — so the only honest move is
   * to drop local canvas state, jump the cursor past the hole, and ask the
   * group to republish the board. Chat history before the gap is simply lost;
   * pretending otherwise would leave a silent hole in the transcript.
   */
  async #recoverFromGap(watermark) {
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.strokes = this.doc.getArray("strokes");
    this.#wireDoc();
    this.cursor = Math.max(this.cursor, watermark);
    this.history.push({
      seq: watermark, at: new Date().toISOString(),
      notice: "Older messages were compacted before this device caught up. Requesting a fresh board.",
    });
    await this.#persist();
    await this.#sendEnvelope({ t: T.Y_REQUEST });
  }

  /** Pull new log entries and apply them in order. */
  sync() { return this.#exclusive(() => this.#sync()); }

  async #sync() {
    if (!this.client) return { applied: 0 };
    const res = await api.messages(this.groupId, this.cursor);
    const { messages } = res;
    if (res.gap) {
      await this.#recoverFromGap(Number(res.watermark || 0));
      this.onCanvasChange?.();
      return { applied: 0, recovered: true };
    }
    let applied = 0;
    for (const m of messages) {
      if (m.senderDeviceId === this.deviceId) {
        // Our own entry. Its effect is already in local state — encrypt()
        // and addMembers() advance the ratchet as they build — and MLS gives
        // a sender no way to decrypt what it sent. Just step past it.
        this.cursor = m.seq;
        continue;
      }
      try {
        const { text, sender } = await this.client.applyWithSender(unb64(m.payload));
        if (text !== null) {
          const env = decodeEnvelope(text);
          if (env.t === T.Y_UPDATE || env.t === T.Y_SNAPSHOT) {
            // "remote" origin stops the doc observer republishing this.
            Y.applyUpdate(this.doc, unb64(env.u), "remote");
            if (env.t === T.Y_SNAPSHOT) this.lastSnapshotSeq = m.seq;
          } else if (env.t === T.Y_REQUEST) {
            // Someone lost state to compaction. Answer with the board, but
            // stagger so a large group doesn't publish N identical snapshots.
            if (m.senderDeviceId !== this.deviceId) this.#answerSnapshotRequest();
          } else {
            // `from` comes from the MLS credential of the signing leaf, not
            // from anything the server says about who posted it.
            this.history.push({
              seq: m.seq, text: env.b, at: m.createdAt, from: sender,
              mine: m.senderDeviceId === this.deviceId,
            });
          }
        }
        applied++;
      } catch (e) {
        // A message we cannot apply must not block the cursor forever, but it
        // also must not be silently dropped — surface it in the transcript.
        this.history.push({ seq: m.seq, error: String(e.message), at: m.createdAt });
      }
      this.cursor = m.seq;
    }
    if (messages.length) {
      // Our own sends are recorded the moment they post, but may carry a
      // higher seq than peers' messages this sync just fetched. Keep the
      // transcript in log order (Array#sort is stable, so equal seqs keep
      // their arrival order).
      this.history.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      await this.#persist();
      // Tell the server how far we've applied. This is the sole input to
      // compaction — without it the log can never be pruned, because the
      // server has no other way to know a message is safely delivered.
      api.reportCursor(this.groupId, this.deviceId, this.cursor).catch(() => {});
    }
    return { applied };
  }

  send(text) { return this.#exclusive(() => this.#send(text)); }

  async #send(text) {
    const seq = await this.#sendEnvelope({ t: T.CHAT, b: text });
    // Our own message is never echoed back through apply() — the sender's
    // ratchet has already moved past it — so record it directly.
    this.history.push({ seq, text, at: new Date().toISOString(), mine: true });
    await this.#persist();
    return seq;
  }

  /** Hand a late joiner the whole board in one message. */
  sendCanvasSnapshot() { return this.#exclusive(() => this.#sendCanvasSnapshot()); }

  async #sendCanvasSnapshot() {
    if (!this.client) return;
    this.updatesSinceSnapshot = 0;
    const seq = await this.#sendEnvelope({ t: T.Y_SNAPSHOT, u: b64(Y.encodeStateAsUpdate(this.doc)) });
    this.lastSnapshotSeq = seq;
    return seq;
  }

  /**
   * Did the commit this device built at `epoch` make it into the log? At most
   * one commit exists per epoch, so whichever one is there answers it.
   * False if the whole log has no commit at that epoch; null if it could not
   * be read far enough to say.
   */
  async #ownCommitLanded(epoch) {
    let since = this.cursor;
    for (let page = 0; page < 20; page++) {
      const { messages } = await api.messages(this.groupId, since);
      const commit = messages.find((m) => m.kind === "commit" && m.epoch === epoch);
      if (commit) return commit.senderDeviceId === this.deviceId;
      if (!messages.length) return false;     // log fully read, no commit at that epoch
      since = messages[messages.length - 1].seq;
    }
    return null;
  }

  /** Sync until the server has nothing newer for us. */
  async #drain() {
    for (let i = 0; i < 50; i++) {
      const before = this.cursor;
      const res = await this.#sync();
      if (res.recovered || this.cursor === before) return;
    }
  }

  /**
   * Respond to a peer's gap. Randomised delay, and skipped if a snapshot
   * already landed while we waited — otherwise every member answers at once
   * and the log gains N copies of the board while trying to shrink.
   */
  #answerSnapshotRequest() {
    if (this.snapshotAnswerTimer) return;
    const seenBefore = this.lastSnapshotSeq || 0;
    this.snapshotAnswerTimer = setTimeout(async () => {
      this.snapshotAnswerTimer = null;
      if ((this.lastSnapshotSeq || 0) > seenBefore) return;   // someone beat us to it
      try { await this.sendCanvasSnapshot(); } catch { /* next request will retry */ }
    }, 400 + Math.floor(Math.random() * 1600));
  }

  /** Add another user by handle: claim their KeyPackage, commit, send Welcome. */
  invite(handle) { return this.#exclusive(() => this.#invite(handle)); }

  async #invite(handle) {
    // A commit must be built against the group's CURRENT epoch or the server
    // refuses it, so catch up on anyone else's commits first.
    await this.#drain();
    const { keyPackages } = await api.claimKeyPackages(handle, SUITE);
    // Whatever a KeyPackage's credential says is what every member will see
    // on that member's messages, and its owner chose it. Refuse any that
    // don't name the person we meant to invite.
    for (const k of keyPackages) {
      const who = keyPackageIdentity(unb64(k.keyPackage));
      if (who !== handle) {
        throw new Error(`a key package for ${handle} claims to be ${JSON.stringify(who)}; refusing to add it`);
      }
    }
    const before = this.client.exportState();
    const add = await this.client.addMembers(keyPackages.map((k) => unb64(k.keyPackage)));
    try {
      await api.postMessage(this.groupId, {
        kind: "commit",
        epoch: add.builtAtEpoch,
        senderDeviceId: this.deviceId,
        payload: b64(add.commit),
        welcomes: keyPackages.map((k) => ({
          ref: k.ref, deviceId: k.deviceId, welcome: b64(add.welcome),
        })),
      });
    } catch (e) {
      // addMembers() already moved us to the next epoch locally. If the
      // server did not take the commit, nobody else will ever follow us
      // there — roll back, or this device is forked off the group for good.
      // An error response proves a refusal (the append is one transaction).
      // With no response at all, ask the log whether it landed.
      const landed = e.status ? false : await this.#ownCommitLanded(add.builtAtEpoch).catch(() => null);
      if (landed === null) throw e;           // still can't tell; keep state, surface the error
      if (!landed) {
        const kp = await store.get(K.keyPackage(this.handle));
        this.client = await MlsClient.restore(this.handle, { keyPackage: kp, state: before });
        throw e;
      }
    }
    // Everything before the commit is undecryptable to the new member, so the
    // canvas would be blank for them. Re-publish the board at the new epoch.
    await this.#sendCanvasSnapshot();
    await this.#persist();
    return keyPackages.length;
  }
}
