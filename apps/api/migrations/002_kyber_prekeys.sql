-- PQXDH: libsignal requires a Kyber prekey in every bundle, so the initial
-- handshake is hybrid classical + post-quantum. Kyber1024 public keys are
-- ~1569 bytes, hence their own table rather than a column on signed_prekeys.
--
-- These are "last-resort" style: signed by the identity key and reusable,
-- so a device that runs dry can still be reached. Forward secrecy for the
-- first message still comes from the one-time X25519 prekey.

CREATE TABLE IF NOT EXISTS kyber_prekeys (
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id     integer NOT NULL,
  public_key bytea NOT NULL,
  signature  bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, key_id)
);
