-- Which account each MLS signature key belongs to.
--
-- A leaf's credential is just a name its owner wrote, and a member running a
-- modified client can rewrite it in a later commit. A leaf's signature key
-- can't be faked the same way: every message the leaf sends is signed with
-- it. So clients attribute messages by looking the SIGNING KEY up here —
-- recorded when the key's KeyPackage was uploaded by an authenticated user —
-- rather than trusting the credential.
--
-- Separate from mls_key_packages because claimed packages are swept after a
-- while, and attribution must outlive that. Goes with the account.

CREATE TABLE IF NOT EXISTS mls_signature_keys (
  signature_key bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
