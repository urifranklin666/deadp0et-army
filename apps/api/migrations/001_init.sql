-- DEADP0ET.ARMY — initial schema
--
-- Design rule this schema exists to enforce: the server is a dumb relay.
-- It stores PUBLIC key material (so devices can start sessions with each
-- other) and OPAQUE ciphertext (so it can route). It never sees a private
-- key, a plaintext message, or a canvas operation. Anything that would
-- break that property does not belong in this file.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle      text UNIQUE NOT NULL CHECK (handle ~ '^[a-z0-9_]{3,32}$'),
  display_name text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- WebAuthn/passkey credentials. No passwords exist in this system at all.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  bytea UNIQUE NOT NULL,
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,       -- sha256 of the cookie value, never the value
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- One row per physical device. registration_id + identity_key are the
-- Signal-protocol identity; the matching private key never leaves the device.
CREATE TABLE IF NOT EXISTS devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text,
  registration_id integer NOT NULL,
  identity_key    bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  UNIQUE (user_id, registration_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS signed_prekeys (
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id     integer NOT NULL,
  public_key bytea NOT NULL,
  signature  bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, key_id)
);

-- Consumed on handshake and never handed out twice; that is what makes the
-- initial X3DH message forward-secret.
CREATE TABLE IF NOT EXISTS one_time_prekeys (
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id      integer NOT NULL,
  public_key  bytea NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (device_id, key_id)
);
CREATE INDEX IF NOT EXISTS idx_otpk_available
  ON one_time_prekeys(device_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,48}$'),
  kind       text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','canvas')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

-- Opaque ciphertext. `body` is a Signal-protocol message the server cannot
-- read. Retention is enforced by expires_at, set from the channel policy.
CREATE TABLE IF NOT EXISTS envelopes (
  id               bigserial PRIMARY KEY,
  channel_id       uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  target_device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  msg_type         smallint NOT NULL,
  body             bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  expires_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_envelopes_target
  ON envelopes(target_device_id, id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_envelopes_expiry ON envelopes(expires_at);

-- Yjs CRDT state for the collaborative canvas, stored encrypted under a key
-- the server does not hold. `state` is ciphertext, not a readable Y.Doc.
CREATE TABLE IF NOT EXISTS canvas_docs (
  channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  state      bytea NOT NULL,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
