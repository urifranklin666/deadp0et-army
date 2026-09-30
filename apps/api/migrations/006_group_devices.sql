-- Which devices hold a leaf in which MLS group.
--
-- Inviting a user claims one KeyPackage per device of theirs. Without knowing
-- which of those devices are already in the group, an invite re-adds them —
-- duplicate leaves for one device — and a user can't bring just their NEW
-- device into a group. Rows are written when a device founds a group or is
-- welcomed into one, and dropped when its user's access is revoked.

CREATE TABLE IF NOT EXISTS mls_group_devices (
  group_id  bytea NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  device_id uuid  NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, device_id)
);

-- Backfill from what the server already knew: welcomes and delivery cursors
-- — but only for devices whose owner is still a member of the channel.
-- Someone welcomed and later removed would otherwise read as "already in the
-- group", and could never be invited back.
INSERT INTO mls_group_devices(group_id, device_id)
  SELECT s.group_id, s.device_id
    FROM (SELECT group_id, target_device_id AS device_id FROM mls_welcomes
          UNION
          SELECT group_id, device_id FROM mls_device_cursors) s
    JOIN devices d ON d.id = s.device_id
    JOIN mls_groups g ON g.group_id = s.group_id
    JOIN channel_members m ON m.channel_id = g.channel_id AND m.user_id = d.user_id
ON CONFLICT DO NOTHING;
