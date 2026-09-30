-- Step-up authentication: when this session last re-proved its passkey.
-- Adding or removing a passkey, or deleting the account, needs a recent one:
-- a stolen session cookie alone must not become a permanent takeover.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reauthed_at timestamptz;

-- A device that found itself removed from a group's encryption (a commit it
-- applied took its leaf away) reports it here. While the roster still lists
-- its owner, owner/admin clients re-add exactly these devices.
ALTER TABLE mls_group_devices ADD COLUMN IF NOT EXISTS evicted_at timestamptz;
