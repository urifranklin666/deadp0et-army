import { q } from "./db.js";

/**
 * Delete what the read paths already ignore.
 *
 * Every query filters on expires_at / delivered_at / claimed_at, so nothing
 * here changes what a client can see; it only stops the tables growing
 * without bound. Commits are never touched: the epoch chain needs them, and
 * the message route refuses to give a commit an expiry in the first place.
 */
export const SWEEP_MS = 60 * 60 * 1000;

const STEPS = [
  ["sessions", "DELETE FROM sessions WHERE expires_at < now()"],
  ["mls_messages", "DELETE FROM mls_messages WHERE kind = 'application' AND expires_at IS NOT NULL AND expires_at < now()"],
  ["envelopes", "DELETE FROM envelopes WHERE expires_at IS NOT NULL AND expires_at < now()"],
  // A delivered Welcome has been acked by the device that joined; keep it a
  // week in case that device is restored from a backup taken in between.
  ["mls_welcomes", "DELETE FROM mls_welcomes WHERE delivered_at IS NOT NULL AND delivered_at < now() - interval '7 days'"],
  // A claimed KeyPackage is referenced by the Welcome check for the commit
  // that follows the claim, which happens within seconds; 30 days is ample.
  ["mls_key_packages", "DELETE FROM mls_key_packages WHERE claimed_at IS NOT NULL AND claimed_at < now() - interval '30 days'"],
];

export async function sweep(log) {
  const out = {};
  for (const [table, sql] of STEPS) {
    try { out[table] = (await q(sql)).rowCount; }
    catch (e) { log?.error({ err: e, table }, "sweep failed"); }
  }
  if (Object.values(out).some(Boolean)) log?.info(out, "swept expired rows");
  return out;
}
