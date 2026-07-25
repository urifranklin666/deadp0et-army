-- MLS delivery service (RFC 9420).
--
-- The server's entire job here is: store public KeyPackages, fan out opaque
-- MLSMessages, and impose a TOTAL ORDER on commits. That last one is the only
-- part that is subtle, and it is the reason mls_groups.epoch exists: two
-- members who commit against the same epoch must not both succeed, or the
-- group forks into two incompatible histories that can never be reconciled.
-- The guard is a conditional UPDATE ... WHERE epoch = $expected (see routes).
--
-- As with the Signal tables, every payload column is ciphertext or public key
-- material. The server cannot read a single application message.

-- Published KeyPackages. Claimed exactly once when a member is added, for the
-- same reason Signal one-time prekeys are: reuse weakens the join handshake.
CREATE TABLE IF NOT EXISTS mls_key_packages (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ciphersuite text NOT NULL,
  ref         bytea UNIQUE NOT NULL,   -- hash of the key package, for dedupe + welcome targeting
  key_package bytea NOT NULL,          -- opaque serialized KeyPackage
  claimed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mls_kp_available
  ON mls_key_packages(device_id) WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS mls_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid UNIQUE NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  group_id    bytea UNIQUE NOT NULL,   -- the MLS group identifier itself
  ciphersuite text NOT NULL,
  epoch       bigint NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The ordered log. `seq` is the delivery-service order every member replays.
CREATE TABLE IF NOT EXISTS mls_messages (
  seq              bigserial PRIMARY KEY,
  group_id         bytea NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  epoch            bigint NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('application','commit','proposal')),
  sender_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  payload          bytea NOT NULL,     -- opaque MLSMessage
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mls_msgs_group_seq ON mls_messages(group_id, seq);
CREATE INDEX IF NOT EXISTS idx_mls_msgs_expiry ON mls_messages(expires_at);

-- At most one commit may ever exist per (group, epoch). Even if the epoch
-- guard were bypassed, this constraint makes a fork impossible to persist.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mls_commit_per_epoch
  ON mls_messages(group_id, epoch) WHERE kind = 'commit';

-- Welcomes are addressed to a specific claimed KeyPackage, not to a user.
CREATE TABLE IF NOT EXISTS mls_welcomes (
  id               bigserial PRIMARY KEY,
  group_id         bytea NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  key_package_ref  bytea NOT NULL,
  target_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  payload          bytea NOT NULL,     -- opaque Welcome
  ratchet_tree     bytea,              -- optional, when not sent as an extension
  joined_at_seq    bigint,             -- replay application messages from here
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mls_welcomes_pending
  ON mls_welcomes(target_device_id) WHERE delivered_at IS NULL;
