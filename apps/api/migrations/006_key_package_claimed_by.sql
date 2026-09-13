-- Record who claimed a KeyPackage so that the Welcome riding on the add
-- commit can be checked against the claim. Before this, any member could
-- attach a Welcome for any device (learned from the claim response) to any
-- message kind, re-granting channel membership to a removed user.
ALTER TABLE mls_key_packages ADD COLUMN IF NOT EXISTS claimed_by uuid REFERENCES users(id) ON DELETE SET NULL;
