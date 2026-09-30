import fs from "node:fs";
import { pool, q } from "./db.js";
import { migrationFiles } from "./config.js";

await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
)`);

const applied = new Set(
  (await q("SELECT name FROM schema_migrations")).rows.map((r) => r.name)
);

let ran = 0;
for (const { name: f, path: file } of migrationFiles()) {
  if (applied.has(f)) continue;
  const sql = fs.readFileSync(file, "utf8");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(sql);
    await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    await c.query("COMMIT");
    console.log("applied", f);
    ran++;
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("FAILED", f, "-", e.message);
    process.exit(1);
  } finally {
    c.release();
  }
}
console.log(ran ? `${ran} migration(s) applied` : "already up to date");
await pool.end();
