-- What a user needs to recognise their own sessions in a list, and revoke
-- one they don't: which browser it came from, and when it was last used.
-- The user agent is the client's own claim; it is shown, never trusted.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_agent   text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
