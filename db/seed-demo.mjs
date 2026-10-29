// Seeds the synthetic demo tenant used by the capital-decision workflow.
//
// This is the ONLY demo seeding entry point, and it is deliberately hard to
// point at a real database:
//
//   1. It requires DEMO_SEED_CONFIRM=yes.
//   2. The target database name must end in _demo or _test.
//   3. It refuses to run against the default application database name.
//   4. It only INSERTs; it never truncates, drops or reseeds existing data.
//   5. It refuses if the demo tenant already exists, so it cannot overwrite it.
//
// Usage:
//   DEMO_SEED_CONFIRM=yes DATABASE_URL=postgres://.../resourceos_demo \
//     node --env-file=.env.local db/seed-demo.mjs
import { Client } from "pg";
import { seedDemoTenant, DEMO_ORG_SLUG, DEMO_PASSWORD } from "./demo-seed.mjs";

const connectionString = process.env.DEMO_DATABASE_URL ?? process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

function guard(url) {
  if (!url) return "No database URL configured (set DEMO_DATABASE_URL or ADMIN_DATABASE_URL).";
  if (process.env.DEMO_SEED_CONFIRM !== "yes") {
    return "Refusing to seed. Re-run with DEMO_SEED_CONFIRM=yes to confirm this is a disposable demo database.";
  }
  const name = databaseName(url);
  if (!name) return "Could not read the database name from the connection URL.";
  if (/^(postgres|template0|template1)$/.test(name)) return `Refusing to seed the "${name}" database.`;
  if (!/(_demo|_test)$/.test(name)) {
    return `Refusing to seed "${name}". The demo seeder only runs against a database whose name ends in _demo or _test, so it cannot touch an operational database.`;
  }
  return null;
}

const problem = guard(connectionString);
if (problem) {
  console.error(problem);
  console.error("\nCreate a disposable database first, for example:");
  console.error("  createdb resourceos_demo");
  console.error("  DATABASE_URL=postgres://resourceos_app:...@localhost:5432/resourceos_demo npm run db:migrate");
  process.exit(1);
}

console.log(`Seeding demo tenant into "${databaseName(connectionString)}".`);
const client = new Client({ connectionString });

try {
  await client.connect();
  const { organizationId, counts } = await seedDemoTenant(client, { log: console.log });
  console.log("");
  console.log(`Organization id: ${organizationId}`);
  console.log(`Demo tenant slug: ${DEMO_ORG_SLUG}`);
  console.log(`Sign in with any demo account, password: ${DEMO_PASSWORD}`);
  console.log("Example accounts: nandita.rao@northfield.demo (administrator), ishaan.mehta@northfield.demo (manager)");
  console.log(`Totals: ${JSON.stringify(counts)}`);
  console.log("");
  console.log("This tenant is synthetic. Every record is labelled as demo data in the UI.");
} catch (error) {
  console.error("Demo seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
