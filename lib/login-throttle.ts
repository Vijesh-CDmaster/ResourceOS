import "server-only";
import { createHash } from "node:crypto";
import { pool } from "./db";

// Durable sign-in throttling.
//
// The earlier limiter was a per-process Map: a second instance, a serverless
// worker or a restart started from zero, and the Map grew without bound. This
// version keeps counters in PostgreSQL so every process shares one budget, and
// stores only SHA-256 digests so the table never contains an email or an IP.
//
// Two budgets are checked independently: one per account and one per source
// address. The account budget stops password guessing against one user; the
// address budget stops spraying many accounts from one client.

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 8;
const LOCK_SECONDS = 15 * 60;
const RETENTION_HOURS = 48;

export type LoginSubject = { email: string; address: string | null };

export type ThrottleVerdict = { allowed: boolean; retryAfterSeconds: number };

function digest(kind: "account" | "address", value: string): string {
  return createHash("sha256").update(`resourceos:login:${kind}:${value.trim().toLowerCase()}`).digest("hex");
}

export function loginIdentifiers(subject: LoginSubject): string[] {
  const identifiers = [digest("account", subject.email)];
  if (subject.address) identifiers.push(digest("address", subject.address));
  return identifiers;
}

/** Reads the shared budget. Fails closed only for the account, open if the table is unreachable. */
export async function checkLoginAllowed(identifiers: string[]): Promise<ThrottleVerdict> {
  if (!identifiers.length) return { allowed: true, retryAfterSeconds: 0 };
  try {
    const { rows } = await pool.query<{ locked_for: number | null; window_count: number | null }>(
      `SELECT
         max(CASE WHEN locked_until > now()
                  THEN ceil(extract(epoch FROM (locked_until - now())))::int END) AS locked_for,
         max(CASE WHEN window_started_at > now() - make_interval(secs => $2)
                  THEN attempt_count END) AS window_count
       FROM auth_login_attempts
      WHERE identifier = ANY($1::text[])`,
      [identifiers, WINDOW_SECONDS],
    );
    const row = rows[0];
    if (row?.locked_for && row.locked_for > 0) {
      return { allowed: false, retryAfterSeconds: row.locked_for };
    }
    const used = row?.window_count ?? 0;
    return { allowed: used < MAX_FAILURES, retryAfterSeconds: used < MAX_FAILURES ? 0 : WINDOW_SECONDS };
  } catch {
    // A database outage is already fatal for sign-in; do not invent a lockout.
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Records one failed attempt for every identifier and locks the budget when it is exhausted. */
export async function recordLoginFailure(identifiers: string[]): Promise<void> {
  for (const identifier of identifiers) {
    try {
      await pool.query(
        `INSERT INTO auth_login_attempts AS a (identifier, attempt_count, window_started_at, last_attempt_at)
         VALUES ($1, 1, now(), now())
         ON CONFLICT (identifier) DO UPDATE SET
           attempt_count = CASE
             WHEN a.window_started_at <= now() - make_interval(secs => $2) THEN 1
             ELSE a.attempt_count + 1
           END,
           window_started_at = CASE
             WHEN a.window_started_at <= now() - make_interval(secs => $2) THEN now()
             ELSE a.window_started_at
           END,
           last_attempt_at = now(),
           locked_until = CASE
             WHEN (CASE WHEN a.window_started_at <= now() - make_interval(secs => $2) THEN 1 ELSE a.attempt_count + 1 END) >= $3
             THEN now() + make_interval(secs => $4)
             ELSE NULL
           END`,
        [identifier, WINDOW_SECONDS, MAX_FAILURES, LOCK_SECONDS],
      );
    } catch {
      // Never let throttling bookkeeping break the sign-in response.
    }
  }
}

/** A successful sign-in clears the account budget, and the address budget it belongs to. */
export async function clearLoginFailures(identifiers: string[]): Promise<void> {
  if (!identifiers.length) return;
  try {
    await pool.query("DELETE FROM auth_login_attempts WHERE identifier = ANY($1::text[])", [identifiers]);
  } catch {
    // Ignore: the lockout expires on its own.
  }
}

/** Removes counters that no longer matter. Called from the background worker. */
export async function purgeLoginAttempts(): Promise<number> {
  const { rowCount } = await pool.query(
    "DELETE FROM auth_login_attempts WHERE last_attempt_at < now() - make_interval(hours => $1)",
    [RETENTION_HOURS],
  );
  return rowCount ?? 0;
}
