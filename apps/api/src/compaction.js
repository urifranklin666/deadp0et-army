import { q, tx } from "./db.js";

/**
 * Prune log entries every active device has already applied.
 *
 * Safety rules, in order of importance:
 *  1. Never delete above the slowest ACTIVE device's cursor. Those messages
 *     are unrecoverable once gone — MLS decrypts an application message once.
 *  2. Never delete commits. They are few and small, and a member replaying
 *     epochs needs them; only application messages are pruned.
 *  3. Always leave the most recent messages alone (KEEP_TAIL), so a device
 *     that is merely mid-poll is never raced.
 */

export const STALE_DEVICE_DAYS = 30;
const KEEP_TAIL = 50;

export async function compactGroup(groupId) {
  return tx(async (c) => {
    // Only devices whose owner is still a member count. A removed member's
    // frozen cursor would otherwise pin the log for STALE_DEVICE_DAYS.
    const { rows: bound } = await c.query(
      `SELECT
         COALESCE(MIN(cur.last_seq), 0) AS horizon,
         count(*)::int                  AS active_devices
       FROM mls_device_cursors cur
       JOIN devices d          ON d.id = cur.device_id
       JOIN mls_groups g       ON g.group_id = cur.group_id
       JOIN channel_members cm ON cm.channel_id = g.channel_id AND cm.user_id = d.user_id
       WHERE cur.group_id = $1
         AND cur.updated_at > now() - ($2 || ' days')::interval`,
      [groupId, STALE_DEVICE_DAYS]
    );

    // No active device has reported yet: nothing is provably delivered.
    if (!bound[0].active_devices) return { pruned: 0, horizon: 0, reason: "no active devices" };

    const { rows: tail } = await c.query(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM mls_messages WHERE group_id = $1`, [groupId]);
    const horizon = Math.min(Number(bound[0].horizon), Math.max(0, Number(tail[0].max_seq) - KEEP_TAIL));
    if (horizon <= 0) return { pruned: 0, horizon: 0, reason: "nothing safely below the horizon" };

    const del = await c.query(
      `DELETE FROM mls_messages
        WHERE group_id = $1 AND seq <= $2 AND kind = 'application'`,
      [groupId, horizon]);

    if (del.rowCount) {
      await c.query(
        `UPDATE mls_groups
            SET compaction_watermark = GREATEST(compaction_watermark, $2),
                compacted_at = now()
          WHERE group_id = $1`, [groupId, horizon]);
    }
    return { pruned: del.rowCount, horizon, activeDevices: bound[0].active_devices };
  });
}

/** Sweep every group that has grown enough to be worth touching. */
export async function compactAll(log) {
  const { rows } = await q(
    `SELECT g.group_id, count(m.seq)::int AS n
       FROM mls_groups g
       JOIN mls_messages m ON m.group_id = g.group_id AND m.kind = 'application'
      GROUP BY g.group_id
     HAVING count(m.seq) > $1`, [KEEP_TAIL]);

  let total = 0;
  for (const r of rows) {
    try {
      const res = await compactGroup(r.group_id);
      total += res.pruned;
      if (res.pruned) log?.info({ pruned: res.pruned, horizon: res.horizon }, "compacted group log");
    } catch (e) {
      log?.error({ err: e }, "compaction failed for group");
    }
  }
  return total;
}
