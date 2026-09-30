import { q } from "./db.js";
import { sha256 } from "./config.js";

/**
 * The live session behind a cookie value: { id, handle, sessionId }, or null.
 * Also notes when the session was last used, at most every few minutes, so
 * the sessions list can show it without a write on every request.
 */
export async function sessionUser(token) {
  if (!token) return null;
  const { rows } = await q(
    `SELECT u.id, u.handle, s.id AS "sessionId", s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    await q("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.sessionId]).catch(() => {});
  }
  return { id: row.id, handle: row.handle, sessionId: row.sessionId };
}
