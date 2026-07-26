-- Log compaction.
--
-- The server cannot inspect payloads, so it cannot know which messages a
-- snapshot supersedes. Compaction is therefore driven by DELIVERY: a message
-- every device has already applied is dead weight, and one a device has not
-- applied can never be recovered, because MLS application messages decrypt
-- exactly once. Pruning is bounded by the slowest active device.
--
-- A device that stops reporting would otherwise pin the log forever, so
-- devices silent past a cutoff are excluded from the bound. Anything pruned
-- past such a device is unrecoverable for it — hence compaction_watermark,
-- which lets the server tell a returning client "you have a gap" so it can
-- ask the group for a fresh canvas snapshot instead of silently diverging.

CREATE TABLE IF NOT EXISTS mls_device_cursors (
  group_id   bytea NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  device_id  uuid  NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  last_seq   bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_mls_cursors_group ON mls_device_cursors(group_id, last_seq);

-- Highest seq removed by compaction. A client asking for anything at or below
-- this has missed messages permanently.
ALTER TABLE mls_groups
  ADD COLUMN IF NOT EXISTS compaction_watermark bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compacted_at timestamptz;
