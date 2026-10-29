// Shared migration helpers used by migrate.mjs and reset.mjs.
//
// db/schema.sql is the frozen baseline (v1). Everything added afterwards lives
// in db/migrations/NNNN_*.sql and is recorded in schema_migrations, so an
// existing database can move forward without a destructive reset.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASELINE_ID = "0000_baseline";

export const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));

export function baselineSql() {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

export function migrationFiles() {
  if (!existsSync(migrationsDirectory)) return [];
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

export async function ensureMigrationsTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

export async function appliedMigrations(client) {
  await ensureMigrationsTable(client);
  const { rows } = await client.query("SELECT id FROM schema_migrations");
  return new Set(rows.map((row) => row.id));
}

/** Applies the baseline schema to an empty database, or records it as applied. */
export async function applyBaseline(client, { log = () => {} } = {}) {
  await ensureMigrationsTable(client);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
  );
  if (rows[0].n > 0) {
    await client.query(
      "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
      [BASELINE_ID],
    );
    return false;
  }
  await client.query(baselineSql());
  await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [BASELINE_ID]);
  log("Baseline schema applied.");
  return true;
}

/** Applies every migration not yet recorded. Each file runs in its own transaction. */
export async function applyMigrations(client, { log = () => {} } = {}) {
  const done = await appliedMigrations(client);
  let applied = 0;
  for (const file of migrationFiles()) {
    const id = file.replace(/\.sql$/, "");
    if (done.has(id)) continue;
    const sql = readFileSync(`${migrationsDirectory}${file}`, "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await client.query("COMMIT");
      log(`Applied migration ${id}.`);
      applied += 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${id} failed: ${error.message}`, { cause: error });
    }
  }
  return applied;
}

/**
 * Grants the application role its least-privilege table access.
 * Skipped when no DATABASE_URL is configured (Compose relies on db/init.sql).
 */
export async function grantAppRole(client, appDatabaseUrl, { log = () => {} } = {}) {
  if (!appDatabaseUrl) return false;
  const role = new URL(appDatabaseUrl).username;
  const quoted = client.escapeIdentifier(role);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoted}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoted}`,
  );
  log(`Granted table privileges to ${role}.`);
  return true;
}
