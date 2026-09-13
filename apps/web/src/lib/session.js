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

// KeyPackages are single-use (RFC 9420 §10): every invitation consumes one.
// Keep a few published so a device can be invited into more than one room
// without a reload in between, and cap what we hold so packages that were
// claimed but never followed by a Welcome cannot pile up forever.
const POOL_TARGET = 5;
const POOL_MAX = 20;

const isMembershipLoss = (e) => e?.status === 404 || e?.status === 403;

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

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/* ------------------------------------------------------- key package pool */

/**
 * Local shape: `kp:<handle>` → { identity, packages: [{ public, init, hpke,
 * sig, ref }] }. `identity` is the device's stable fingerprint for the server's
 * device row; before the pool existed the one-and-only package doubled as it,
 * so a legacy record keeps that value and its package stays joinable (a
 * Welcome may already target it) but is never republished.
 */
async function loadPool(handle) {
  const saved = await store.get(K.keyPackage(handle));
  if (!saved) return { identity: null, packages: [] };
  if (saved.public) {
    const ref = b64(await sha256(unb64(saved.public)));
    return { identity: saved.public.slice(0, 512), packages: [{ ...saved, ref, legacy: true }] };
  }
  return saved;
}

/** Ensure this browser has a registered device and a stocked pool of KeyPackages. */
export async function ensureDevice(handle) {
  const pool = await loadPool(handle);
  if (!pool.identity) pool.identity = b64(crypto.getRandomValues(new Uint8Array(32)));
  const { deviceId } = await api.registerDevice("web", pool.identity);
  await store.setMany([[K.device(handle), deviceId], [K.keyPackage(handle), pool]]);
  await topUpKeyPackages(handle, deviceId);
  return { deviceId };
}

/**
 * Publish what we hold (idempotent server-side) to learn how many packages
 * are still unclaimed, then generate and publish enough to reach the target.
 */
export async function topUpKeyPackages(handle, deviceId) {
  const pool = await loadPool(handle);
  const publishable = pool.packages.filter((p) => !p.legacy);
  let available = 0;
  if (publishable.length) {
    ({ available } = await api.publishKeyPackages(deviceId, SUITE,
      publishable.map((p) => ({ ref: p.ref, keyPackage: p.public }))));
  }
  const need = POOL_TARGET - available;
  if (need <= 0) return;

  const client = await MlsClient.create(handle);
  const fresh = [];
  for (let i = 0; i < need; i++) {
    const { ref } = await client.newKeyPackage();
    fresh.push({ ...client.exportKeyPackage(), ref: b64(ref) });
  }
  pool.packages.push(...fresh);
  while (pool.packages.length > POOL_MAX) pool.packages.shift();
  // Private halves first: a package the server offers that we cannot join
  // with is worse than one we hold and never published.
  await store.set(K.keyPackage(handle), pool);
  await api.publishKeyPackages(deviceId, SUITE, fresh.map((p) => ({ ref: p.ref, keyPackage: p.public })));
}

/* ------------------------------------------------------------ group session */

/**
 * One MLS group, kept in sync with the server log.
 *
 * Decrypted plaintext is cached locally because MLS application messages can
 * only be decrypted ONCE — applying a message advances the ratchet, so a
 * second pass over the same log entry cannot recover it. Losing the local
 * cache therefore loses readable history even though the ciphertext is still
 * on the server. The cursor and the cache advance together, in one
 * IndexedDB transaction.
 *
 * Every operation that touches MLS state runs through one lock. Without it a
 * canvas flush encrypting under state S while a poll applies a commit from S
 * would let the flush overwrite the commit's result, and the device would be
 * stranded in an epoch the rest of the room had left.
 */
export class GroupSession {
  #chain = Promise.resolve();
  #inflight = null;

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
    this.revoked = false;    // the server no longer lists us as a member
    this.desynced = false;   // a commit we could not apply closed later epochs to us
    this.onCanvasChange = null;
    this.doc = null;
    this.#newDoc();
  }

  get epoch() { return this.client ? this.client.epoch : null; }
  get mlsMembers() { return this.client?.members() || []; }
  /** True when this device can read and write the room right now. */
  get usable() { return !!this.client && !this.revoked && !this.desynced; }

  /** Run fn after everything queued before it; errors do not poison the queue. */
  #serial(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  #notice(text) {
    return { key: `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, seq: this.cursor, at: new Date().toISOString(), notice: text };
  }

  // Shared canvas state. Yjs is a CRDT, so updates are commutative and
  // idempotent — out-of-order or duplicated delivery converges anyway,
  // which pairs well with a log we replay from a cursor.
  #newDoc() {
    this.doc?.destroy();
    this.doc = new Y.Doc();
    this.strokes = this.doc.getArray("strokes");
    this.pendingUpdates = [];
    this.doc.on("update", (update, origin) => {
      // "remote" and "restore" origins came FROM the log or disk; echoing them
      // back would loop. Only locally-authored edits get published.
      if (origin !== "remote" && origin !== "restore") this.#queueCanvasUpdate(update);
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
    this.pendingUpdates.push(update);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushCanvas().catch(() => {}), 220);
  }

  flushCanvas() {
    return this.#serial(async () => {
      if (!this.client || !this.pendingUpdates.length) return;
      const merged = Y.mergeUpdates(this.pendingUpdates);
      this.pendingUpdates = [];
      await this.#sendEnvelopeLocked({ t: T.Y_UPDATE, u: b64(merged) });

      // Periodically republish the whole board. Compaction can only prune what
      // every device has applied, so without a recent snapshot a device that
      // falls behind would have to replay the entire stroke history to catch
      // up. A snapshot makes the tail self-contained.
      this.updatesSinceSnapshot = (this.updatesSinceSnapshot || 0) + 1;
      if (this.updatesSinceSnapshot >= SNAPSHOT_EVERY) {
        try { await this.#snapshotLocked(); } catch { /* counter stays; retried next flush */ }
      }
      await this.#persist();
    });
  }

  /** Everything that must survive a reload, written atomically. */
  async #persist(extra = []) {
    const entries = [
      [K.cursor(this.handle, this.groupId), this.cursor],
      [K.history(this.handle, this.groupId), this.history],
      [K.ydoc(this.handle, this.groupId), Y.encodeStateAsUpdate(this.doc)],
      ...extra,
    ];
    const state = this.client?.exportState();
    if (state) entries.unshift([K.groupState(this.handle, this.groupId), state]);
    await store.setMany(entries);
  }

  async #sendEnvelopeLocked(obj) {
    if (!this.client) throw new Error("This device is not a member of the room.");
    if (this.revoked) throw new Error("You are no longer a member of this room.");
    if (this.desynced) throw new Error("This device is out of step with the room and needs a fresh invite.");
    const ct = await this.client.encrypt(encodeEnvelope(obj));
    // The sender ratchet just advanced. Make that durable BEFORE the
    // ciphertext leaves: a crash after the POST but before a later persist
    // would restore the previous generation and reuse its AES-GCM key and
    // nonce on a different plaintext. A generation burned by a failed POST
    // costs nothing — receivers skip ahead.
    await this.#persist();
    try {
      const { seq } = await api.postMessage(this.groupId, {
        kind: "application", senderDeviceId: this.deviceId, payload: b64(ct),
      });
      return seq;
    } catch (e) {
      if (isMembershipLoss(e)) { this.#markRevoked(); await this.#persist(); }
      throw e;
    }
  }

  #markRevoked() {
    if (this.revoked) return;
    this.revoked = true;
    this.syncStatus = "revoked";
    this.history.push(this.#notice("You are no longer a member of this room. A member can invite you back."));
  }

  /** Restore from local storage, or create the group if we are its founder. */
  open(groupIdB64) { return this.#serial(() => this.#openLocked(groupIdB64)); }

  async #openLocked(groupIdB64) {
    if (groupIdB64) {
      this.groupId = groupIdB64;
      const state = await store.get(K.groupState(this.handle, groupIdB64));
      if (!state) return false;              // known group, but not joined on this device
      this.client = await MlsClient.restore(this.handle, { state });
      this.cursor = (await store.get(K.cursor(this.handle, groupIdB64))) || 0;
      this.history = (await store.get(K.history(this.handle, groupIdB64))) || [];
      const saved = await store.get(K.ydoc(this.handle, groupIdB64));
      if (saved) Y.applyUpdate(this.doc, new Uint8Array(saved), "restore");
      return true;
    }

    // Founding a new group. A fresh, never-published KeyPackage becomes our
    // leaf so the pool's packages stay free for invitations into other rooms
    // and no two groups share this device's leaf keys.
    const raw = crypto.getRandomValues(new Uint8Array(16));
    this.groupId = b64(raw);
    const client = await MlsClient.create(this.handle);
    await client.newKeyPackage();
    await client.createGroup(raw);
    await api.createGroup(this.channel.id, this.groupId, SUITE);
    this.client = client;
    await this.#persist();
    return true;
  }

  /** Accept a pending Welcome for this device, if one exists. */
  tryJoin() { return this.#serial(() => this.#joinLocked()); }

  async #joinLocked() {
    const { welcomes } = await api.welcomes(this.deviceId);
    const mine = welcomes
      .filter((w) => w.groupId === this.groupId)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];       // newest wins
    if (!mine) return false;

    const pool = await loadPool(this.handle);
    const pkg = pool.packages.find((p) => p.ref === mine.ref);
    if (!pkg) {
      // The private half is gone (pool rotated past it). Nothing can use this
      // Welcome; clear it so the poll stops offering it.
      await api.ackWelcomes(this.deviceId, [mine.id]);
      throw new Error("That invite targets key material this device no longer holds. Ask to be invited again.");
    }
    const client = await MlsClient.restore(this.handle, { keyPackage: pkg });
    await client.joinFromWelcome(unb64(mine.welcome));
    if (b64(client.groupId) !== this.groupId) throw new Error("The Welcome is for a different group.");

    const rejoin = !!this.client;
    this.client = client;
    // Start reading after the commit that added us; earlier traffic is not
    // decryptable with the keys we were given, by design.
    this.cursor = mine.joinedAtSeq || 0;
    this.revoked = false;
    this.desynced = false;
    this.#newDoc();
    if (rejoin) {
      this.history.push(this.#notice("Rejoined from a fresh invite. Anything sent while this device was out of the room stays unreadable."));
    } else {
      this.history = [];
    }
    pool.packages = pool.packages.filter((p) => p.ref !== mine.ref);
    // Persist BEFORE acking. An ack with nothing durable behind it would
    // leave the device with neither group state nor a Welcome to retry.
    await this.#persist([[K.keyPackage(this.handle), pool]]);
    await api.ackWelcomes(this.deviceId, [mine.id]);
    topUpKeyPackages(this.handle, this.deviceId).catch(() => {});
    // The canvas so far is unreadable to us — we lacked the keys. An existing
    // member sends a snapshot after inviting; until it lands the board is blank.
    this.onCanvasChange?.();
    return true;
  }

  /**
   * Pull new log entries and apply them in order. Concurrent callers share
   * one in-flight run: two pulls over the same range would each try to
   * consume the same ratchet generations, and the second would fail on every
   * message.
   */
  sync() {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#serial(() => this.#syncLocked()).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #syncLocked() {
    if (!this.client) return { applied: 0, changed: false };
    if (this.revoked || this.desynced) {
      // The only way back in is a fresh Welcome; look for one and stop.
      let joined = false;
      try { joined = await this.#joinLocked(); } catch (e) { this.lastSyncError = e.message; }
      return { applied: 0, changed: joined };
    }

    const statusBefore = this.syncStatus;
    this.syncStatus = "syncing";
    this.lastSyncError = null;
    let res;
    try { res = await api.messages(this.groupId, this.cursor); }
    catch (e) {
      if (isMembershipLoss(e)) { this.#markRevoked(); await this.#persist(); return { applied: 0, changed: true }; }
      this.syncStatus = "error"; this.lastSyncError = e.message; throw e;
    }

    let applied = 0;
    let changed = false;
    const watermark = Number(res.watermark || 0);
    if (res.gap) {
      // Messages below the watermark were compacted away before this device
      // applied them, and MLS decrypts once, so they are gone for good.
      // Commits are never pruned and the server still returns them: apply
      // those so the epoch chain stays intact, drop the board (its deltas are
      // lost) and ask the room to republish it. Chat before the gap is lost;
      // pretending otherwise would leave a silent hole in the transcript.
      this.#newDoc();
      this.history.push(this.#notice("Older messages were compacted before this device caught up. Requesting a fresh board."));
      changed = true;
    }

    for (const m of res.messages) {
      if (m.senderDeviceId === this.deviceId) {
        // Our own message: the sender ratchet moved past it when we encrypted
        // it, so it can neither be applied nor needs to be.
        this.cursor = m.seq;
        continue;
      }
      if (res.gap && m.seq <= watermark && m.kind !== "commit") { this.cursor = m.seq; continue; }
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
            this.#answerSnapshotRequest();
          } else {
            this.history.push({ seq: m.seq, text: env.b, at: m.createdAt, mine: false });
          }
          changed = true;
        }
        applied++;
      } catch (e) {
        if (m.kind === "commit") {
          // A commit we cannot apply closes every later epoch to us. Stepping
          // past it would only hide that; stop here, keep the cursor on it,
          // and wait for a fresh invite.
          this.desynced = true;
          this.syncStatus = "desynced";
          this.lastSyncError = e.message;
          this.history.push(this.#notice(`This device fell out of step with the room at seq ${m.seq} (${e.message}). It needs a fresh invite to continue.`));
          await this.#persist();
          return { applied, changed: true };
        }
        // A message we cannot apply must not block the cursor forever, but it
        // also must not be silently dropped — surface it in the transcript.
        this.history.push({ seq: m.seq, error: String(e.message), at: m.createdAt });
        changed = true;
      }
      this.cursor = m.seq;
    }
    if (res.gap) this.cursor = Math.max(this.cursor, watermark);

    if (res.messages.length || res.gap) {
      await this.#persist();
      // Tell the server how far we've applied. This is the sole input to
      // compaction — without it the log can never be pruned, because the
      // server has no other way to know a message is safely delivered.
      api.reportCursor(this.groupId, this.deviceId, this.cursor).catch(() => {});
    }
    if (res.gap) await this.#sendEnvelopeLocked({ t: T.Y_REQUEST });

    this.syncStatus = res.gap ? "recovered" : "synced";
    this.lastSyncedAt = new Date();
    if (this.syncStatus !== statusBefore) changed = true;
    return { applied, changed };
  }

  send(text) {
    return this.#serial(async () => {
      const seq = await this.#sendEnvelopeLocked({ t: T.CHAT, b: text });
      // Our own message is never echoed back through apply() — the sender's
      // ratchet has already moved past it — so record it directly.
      this.history.push({ seq, text, at: new Date().toISOString(), mine: true });
      await this.#persist();
      return seq;
    });
  }

  /** Hand a late joiner the whole board in one message. */
  sendCanvasSnapshot() { return this.#serial(() => this.#snapshotLocked()); }

  async #snapshotLocked() {
    if (!this.client) return;
    const seq = await this.#sendEnvelopeLocked({ t: T.Y_SNAPSHOT, u: b64(Y.encodeStateAsUpdate(this.doc)) });
    this.updatesSinceSnapshot = 0;
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
  invite(handle) {
    return this.#serial(async () => {
      if (!this.usable) throw new Error("This device cannot invite right now.");
      const { keyPackages } = await api.claimKeyPackages(handle, SUITE, this.groupId);
      const add = await this.client.addMembers(keyPackages.map((k) => unb64(k.keyPackage)));
      try {
        await api.postMessage(this.groupId, {
          kind: "commit",
          epoch: add.builtAtEpoch,
          senderDeviceId: this.deviceId,
          payload: b64(add.commit),
          welcomes: keyPackages.map((k) => ({ ref: k.ref, deviceId: k.deviceId, welcome: b64(add.welcome) })),
        });
      } catch (e) {
        if (e.status === 409) throw new Error("The room changed while you were inviting. Sync and try again.");
        throw e;
      }
      // The delivery service accepted the commit: only now adopt its epoch.
      add.confirm();
      await this.#persist();
      // Everything before the commit is undecryptable to the new member, so
      // the canvas would be blank for them. Re-publish the board at the new
      // epoch.
      await this.#snapshotLocked();
      return keyPackages.length;
    });
  }

  async members() { return api.groupMembers(this.groupId); }

  /** MLS remove commit first; server membership is revoked atomically with it. */
  removeMember(handle) {
    return this.#serial(async () => {
      if (!this.usable) throw new Error("This device cannot change membership right now.");
      const removal = await this.client.removeMember(handle);
      try {
        await api.postMessage(this.groupId, {
          kind: "commit", epoch: removal.builtAtEpoch, senderDeviceId: this.deviceId,
          payload: b64(removal.commit), removeHandle: handle,
        });
      } catch (e) {
        if (e.status === 409) throw new Error("The room changed while you were removing. Sync and try again.");
        throw e;
      }
      removal.confirm();
      await this.#persist();
      return removal.removedLeaves;
    });
  }
}
