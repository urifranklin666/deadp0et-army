# deadp0et

Collaborative design surface welded to end-to-end encrypted messaging.
Live at [deadp0et.army](https://deadp0et.army) — console at `/app`.

> **Status: not audited.** The cryptography is assembled from vetted
> implementations rather than hand-rolled, but the composition has had no
> external review. Do not use this to protect anyone who would be harmed if it
> failed.

## Layout

```
apps/api        Fastify + Postgres + Redis. Key directory, ciphertext relay,
                MLS delivery service, ephemeral presence relay, delivery hints.
apps/web        The console: passkey auth, encrypted chat, collaborative canvas.
apps/site       Marketing site (deadp0et.army).
packages/crypto Isomorphic MLS client — same code in Node and the browser.
```

## The security model, in one paragraph

The server stores **public key material** and **opaque ciphertext**, and does
nothing else with them. It cannot read a message, a canvas stroke, or a cursor
position, and it holds no key capable of decrypting any of them. Everything
below follows from taking that seriously.

## Crypto

Group messaging is **MLS** (RFC 9420) via [`ts-mls`], ciphersuite
`MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87` — post-quantum end to end,
ML-KEM1024 key exchange with ML-DSA87 signatures.

MLS rather than pairwise sessions because the workload is group-shaped: a
canvas stroke is encrypted **once for the whole room**. Pairwise Double
Ratchet would need one ciphertext per recipient device per stroke.

That suite is also chosen for reach. Every `*_Ed25519` suite depends on
WebCrypto Ed25519, which only reached Chrome 137 — and `ts-mls`'s
`nobleCryptoProvider` does *not* rescue you, because its signature
implementation prefers `crypto.subtle` whenever it merely exists. ML-DSA comes
from `@noble/post-quantum` in pure JS and touches no WebCrypto signature
algorithm at all.

`apps/api` also carries a **PQXDH / Double Ratchet** substrate on Signal's own
[`libsignal`], kept green for a future desktop client. libsignal ships native
`.node` binaries only, so it cannot run in a browser — hence MLS for the web.

## Things that are load-bearing

**MLS application messages decrypt exactly once.** Applying one advances the
ratchet. So the decrypted transcript and the log cursor must be persisted
together (IndexedDB); losing that store loses readable history permanently
even though the ciphertext is still on the server. This is the intended
property, not a bug.

**Commits are totally ordered.** A commit declares the epoch it was built
against and the server applies it with a conditional
`UPDATE ... WHERE epoch = $expected`. Two members committing at the same epoch
cannot both win, or the group forks into histories that can never reconcile.

**Compaction is driven by delivery, not content.** The server cannot know what
a snapshot supersedes, so it prunes strictly below the slowest active device's
reported cursor. Commits are never pruned. Devices silent past 30 days stop
pinning the log, and a `compaction_watermark` lets the read path answer
`gap: true` rather than let a returning device diverge in silence.

**A Welcome is a grant, so it is checked.** Being welcomed materialises
channel membership, so the server only accepts a Welcome naming a KeyPackage
the committer itself claimed from the target device — and each claim backs
one Welcome, never a replay. It also seeds that device's
delivery cursor at the add commit, so compaction cannot prune past a joiner
who has not come online yet.

**KeyPackages are a pool.** Each is single-use, so every device keeps a few
published (topped up when it runs low) and opens a Welcome with the private
half matching the ref it was addressed to. One package would mean one group.
A founder's leaf comes from a fresh package that is never published, and a
claimer may hold only a few unused claims against any one user, so nobody can
drain someone else's pool.

**Removal is a commit plus a revocation.** An owner or admin removes someone
with an MLS remove commit, so the next epoch's keys never reach them; the same
request names them so the server drops their channel membership, delivery
cursors and pending Welcomes in that transaction. The server cannot check that
the opaque commit really removes who it names, which is why only owners and
admins may send one.

Leaving works the other way round. A member cannot commit its own removal, so
`leave` ends their server access and wipes the group from their device, and
the next owner/admin client to reconcile the MLS tree against the channel
roster commits the removal of the leftover leaf.

**Messages are attributed by credential.** The sender shown on a message is
the credential of the MLS leaf that signed it, not anything the server says.
Since anyone can write any identity into their own KeyPackage, an inviter
refuses packages whose credential doesn't name the handle being invited.

**One tab holds the keys.** Tabs of one browser share IndexedDB, so two
tabs would each advance their own copy of the same MLS state (same ratchet
generation twice: key and nonce reuse). An exclusive Web Lock per account
makes any second tab stand down.

**Writes happen before sends.** The advanced sending ratchet is saved before
a ciphertext leaves, and a commit's new epoch is saved (with a note of the old
one) before it is posted; a note left by a crash is settled against the log on
the next open. State, cursor and transcript are always written in one
transaction.

**Group state is touched by one operation at a time.** Encrypting and applying
both read the ratchet, await, and write it back; a sync landing mid-send could
otherwise roll one of them back. A sender also never advances its read cursor
to its own new message — that would skip whatever others posted in between,
which can never be fetched again.

**Hidden is not deleted.** Every read filters expired rows, and a sweep then
removes them: expired sessions and application messages, envelopes a day after
they are acked, used Welcomes and claimed KeyPackages after a grace period.
Commits are never swept.

**Delivery is pushed, fetching is not.** Each tab holds one `/api/live`
socket; when a message lands in one of the user's groups (or a Welcome is
addressed to one of their devices) the api sends a hint — group and seq,
which it already knows — and the client fetches. Nothing in a hint is
trusted, and polling continues every 20s as a fallback, so a lost hint costs
latency, never data.

**Presence is deliberately outside MLS.** Cursors move at pointer rates;
routing them through application messages would outrun receivers' skipped-key
window and grow the ordered log without bound. They are sealed instead under a
key from the MLS exporter (RFC 9420 §8.5) — same key for every member of an
epoch, new key on epoch change — and relayed over a WebSocket that persists
nothing. Each socket re-checks its session and membership every minute, so
logging out or leaving a channel also stops the frames.

**The console ships a Content-Security-Policy.** It holds private keys in
IndexedDB, so injected script is key theft. The build adds a meta CSP
allowing only its own scripts and same-origin connections; e2e checks it
blocks an injected inline script. `frame-ancestors` can't be set from a meta
tag, so nginx should send it as a header.

## Known limits

Both follow from commits being MLS *private* messages (opaque to the server)
and from members using unsigned "basic" credentials:

- **Removal authorization binds honest clients only.** The server checks the
  `removes` a commit declares, but cannot see the proposals inside it, so a
  modified client could commit a removal without declaring it. Closing this
  means sending handshake messages as MLS public messages (revealing
  membership changes to the server, which largely knows them already) so the
  server can validate proposals against roles.
- **Attribution trusts credentials after the add.** The server only accepts
  KeyPackages naming their uploader, and inviters re-check that, but a member
  running a modified client could later commit a leaf update carrying a
  different name. Closing this needs credentials the server (or users) sign.

## Development

```bash
pnpm install
node apps/api/src/migrate.js     # apply migrations
pnpm --filter api start          # :8790
pnpm --filter web dev            # :5173, proxies /api
```

Requires Postgres and Redis, and a `.env` at the repo root (never committed):

```
DATABASE_URL=postgres://…
REDIS_URL=redis://127.0.0.1:6379/0
RP_ID=deadp0et.army
RP_ORIGIN=https://deadp0et.army
SESSION_SECRET=…
```

`RP_ID` must match the origin the console is served from — WebAuthn validates
it, so passkeys cannot be exercised from `localhost` against a production
`RP_ID`.

## Tests

Backend suites drive the real HTTP API; browser suites drive a real Chromium
with a CDP virtual WebAuthn authenticator, against a local stack or the live
origin. The session
suite needs no browser: it seeds sessions in Postgres and runs `session.js`
in Node over an in-memory IndexedDB.

```bash
pnpm lint                               # undefined/unused identifiers, hook rules
pnpm test                               # every suite below that runs locally
```

`pnpm test` starts its own api on port 8791 with test-friendly limits, runs the
backend and session suites against it, and stops it — Postgres with migrations
applied is all it needs. `pnpm test:browser` does the same for the browser
suites: the console's production build (`vite preview`, CSP included) on
`localhost:5174` with WebAuthn pinned to `localhost`, and one for the site on `localhost:5175` that proxies
`/app` and `/api` the way nginx does (set `CHROMIUM_PATH` to use a Chromium
other than Playwright's). CI runs both on every pull request. The browser suites also run
against production with `ORIGIN=https://deadp0et.army`.

```bash
node apps/api/test/e2ee.test.js         # PQXDH handshake + relay
node apps/api/test/mls.api.test.js      # delivery service + fork guard
node apps/api/test/compaction.test.js   # prune safety
node apps/api/test/housekeeping.test.js # retention sweep, claim throttle, presence revocation
node apps/web/test/session.test.mjs     # client MLS bookkeeping, against the local api
node apps/web/test/e2e.mjs              # passkey → channel → message → reload
node apps/web/test/canvas.mjs           # CRDT convergence, late-joiner snapshot
node apps/web/test/presence.mjs         # live cursors, log stays untouched
node apps/web/test/mobile.mjs           # console at 390px: one pane at a time, no overflow
node apps/site/test/funnel.mjs          # marketing → console handoff
```

## Deploy

Each Cloudflare tunnel forwards to nginx, which routes on `Host`, so adding a
domain never touches a tunnel.

```bash
site-add <domain> [--proxy PORT] [--alias <host>]
site-deploy <domain> <build-dir>      # atomic release + symlink flip, keeps 5
site-rollback <domain>
```

[`ts-mls`]: https://github.com/LukaJCB/ts-mls
[`libsignal`]: https://github.com/signalapp/libsignal
