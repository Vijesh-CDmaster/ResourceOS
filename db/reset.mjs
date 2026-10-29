// DESTRUCTIVE: drops the public schema, re-applies db/schema.sql and every
// migration. Use only on a development database.
import { Client } from "pg";
import { applyBaseline, applyMigrations, grantAppRole } from "./migration-runner.mjs";

const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/resourceos";
const appUrl =
  process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";
const appRole = new URL(appUrl).username;

if (process.env.ALLOW_DB_RESET !== "yes") {
  console.error("Refusing to reset. Re-run with ALLOW_DB_RESET=yes to confirm this is a development database.");
  process.exit(1);
}

const client = new Client({ connectionString: adminUrl });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query("GRANT USAGE ON SCHEMA public TO " + client.escapeIdentifier(appRole));
  await client.query("COMMIT");

  await applyBaseline(client, { log: console.log });
  await applyMigrations(client, { log: console.log });
  await grantAppRole(client, appUrl, { log: console.log });
  // memberships is the tenant-assignment table; login must read it before a tenant is selected.
  await client.query("ALTER TABLE memberships DISABLE ROW LEVEL SECURITY");
  await client.query("DROP POLICY IF EXISTS tenant_isolation ON memberships");
  console.log("Schema reset. Run `npm run db:seed` to load the demo tenant.");
} catch (error) {
  console.error("Reset failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
