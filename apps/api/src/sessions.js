import { q } from "./db.js";
import { sha256 } from "./config.js";

/** The live session behind a cookie value: { id, handle }, or null. */
export async function sessionUser(token) {
  if (!token) return null;
  const { rows } = await q(
    `SELECT u.id, u.handle FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] ?? null;
}
