// Applies the baseline schema (db/schema.sql) to an empty database, then every
// pending file in db/migrations in order, and grants the application role.
// Run as a privileged migration role, never as the application role.
import { Client } from "pg";
import { applyBaseline, applyMigrations, grantAppRole } from "./migration-runner.mjs";

const connectionString =
  process.env.ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/resourceos";
const appDatabaseUrl = process.env.DATABASE_URL ?? null;

const client = new Client({ connectionString });

try {
  await client.connect();
  await applyBaseline(client, { log: console.log });
  const applied = await applyMigrations(client, { log: console.log });
  await grantAppRole(client, appDatabaseUrl, { log: console.log });
  console.log(applied > 0 ? `Applied ${applied} migration(s).` : "Database is up to date.");
} catch (error) {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
