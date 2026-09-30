import "./env.js";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing — is .env present at the repo root?");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 16,
  idleTimeoutMillis: 30_000,
});

export const q = (text, params) => pool.query(text, params);

/** Run fn inside a transaction, rolling back on any throw. */
export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
