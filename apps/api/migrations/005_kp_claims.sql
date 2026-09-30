-- Bind each KeyPackage claim to its claimer and to at most one Welcome.
--
-- A Welcome grants channel membership, so the server checks that it names a
-- claimed KeyPackage. Without these columns that check could be satisfied
-- forever by one legitimate claim: any member holding an old (ref, device)
-- pair could replay it to pull the same user into channel after channel.
--
-- claimed_by also lets the claim endpoint cap how many packages one user may
-- hold, unused, against another — the drain that would make someone
-- uninvitable.

ALTER TABLE mls_key_packages
  ADD COLUMN IF NOT EXISTS claimed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS welcomed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_mls_kp_outstanding
  ON mls_key_packages(claimed_by, device_id)
  WHERE claimed_at IS NOT NULL AND welcomed_at IS NULL;
