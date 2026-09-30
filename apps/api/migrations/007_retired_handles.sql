-- Handles of deleted accounts, never to be registered again.
--
-- Group members see each other by handle (the MLS credential). If a deleted
-- account's handle could be re-registered, a stranger could be invited into
-- a group as "alice" and read as the alice everyone knew.

CREATE TABLE IF NOT EXISTS retired_handles (
  handle     text PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now()
);
