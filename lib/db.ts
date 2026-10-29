import "server-only";
import { Pool, type QueryResultRow } from "pg";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://resourceos_app:app_dev_password@localhost:5432/resourceos";

const globalForDb = globalThis as unknown as { resourceOsPool?: Pool };

export const pool =
  globalForDb.resourceOsPool ??
  new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.resourceOsPool = pool;
}

export type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

/**
 * Runs a unit of work with the tenant GUC set for the transaction.
 * PostgreSQL RLS policies read `app.current_organization_id`, so a query that
 * forgets its organization_id filter still cannot see another tenant's rows.
 */
export async function withOrg<T>(organizationId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [organizationId]);

    // A pooled client cannot run two queries at once. Queue them so callers can
    // use Promise.all without triggering pg's concurrent-query path.
    let queue: Promise<unknown> = Promise.resolve();
    const query: Queryable["query"] = (text, params) => {
      const run = queue.then(() => client.query(text, params as never[]));
      queue = run.catch(() => {});
      return run;
    };

    const result = await fn({ query });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

export function isExclusionViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23P01";
}

function isDeadlock(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "40P01";
}

/**
 * The overlap constraint rejects the loser of a race with 23P01. Under heavy
 * simultaneous contention PostgreSQL can instead abort one transaction with a
 * deadlock (40P01); both mean "somebody else already holds this window".
 * tests/tenancy.test.mjs exercises both paths.
 */
export function isBookingConflict(error: unknown): boolean {
  return isExclusionViolation(error) || isDeadlock(error);
}
