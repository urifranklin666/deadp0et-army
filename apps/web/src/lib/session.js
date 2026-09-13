import * as Y from "yjs";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { MlsClient, SUITE, b64, unb64 } from "@deadp0et/crypto/mls";
import { api } from "./api.js";
import { store, K } from "./db.js";
import { T, decodeEnvelope, encodeEnvelope } from "./envelope.js";

export { SUITE };

// Republish the whole board every N canvas messages. Low enough that a device
// which falls behind has a recent self-contained state to start from, high
// enough that snapshots are a small fraction of the log.
const SNAPSHOT_EVERY = 25;

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
    this.syncStatus = "idle";
    this.lastSyncedAt = null;
    this.lastSyncError = null;

    // Shared canvas state. Yjs is a CRDT, so updates are commutative and
    // idempotent — out-of-order or duplicated delivery converges anyway,
    // which pairs well with a log we replay from a cursor.
    this.doc = new Y.Doc();
    this.strokes = this.doc.getArray("strokes");
    this.onCanvasChange = null;
    this.#wireDoc();
  }

  get epoch() { return this.client ? this.client.epoch : null; }
  get mlsMembers() { return this.client?.members() || []; }

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

  async flushCanvas() {
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
      try { await this.sendCanvasSnapshot(); } catch { /* retried next flush */ }
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
    this.cursor = Math.max(this.cursor, seq);
    return seq;
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
      await this.#restoreDoc();
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
  async sync() {
    if (!this.client) return { applied: 0 };
    this.syncStatus = "syncing";
    this.lastSyncError = null;
    let res;
    try { res = await api.messages(this.groupId, this.cursor); }
    catch (e) { this.syncStatus = "error"; this.lastSyncError = e.message; throw e; }
    const { messages } = res;
    if (res.gap) {
      await this.#recoverFromGap(Number(res.watermark || 0));
      this.onCanvasChange?.();
      this.syncStatus = "recovered";
      this.lastSyncedAt = new Date();
      return { applied: 0, recovered: true };
    }
    let applied = 0;
    for (const m of messages) {
      try {
        const text = await this.client.apply(unb64(m.payload));
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
            this.history.push({
              seq: m.seq, text: env.b, at: m.createdAt,
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
      await this.#persist();
      // Tell the server how far we've applied. This is the sole input to
      // compaction — without it the log can never be pruned, because the
      // server has no other way to know a message is safely delivered.
      api.reportCursor(this.groupId, this.deviceId, this.cursor).catch(() => {});
    }
    this.syncStatus = "synced";
    this.lastSyncedAt = new Date();
    return { applied };
  }

  async send(text) {
    const seq = await this.#sendEnvelope({ t: T.CHAT, b: text });
    // Our own message is never echoed back through apply() — the sender's
    // ratchet has already moved past it — so record it directly.
    this.history.push({ seq, text, at: new Date().toISOString(), mine: true });
    await this.#persist();
    return seq;
  }

  /** Hand a late joiner the whole board in one message. */
  async sendCanvasSnapshot() {
    if (!this.client) return;
    this.updatesSinceSnapshot = 0;
    const seq = await this.#sendEnvelope({ t: T.Y_SNAPSHOT, u: b64(Y.encodeStateAsUpdate(this.doc)) });
    this.lastSnapshotSeq = seq;
    return seq;
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
  async invite(handle) {
    const { keyPackages } = await api.claimKeyPackages(handle, SUITE, this.groupId);
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
    // Everything before the commit is undecryptable to the new member, so the
    // canvas would be blank for them. Re-publish the board at the new epoch.
    await this.sendCanvasSnapshot();
    await this.#persist();
    return keyPackages.length;
  }

  async members() { return api.groupMembers(this.groupId); }

  /** MLS remove commit first; server membership is revoked atomically with it. */
  async removeMember(handle) {
    const removal = await this.client.removeMember(handle);
    await api.postMessage(this.groupId, {
      kind: "commit", epoch: removal.builtAtEpoch, senderDeviceId: this.deviceId,
      payload: b64(removal.commit), removeHandle: handle,
    });
    await this.#persist();
    return removal.removedLeaves;
  }
}
