/**
 * Two api nodes behind one Redis: what lives in a node's memory must still
 * reach sockets held by the other.
 *
 * Starts a second api process next to the one at BASE and checks that
 *   - a delivery hint for a message posted at one node reaches a listener
 *     connected to the other;
 *   - a presence frame crosses nodes, and isn't echoed to its sender;
 *   - a membership change at one node clears the other's roster cache at
 *     once (a stale cache would keep hinting a member who has left);
 *   - ending a session, or leaving a channel, at one node closes the
 *     affected sockets at the other at once. Node B's periodic recheck is
 *     set to a minute, so a prompt close can only come from the push.
 *
 * Needs REDIS_URL; without it there's only ever one node, and this skips —
 * except the first check, that a node which can't reach its Redis reports
 * itself degraded, which needs none.
 */
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { q, pool } from "../src/db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A node whose Redis is unreachable must say so at /api/health: with
// REDIS_URL set, sign-in challenges live there. (Needs no working Redis.)
{
  const port = process.env.CLUSTER_DEAD_PORT || "8794";
  const dead = spawn(process.execPath, ["src/server.js"], {
    cwd: apiDir, env: { ...process.env, PORT: port, REDIS_URL: "redis://127.0.0.1:1/0" }, stdio: "ignore",
  });
  try {
    let health = null;
    for (let i = 0; i < 300 && !health; i++) {
      try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); } catch { await sleep(100); }
    }
    assert.ok(health, "the node with a dead Redis should still answer health checks");
    assert.equal(health.redis, "down");
    assert.equal(health.status, "degraded", "an unreachable Redis makes the node degraded");
    console.log("· a node that can't reach its Redis reports degraded");
  } finally {
    dead.kill("SIGKILL");
  }
}

if (!process.env.REDIS_URL) {
  console.log("REDIS_URL not set: single node only, nothing to fan out — skipped");
  await pool.end();
  process.exit(0);
}

const A = process.env.BASE || "http://127.0.0.1:8790";
const PORT_B = process.env.CLUSTER_PORT || "8793";
const B = `http://127.0.0.1:${PORT_B}`;
const ORIGIN = process.env.RP_ORIGIN;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

const nodeB = spawn(process.execPath, ["src/server.js"], {
  cwd: apiDir, env: { ...process.env, PORT: PORT_B, PRESENCE_RECHECK_MS: "60000" }, stdio: "inherit",
});
process.on("exit", () => nodeB.kill("SIGTERM"));
for (let i = 0; ; i++) {
  try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* not up yet */ }
  if (i > 300) throw new Error("second api node did not come up");
  await sleep(100);
}

async function seedUser(handle) {
  await q("DELETE FROM users WHERE handle=$1", [handle]);
  const { rows } = await q("INSERT INTO users(handle) VALUES ($1) RETURNING id", [handle]);
  const token = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
    [rows[0].id, sha256(token)]);
  return { id: rows[0].id, handle, cookie: `dp_session=${token}` };
}

const api = async (base, user, method, p, body) => {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", cookie: user.cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const socket = (url, user, onData) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers: { cookie: user.cookie, ...(ORIGIN ? { origin: ORIGIN } : {}) } });
  ws.got = [];
  ws.on("close", (code) => { ws.closedWith = code; });
  ws.on("message", (d) => ws.got.push(onData(d)));
  ws.on("open", () => resolve(ws));
  ws.on("error", reject);
});

const alice = await seedUser("cl_alice");
const bob = await seedUser("cl_bob");
const { rows: [dev] } = await q(
  `INSERT INTO devices(user_id, name, registration_id, identity_key) VALUES ($1,'cl',$2,$3) RETURNING id`,
  [alice.id, 1 + Math.floor(Math.random() * 1e6), crypto.randomBytes(32)]);

const ch = (await api(A, alice, "POST", "/api/channels", { slug: "cl-" + crypto.randomBytes(3).toString("hex") })).json;
await q("INSERT INTO channel_members(channel_id, user_id) VALUES ($1,$2)", [ch.id, bob.id]);
const gid = crypto.randomBytes(16).toString("base64");
await api(A, alice, "POST", "/api/mls/groups", { channelId: ch.id, groupId: gid, ciphersuite: "test" });
const post = (base) => api(base, alice, "POST", `/api/mls/groups/${encodeURIComponent(gid)}/messages`,
  { senderDeviceId: dev.id, kind: "application", payload: Buffer.from("x").toString("base64") });

for (const base of [A, B]) {
  const h = await (await fetch(base + "/api/health")).json();
  assert.equal(h.redis, "up", "nodes with a working Redis report it up");
  assert.equal(h.status, "ok");
}

// ------------------------------------------------------------ hints

const hintsAtB = await socket(B.replace(/^http/, "ws") + "/api/live", bob, (d) => JSON.parse(d));
await sleep(300);           // the subscription reaches Redis asynchronously
const first = await post(A);
assert.equal(first.status, 200, "post at A: " + JSON.stringify(first.json));
await sleep(300);
assert.deepEqual(hintsAtB.got, [{ t: "log", g: gid, s: first.json.seq }],
  "a hint for a message posted at node A reaches bob's socket at node B");
console.log("· hint posted at A delivered to a listener at B");

// ---------------------------------------------------------- presence

const room = `/api/mls/groups/${encodeURIComponent(gid)}/live`;
const pa = await socket(A.replace(/^http/, "ws") + room, alice, (d) => d.toString());
const pb = await socket(B.replace(/^http/, "ws") + room, bob, (d) => d.toString());
await sleep(300);
pa.send(Buffer.from("cursor-from-a"));
pb.send(Buffer.from("cursor-from-b"));
await sleep(300);
assert.deepEqual(pb.got, ["cursor-from-a"], "a frame sent at A reaches the peer at B");
assert.deepEqual(pa.got, ["cursor-from-b"], "and back, with no echo to either sender");
pa.close(); pb.close();
console.log("· presence frames cross nodes, not echoed");

// ------------------------------------------------ roster invalidation

// Posting at B caches the roster (alice, bob) at B.
await post(B);
await sleep(300);
hintsAtB.got.length = 0;
// Bob's presence socket at B must close as soon as he leaves at A.
const bobRoom = await socket(B.replace(/^http/, "ws") + room, bob, (d) => d.toString());
await sleep(200);
// Bob leaves through A; B must forget its roster now, not in 5 s.
const left = await api(A, bob, "POST", `/api/channels/${ch.id}/leave`, {});
assert.equal(left.status, 200, "bob leaves at A");
await sleep(200);
await post(B);
await sleep(300);
assert.deepEqual(hintsAtB.got, [], "a member who left at A must stop getting hints for messages posted at B");
hintsAtB.close();
console.log("· a membership change at A clears B's roster cache");
assert.equal(bobRoom.closedWith, 4403, "leaving at A closes bob's presence socket at B at once");
console.log("· leaving at A closes the leaver's presence socket at B at once");

// ------------------------------------------------ ending a session

// Alice signs in on a second browser, whose sockets land on B; she ends that
// session from the first, through A.
const other = crypto.randomBytes(32).toString("base64url");
const { rows: [second] } = await q(
  "INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour') RETURNING id",
  [alice.id, sha256(other)]);
const phone = { ...alice, cookie: `dp_session=${other}` };
const phoneHints = await socket(B.replace(/^http/, "ws") + "/api/live", phone, (d) => JSON.parse(d));
const phoneRoom = await socket(B.replace(/^http/, "ws") + room, phone, (d) => d.toString());
await sleep(200);
const ended = await api(A, alice, "POST", `/api/auth/sessions/${second.id}/revoke`, {});
assert.equal(ended.status, 200, "alice ends her other session at A");
await sleep(500);
assert.equal(phoneHints.closedWith, 4401, "the ended session's hint socket at B closes at once");
assert.equal(phoneRoom.closedWith, 4403, "and so does its presence socket");
console.log("· ending a session at A closes its sockets at B at once");

await q("DELETE FROM users WHERE handle = ANY($1)", [["cl_alice", "cl_bob"]]);
await pool.end();
nodeB.kill("SIGTERM");
console.log("\nALL CLUSTER ASSERTIONS PASSED");
