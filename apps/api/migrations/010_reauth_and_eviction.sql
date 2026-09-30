-- Step-up authentication: when this session last re-proved its passkey.
-- Adding or removing a passkey, or deleting the account, needs a recent one:
-- a stolen session cookie alone must not become a permanent takeover.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reauthed_at timestamptz;

-- A device that found itself removed from a group's encryption (a commit it
-- applied took its leaf away) reports it here. While the roster still lists
-- its owner, owner/admin clients re-add exactly these devices.
ALTER TABLE mls_group_devices ADD COLUMN IF NOT EXISTS evicted_at timestamptz;
-- When this device last reported an eviction. Unlike evicted_at, a heal
-- doesn't reset it, so it can bound how often reports are honoured.
ALTER TABLE mls_group_devices ADD COLUMN IF NOT EXISTS eviction_reported_at timestamptz;

-- Start the signature-key directory over. Its first backfill registered keys
-- without checking the packages' signatures; registrations now require proof
-- of possession. Clearing it (and the backfill marker) lets the server refill
-- it from verified packages on the next start, and devices re-register their
-- own leaves, with proof, as they open groups.
DELETE FROM mls_signature_keys;
DELETE FROM schema_migrations WHERE name = 'backfill:009_signature_keys';
