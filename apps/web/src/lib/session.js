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
// How often an owner/admin client checks the MLS tree against the channel
// roster, to remove the leaves of members who have left.
const RECONCILE_MS = 30_000;

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
 * Signature key (base64) -> the handle whose authenticated upload registered
 * it. Keys never change owner, so a hit is good for the page's lifetime.
 */
const keyOwners = new Map();
// Keys the directory didn't know, and when we asked: not re-sent on every
// sync (they're multi-KB), but asked again after a while — an owner may
// register a leaf later (see #registerLeaf).
const unknownKeys = new Map();
const UNKNOWN_TTL_MS = 60_000;

/** Resolve keys to owners. Throws if the directory can't be reached. */
async function ownersOf(keys) {
  const now = Date.now();
  const ask = [...new Set(keys)].filter((k) => k && !keyOwners.has(k)
    && !(now - (unknownKeys.get(k) ?? -Infinity) < UNKNOWN_TTL_MS));
  if (ask.length) {
    const { identities } = await api.identities(ask);
    for (const k of ask) {
      if (identities[k]) { keyOwners.set(k, identities[k]); unknownKeys.delete(k); }
      else unknownKeys.set(k, now);
    }
  }
  return keyOwners;
}

/**
 * Run `fn`; if the server wants a fresh passkey proof first (it does for
 * passkey changes and account deletion), do the step-up ceremony and retry
 * once. Within the server's window, later sensitive calls don't prompt again.
 */
export async function withReauth(fn) {
  const stepUp = async () => {
    const { options } = await api.post("/api/auth/reauth/start", {});
    const assertion = await startAuthentication({ optionsJSON: options });
    await api.post("/api/auth/reauth/finish", { response: assertion });
  };
  if (!(await api.get("/api/auth/reauth").catch(() => ({ recent: false }))).recent) await stepUp();
  try {
    return await fn();
  } catch (e) {
    // The proof lapsed between the check and the call: once more.
    if (e.status !== 403 || e.message !== "reauth_required") throw e;
    await stepUp();
    return fn();
  }
}

/** Register another passkey for the signed-in account (a backup). */
export function addPasskey() {
  return withReauth(async () => {
    const { options } = await api.post("/api/auth/passkeys/start", {});
    const attResp = await startRegistration({ optionsJSON: options });
    return api.post("/api/auth/passkeys/finish", { response: attResp });
  });
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

// The transcript is stored in chunks of this many entries, and a save writes
// only the chunks that changed. As one array, every message re-wrote the
// channel's whole history to IndexedDB — fine at 50 entries, not at 50,000.
const HISTORY_CHUNK = 250;

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

  /** One atomic write: see store.setMany for why these can't be separate. */
  async #persist() {
    const state = this.client.exportState();
    const hist = this.#historyWrites();
    await store.setMany([
      ...(state ? [[K.groupState(this.handle, this.groupId), state]] : []),
      [K.cursor(this.handle, this.groupId), this.cursor],
      ...hist.puts,
      [K.ydoc(this.handle, this.groupId), Y.encodeStateAsUpdate(this.doc)],
    ], hist.deletes);
    hist.saved();
  }

  // Each stored chunk's JSON as last written, to tell which ones changed.
  // Comparing contents rather than tracking edits catches every kind of
  // change — appends, the re-sort after a sync, late attribution of old
  // entries — for the cost of serialising in memory, not writing to disk.
  #savedChunks = [];

  /** The puts and deletes that bring the stored transcript up to date. */
  #historyWrites() {
    const puts = [];
    const next = [];
    for (let i = 0; i * HISTORY_CHUNK < this.history.length; i++) {
      const chunk = this.history.slice(i * HISTORY_CHUNK, (i + 1) * HISTORY_CHUNK);
      const json = JSON.stringify(chunk);
      next.push(json);
      if (json !== this.#savedChunks[i]) puts.push([K.historyChunk(this.handle, this.groupId, i), chunk]);
    }
    puts.push([K.history(this.handle, this.groupId), { chunks: next.length }]);
    const deletes = [];
    for (let i = next.length; i < this.#savedChunks.length; i++) {
      deletes.push(K.historyChunk(this.handle, this.groupId, i));
    }
    return { puts, deletes, saved: () => { this.#savedChunks = next; } };
  }

  async #loadHistory() {
    const index = await store.get(K.history(this.handle, this.groupId));
    if (Array.isArray(index)) {
      // Stored before chunking: rewritten as chunks at the next save.
      this.history = index;
      this.#savedChunks = [];
      return;
    }
    const n = index?.chunks || 0;
    const chunks = n ? await store.getMany(
      Array.from({ length: n }, (_, i) => K.historyChunk(this.handle, this.groupId, i))) : [];
    this.history = chunks.flatMap((c) => c || []);
    this.#savedChunks = chunks.map((c) => JSON.stringify(c || []));
  }

  async #restoreDoc() {
    const saved = await store.get(K.ydoc(this.handle, this.groupId));
    if (saved) Y.applyUpdate(this.doc, new Uint8Array(saved), "restore");
  }

  async #sendEnvelope(obj) {
    const ct = await this.client.encrypt(encodeEnvelope(obj));
    // Save the advanced sending ratchet BEFORE the ciphertext leaves. If the
    // tab died after posting but before saving, the reloaded state would
    // derive the same key and nonce for the next message — AES-GCM nonce
    // reuse. The reverse (saved, never posted) just skips a generation,
    // which receivers tolerate. Only group state changes here; the receive
    // side, cursor and transcript are as last persisted.
    await store.set(K.groupState(this.handle, this.groupId), this.client.exportState());
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
      this.cursor = (await store.get(K.cursor(this.handle, groupIdB64))) || 0;
      await this.#loadHistory();
      this.client = await MlsClient.restore(this.handle, { keyPackage: kp, state });
      try {
        await this.#settlePendingCommit();
      } catch (e) {
        this.client = null;                   // not usable until settled; reopening retries
        throw e;
      }
      await this.#restoreDoc();
      this.#registerLeaf().catch(() => {});
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
    const leaf = await this.client.newKeyPackage();
    // Never claimable, but its signature key must be in the directory, or
    // nobody could attribute this founder's messages.
    await api.registerSignatureKey(b64(leaf.encoded));
    await this.client.createGroup(raw);
    await api.createGroup(this.channel.id, this.groupId, SUITE, this.deviceId);
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
    this.removed = false;                     // a re-invite after removal or leaving
    // Start reading after the commit that added us; earlier traffic is not
    // decryptable with the keys we were given, by design.
    this.cursor = mine.joinedAtSeq || 0;
    this.history = [];
    // Persist before acking: an acked Welcome is never offered again, so a
    // failed save after the ack would lose the join for good.
    await this.#persist();
    await api.ackWelcomes(this.deviceId, [mine.id]);
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
    if (!this.client) return { applied: 0, removed: !!this.removed };
    let res;
    try {
      res = await api.messages(this.groupId, this.cursor);
    } catch (e) {
      // We were a member; a 404 now means we were removed. The server has
      // cut our access, and the group has (or will have) moved to an epoch
      // whose keys we never get. Stop asking.
      if (e.status !== 404) throw e;
      // Forget the group's keys: they can't open anything new, and keeping
      // them would make a later re-invite restore this dead state instead of
      // joining afresh. The transcript stays on screen until navigation.
      await this.#forget();
      this.history.push({
        seq: this.cursor, at: new Date().toISOString(),
        notice: "You were removed from this channel. Nothing sent after that is readable to this device.",
      });
      return { applied: 0, removed: true };
    }
    const { messages } = res;
    if (res.gap) {
      await this.#recoverFromGap(Number(res.watermark || 0));
      this.onCanvasChange?.();
      return { applied: 0, recovered: true };
    }
    let applied = 0;
    const landedCommits = [];
    // Entries whose attribution failed earlier get another go with this batch.
    const toAttribute = this.history.filter((h) => h.pendingKey).map((h) => [h, h.pendingKey]);
    for (const m of messages) {
      if (m.senderDeviceId === this.deviceId) {
        // Our own entry. Its effect is already in local state — encrypt()
        // and addMembers() advance the ratchet as they build — and MLS gives
        // a sender no way to decrypt what it sent. Just step past it. If it
        // is the commit a pending note is waiting on, it landed: settle it.
        if (m.kind === "commit") landedCommits.push(m.epoch);
        this.cursor = m.seq;
        continue;
      }
      try {
        const { text, sender, senderKey, removed } = await this.client.applyWithSender(unb64(m.payload));
        if (!this.client.active) {
          // That commit removed THIS device from the group's encryption. It
          // can't read anything further, so stop here and forget the group.
          // Tell the server: if the roster still lists us (an undeclared
          // removal), owner/admin clients re-add exactly this device, and the
          // Welcome is joined afresh. Name the remover by key, not credential.
          this.cursor = m.seq;
          await store.set(K.evictionReport(this.handle, this.groupId), true);
          await this.retryEvictionReport().catch(() => {});   // kept and retried if it fails
          const by = senderKey ? (await ownersOf([senderKey]).catch(() => keyOwners)).get(senderKey) : null;
          await this.#forget();
          this.history.push({
            seq: m.seq, at: m.createdAt,
            notice: `${by || "An unverified member"} removed this device from the group's encryption.`,
          });
          return { applied, removed: true };
        }
        if (removed?.length) {
          // An audit line for every removal, named by the committer's key —
          // including removals a modified client didn't declare to the
          // server (owner/admin clients also heal those; see #reconcile).
          const entry = { seq: m.seq, at: m.createdAt, from: sender, audit: { removed: [...new Set(removed)] } };
          this.history.push(entry);
          if (senderKey) toAttribute.push([entry, senderKey]);
        }
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
            // Attributed below, by the key that signed it.
            const entry = {
              seq: m.seq, text: env.b, at: m.createdAt, from: sender,
              mine: m.senderDeviceId === this.deviceId,
            };
            this.history.push(entry);
            if (senderKey) toAttribute.push([entry, senderKey]);
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
    if (toAttribute.length) await this.#attribute(toAttribute);
    if (messages.length || toAttribute.length) {
      // Our own sends are recorded the moment they post, but may carry a
      // higher seq than peers' messages this sync just fetched. Keep the
      // transcript in log order (Array#sort is stable, so equal seqs keep
      // their arrival order).
      this.history.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      await this.#persist();
      if (landedCommits.length) {
        const key = K.pendingCommit(this.handle, this.groupId);
        const pending = await store.get(key);
        if (pending && landedCommits.includes(pending.epoch)) await store.del(key);
      }
      // Tell the server how far we've applied. This is the sole input to
      // compaction — without it the log can never be pruned, because the
      // server has no other way to know a message is safely delivered.
      api.reportCursor(this.groupId, this.deviceId, this.cursor).catch(() => {});
    }
    // Never recursive: #reconcile's own #drain calls back into #sync, but by
    // then lastReconcile is fresh and this returns at once.
    await this.#reconcile().catch(() => {});
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
  async #ownCommitLanded(epoch, since = this.cursor) {
    for (let page = 0; page < 20; page++) {
      const { messages } = await api.messages(this.groupId, since);
      const commit = messages.find((m) => m.kind === "commit" && m.epoch === epoch);
      if (commit) return commit.senderDeviceId === this.deviceId;
      if (!messages.length) return false;     // log fully read, no commit at that epoch
      since = messages[messages.length - 1].seq;
    }
    return null;
  }

  /**
   * Name each message by the account that registered its signing key, not by
   * the credential in the leaf (which the leaf's owner can rewrite). The MLS
   * signature check already proved which key signed it. A key nobody
   * registered is shown as unverified; a credential that disagrees with the
   * key's owner is shown, flagged, next to the real owner.
   */
  async #attribute(pairs) {
    let owners;
    try {
      owners = await ownersOf(pairs.map(([, k]) => k));
    } catch {
      // Directory unreachable: don't brand these "unverified" for good. Keep
      // the key on the entry and try again on a later sync.
      for (const [entry, key] of pairs) entry.pendingKey = key;
      return;
    }
    for (const [entry, key] of pairs) {
      const owner = owners.get(key);
      // Unknown for now: flag it, but keep the key so a later sync asks again
      // (after the negative cache lapses) — the owner may register it later.
      if (!owner) { entry.unverified = true; entry.pendingKey = key; continue; }
      delete entry.pendingKey;
      delete entry.unverified;
      if (entry.from && entry.from !== owner) entry.claimed = entry.from;
      entry.from = owner;
    }
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

  /**
   * Build a commit locally and get it into the log, or leave no trace.
   *
   * `build(client)` advances local state to the next epoch and returns
   * { builtAtEpoch, commit, ... }; `extra(result)` adds fields to the post.
   * If the server did not take the commit, nobody will ever follow us to that
   * epoch, so roll back — or this device is forked off the group for good.
   * An error response proves a refusal (the append is one transaction); with
   * no response at all, ask the log whether it landed.
   */
  async #commit(build, extra = () => ({})) {
    const before = this.client.exportState();
    const res = await build(this.client);
    // Save the new epoch, with a note of the old one, BEFORE posting. A tab
    // dying after the server took the commit but before a later save would
    // otherwise reload the old epoch — and a device can't process its own
    // commit, so it would be stuck there for good. On the next open the note
    // is settled against the log (see #settlePendingCommit).
    const pendingKey = K.pendingCommit(this.handle, this.groupId);
    await store.setMany([
      [K.groupState(this.handle, this.groupId), this.client.exportState()],
      // `since`: the cursor now. The commit lands after it, so settling can
      // search from here even if this tab syncs past it in the meantime.
      [pendingKey, { before, epoch: res.builtAtEpoch, since: this.cursor }],
    ]);
    try {
      await api.postMessage(this.groupId, {
        kind: "commit",
        epoch: res.builtAtEpoch,
        senderDeviceId: this.deviceId,
        payload: b64(res.commit),
        ...extra(res),
      });
    } catch (e) {
      const landed = e.status ? false : await this.#ownCommitLanded(res.builtAtEpoch).catch(() => null);
      if (landed === null) throw e;           // still can't tell; the note stays for the next open
      if (!landed) {
        await this.#restoreState(before);
        await store.del(pendingKey);
        throw e;
      }
    }
    await this.#persist();
    await store.del(pendingKey);
    return res;
  }

  /**
   * Make sure the key directory knows this device's leaf in this group, with
   * proof we hold it. New leaves are registered when their package is
   * uploaded; this covers older groups (e.g. founders' never-uploaded leaves),
   * whose messages would otherwise show as unverified. Once per group.
   */
  async #registerLeaf() {
    const flag = K.leafRegistered(this.handle, this.groupId);
    if (!this.client?.active || (await store.get(flag))) return;
    await api.registerSignatureKey(b64(await this.client.leafKeyProof()));
    await store.set(flag, true);
  }

  /**
   * Tell the server this device lost its leaf, if it hasn't heard yet. The
   * note survives reloads: without the report no owner client knows to re-add
   * this device, so a failed attempt is retried (see App's welcome loop).
   */
  async retryEvictionReport() {
    const key = K.evictionReport(this.handle, this.groupId);
    if (!(await store.get(key))) return;
    await api.reportEvicted(this.groupId, this.deviceId);
    await store.del(key);
  }

  /** Put the group back to `state` in memory and on disk. */
  async #restoreState(state) {
    const kp = await store.get(K.keyPackage(this.handle));
    this.client = await MlsClient.restore(this.handle, { keyPackage: kp, state });
    await store.set(K.groupState(this.handle, this.groupId), state);
  }

  /**
   * A commit was saved as pending but its outcome never recorded (the tab
   * died, or the answer was lost). Keep the new epoch if the commit is in the
   * log, go back to the old one if it isn't; if the log can't be read, leave
   * the note and refuse to open, rather than guess.
   */
  async #settlePendingCommit() {
    const key = K.pendingCommit(this.handle, this.groupId);
    const pending = await store.get(key);
    if (!pending) return;
    const landed = await this.#ownCommitLanded(pending.epoch, pending.since ?? 0).catch(() => null);
    if (landed === null) throw new Error("couldn't confirm an unfinished change to this group; try again");
    if (!landed) await this.#restoreState(pending.before);
    await store.del(key);
  }

  /**
   * Remove a member (all their devices) from the group and the channel.
   * Only a channel owner or admin may; the server enforces that.
   */
  remove(handle) { return this.#exclusive(() => this.#remove(handle)); }

  async #remove(handle) {
    await this.#drain();
    const res = await this.#commit(
      (client) => client.removeMembers(handle),
      () => ({ removes: [handle] }));
    return res.removed;
  }

  /**
   * Leave the channel: the server ends our access now, and this device
   * forgets the group's keys and transcript. Our MLS leaf is removed by the
   * next owner/admin client to reconcile (we cannot commit our own removal).
   */
  leave() { return this.#exclusive(() => this.#leave()); }

  async #leave() {
    await api.leave(this.channel.id);
    // Only once the server agreed: a refused leave must not drop unsent edits.
    await this.#forget();
    this.history = [];
  }

  /** Drop this device's copy of the group: keys, cursor, transcript, board. */
  async #forget() {
    clearTimeout(this.flushTimer);
    this.pendingUpdates = [];
    this.removed = true;
    this.client = null;
    this.cursor = 0;
    await store.delMany([K.groupState, K.cursor, K.history, K.ydoc, K.pendingCommit]
      .map((key) => key(this.handle, this.groupId))
      .concat(this.#savedChunks.map((_, i) => K.historyChunk(this.handle, this.groupId, i))));
    this.#savedChunks = [];
  }

  /**
   * Owners and admins only: remove from the MLS group anyone the channel
   * roster no longer lists (they left). Until then a leaver's leaf would keep
   * receiving the keys for every new epoch. Throttled; failures are left for
   * the next attempt, and #commit has already rolled back any refused commit.
   */
  reconcile() { return this.#exclusive(() => this.#reconcile(true)); }

  async #reconcile(force = false) {
    if (!this.client || this.removed || !["owner", "admin"].includes(this.channel.role)) return 0;
    if (!force && Date.now() - (this.lastReconcile || 0) < RECONCILE_MS) return 0;
    this.lastReconcile = Date.now();
    await this.#drain();
    // The drain may have removed THIS device (a commit took our leaf, or the
    // server says we're out). Nothing below makes sense from here.
    if (!this.client || this.removed) return 0;
    const { members } = await api.members(this.channel.id);
    const roster = new Set(members.map((m) => m.handle));
    const inTree = new Set(this.members());
    let changed = 0;

    // Leaves of people the roster no longer lists (they left): prune.
    const stale = [...inTree].filter((h) => h !== this.handle && !roster.has(h));
    if (stale.length) {
      const res = await this.#commit((client) => client.removeMembers(stale), () => ({ removes: stale }));
      changed += res.removed;
    }

    // People the roster lists who have no leaf at all: someone removed them
    // without telling the server (only a modified client can), or an add was
    // lost. The roster is the truth; bring them back. Best effort — someone
    // with no devices or packages right now is retried next time.
    for (const handle of roster) {
      if (handle === this.handle || inTree.has(handle)) continue;
      changed += await this.#invite(handle).catch(() => 0);
    }

    // Devices that reported being removed from the group's encryption while
    // their owner still has a leaf elsewhere (one of several devices, or our
    // own other device): the scoped claim picks up exactly those devices.
    const { handles: evicted } = await api.evicted(this.groupId).catch(() => ({ handles: [] }));
    for (const handle of evicted) {
      if (!roster.has(handle) || !this.members().includes(handle)) continue;
      changed += await this.#invite(handle).catch(() => 0);
    }
    return changed;
  }

  /** The member handles in this group's current epoch, from the ratchet tree. */
  members() {
    return this.client ? [...new Set(this.client.members().map((m) => m.identity).filter(Boolean))] : [];
  }

  /** Add another user by handle: claim their KeyPackage, commit, send Welcome. */
  invite(handle) { return this.#exclusive(() => this.#invite(handle)); }

  async #invite(handle) {
    // A commit must be built against the group's CURRENT epoch or the server
    // refuses it, so catch up on anyone else's commits first.
    await this.#drain();
    // Only devices not already in this group — which also makes inviting
    // your own handle the way to bring a new device of yours in. Someone with
    // no leaf at all needs every device, whatever the server believes is in
    // the group (a removal it wasn't told about leaves it believing wrongly).
    const { keyPackages } = await api.claimKeyPackages(handle, SUITE,
      this.members().includes(handle) ? this.groupId : undefined);
    // Whatever a KeyPackage's credential says is what every member will see
    // on that member's messages, and its owner chose it. Refuse any that
    // don't name the person we meant to invite.
    for (const k of keyPackages) {
      const who = keyPackageIdentity(unb64(k.keyPackage));
      if (who !== handle) {
        throw new Error(`a key package for ${handle} claims to be ${JSON.stringify(who)}; refusing to add it`);
      }
    }
    // Someone re-invited before their old leaf was pruned (they left, or
    // were removed from the roster only): replace it in the same commit, and
    // say so, so the server can check it's a non-member's. A current member
    // being given another device keeps their existing leaves.
    const stale = this.members().includes(handle)
      && !(await api.members(this.channel.id)).members.some((m) => m.handle === handle);
    await this.#commit(
      (client) => client.addMembers(keyPackages.map((k) => unb64(k.keyPackage)), { replacing: stale ? [handle] : [] }),
      (add) => ({
        welcomes: keyPackages.map((k) => ({ ref: k.ref, deviceId: k.deviceId, welcome: b64(add.welcome) })),
        ...(stale ? { removes: [handle] } : {}),
      }));
    // Everything before the commit is undecryptable to the new member, so the
    // canvas would be blank for them. Re-publish the board at the new epoch.
    await this.#sendCanvasSnapshot();
    await this.#persist();
    return keyPackages.length;
  }
}
