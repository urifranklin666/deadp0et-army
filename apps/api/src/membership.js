/**
 * End a user's access to a channel: membership, their devices' delivery
 * cursors (so they stop pinning compaction), and any Welcome still waiting
 * for one of their devices (so a second device can't join after the fact).
 *
 * The one revocation used by removal, leaving, and anything added later —
 * two hand-written copies had already drifted apart.
 */
export async function revokeAccess(c, channelId, userId) {
  await c.query("DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2", [channelId, userId]);
  await c.query(
    `DELETE FROM mls_device_cursors
      WHERE device_id IN (SELECT id FROM devices WHERE user_id = $2)
        AND group_id IN (SELECT group_id FROM mls_groups WHERE channel_id = $1)`,
    [channelId, userId]);
  await c.query(
    `DELETE FROM mls_welcomes
      WHERE delivered_at IS NULL
        AND target_device_id IN (SELECT id FROM devices WHERE user_id = $2)
        AND group_id IN (SELECT group_id FROM mls_groups WHERE channel_id = $1)`,
    [channelId, userId]);
}
