import { q } from "./db.js";

/**
 * Delete what the server no longer has any reason to hold.
 *
 * Every read path already filters out expired rows, so nothing here changes
 * what a client sees — it changes what a database leak or a subpoena finds.
 * For a relay whose whole claim is "we keep as little as possible", rows that
 * are merely hidden are not good enough.
 *
 * Deliberately conservative about the ordered MLS log: commits are never
 * deleted here (members replaying epochs need them; compaction owns the log),
 * and only application messages past their own expires_at go.
 */

// Acked envelopes have been decrypted by their one recipient; the grace
// period only covers a client that acks and then crashes before persisting.
export const DELIVERED_GRACE_HOURS = 24;
// A Welcome is only needed until the device joins; keep a while for debugging
// a failed join, then drop it.
export const WELCOME_KEEP_DAYS = 7;
// A claimed KeyPackage is only needed to validate the Welcome that follows it.
export const CLAIMED_KP_KEEP_DAYS = 30;

const SWEEPS = [
  ["sessions", `DELETE FROM sessions WHERE expires_at <= now()`],
  ["envelopes_expired", `DELETE FROM envelopes WHERE expires_at IS NOT NULL AND expires_at <= now()`],
  ["envelopes_delivered",
    `DELETE FROM envelopes
      WHERE delivered_at IS NOT NULL
        AND delivered_at < now() - make_interval(hours => ${DELIVERED_GRACE_HOURS})`],
  ["mls_messages_expired",
    `DELETE FROM mls_messages
      WHERE kind = 'application' AND expires_at IS NOT NULL AND expires_at <= now()`],
  ["mls_welcomes_delivered",
    `DELETE FROM mls_welcomes
      WHERE delivered_at IS NOT NULL
        AND delivered_at < now() - make_interval(days => ${WELCOME_KEEP_DAYS})`],
  ["mls_key_packages_claimed",
    `DELETE FROM mls_key_packages
      WHERE claimed_at IS NOT NULL
        AND claimed_at < now() - make_interval(days => ${CLAIMED_KP_KEEP_DAYS})`],
];

/** Run every sweep; one failing table does not stop the others. */
export async function sweepExpired(log) {
  const out = {};
  for (const [name, sql] of SWEEPS) {
    try {
      out[name] = (await q(sql)).rowCount;
    } catch (err) {
      log?.error({ err, sweep: name }, "retention sweep failed");
      out[name] = null;
    }
  }
  const total = Object.values(out).reduce((a, n) => a + (n || 0), 0);
  if (total) log?.info(out, "retention sweep");
  return out;
}
