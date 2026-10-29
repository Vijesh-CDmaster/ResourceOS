// Integration sync engine.
//
// Deliberately dependency-free at runtime (only `import type`), so it can be
// exercised directly by node:test and reused by the cron worker. Database access
// is injected as a tenant-scoped runner, which keeps RLS context correct and
// makes the engine impossible to point at another institution by accident.

import type {
  Connector,
  ConnectorContext,
  ConnectorCredentials,
  IntegrationEntity,
  MapResult,
  RawRecord,
} from "./types";

export type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
export type Queryable = { query(text: string, params?: unknown[]): Promise<QueryResult> };

/** Runs a unit of work with the tenant GUC set. The app passes `withOrg`. */
export type TenantRunner = <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;

export type SyncMode = "incremental" | "full" | "retry";

export type SyncCounts = {
  imported: number;
  updated: number;
  duplicates: number;
  quarantined: number;
  failed: number;
};

export type SyncResult = SyncCounts & {
  runId: string;
  /** `partial` means the page cap stopped the run with source records unread. */
  status: "succeeded" | "failed" | "partial";
  cursorAfter: string | null;
  error?: string;
  /** Operator-facing explanation for a partial run. */
  note?: string;
};

export type SyncErrorCode =
  | "connection_not_found"
  | "connection_revoked"
  | "connector_mismatch"
  | "connector_failed";

export class IntegrationSyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "IntegrationSyncError";
    this.code = code;
  }
}

type QuarantineReason = "validation" | "conflict" | "error";

class RecordQuarantine extends Error {
  readonly reason: QuarantineReason;

  constructor(reason: QuarantineReason, message: string) {
    super(message);
    this.name = "RecordQuarantine";
    this.reason = reason;
  }
}

type ConnectionRow = {
  id: string;
  provider: string;
  status: "active" | "revoked";
  config: Record<string, unknown>;
  checkpoint: string | null;
  credentials_ciphertext: string | null;
};

type ResourceMap = Extract<MapResult, { ok: true; entityType: "resource" }>;
type BookingMap = Extract<MapResult, { ok: true; entityType: "booking" }>;

export type RunSyncOptions = {
  organizationId: string;
  connectionId: string;
  actorId: string | null;
  connector: Connector;
  withTenant: TenantRunner;
  mode?: SyncMode;
  /** Provided by the app (decrypts with the server key). Omitted in tests. */
  decryptCredentials?: (sealed: string | null) => ConnectorCredentials | null;
  /** Defensive page cap so one run cannot spin forever. */
  maxPages?: number;
  /** Retry policy for flaky provider calls. */
  pullAttempts?: number;
  retryDelayMs?: number;
  log?: (message: string) => void;
};

async function rowsOf<T>(db: Queryable, text: string, params?: unknown[]): Promise<T[]> {
  const result = await db.query(text, params);
  return result.rows as unknown as T[];
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function isSlotConflict(error: unknown): boolean {
  return isErrorCode(error, "23P01") || isErrorCode(error, "40P01");
}

function isUniqueViolation(error: unknown): boolean {
  return isErrorCode(error, "23505");
}

function sanitize(message: string, secrets: string[] = []): string {
  let safe = message;
  // Provider errors sometimes echo the token that was rejected. Anything we
  // know to be a secret is removed before the text is persisted or shown.
  for (const secret of secrets) {
    if (secret.length >= 4) safe = safe.split(secret).join("[redacted]");
  }
  return safe.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** A connector may mark an error as permanent (bad cursor, 401) to stop retries. */
function isNonRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === false
  );
}

function describeIssues(issues: { field: string; message: string }[]): string {
  return issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ").slice(0, 500);
}

function padHour(hour: number): string {
  return `${String(Math.min(23, Math.max(0, Math.trunc(hour)))).padStart(2, "0")}:00`;
}

async function quarantine(
  ctx: IngestContext,
  input: {
    entityType: IntegrationEntity;
    externalId: string;
    reason: QuarantineReason;
    message: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.withTenant((db) =>
    db.query(
      `INSERT INTO integration_quarantine
         (organization_id, connection_id, sync_run_id, entity_type, external_id, reason, message, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (connection_id, entity_type, external_id, reason) DO UPDATE
         SET attempts = integration_quarantine.attempts + 1,
             last_seen_at = now(),
             sync_run_id = EXCLUDED.sync_run_id,
             message = EXCLUDED.message,
             payload = EXCLUDED.payload,
             resolved_at = NULL,
             resolved_run_id = NULL`,
      [
        ctx.organizationId,
        ctx.connectionId,
        ctx.runId,
        input.entityType,
        input.externalId,
        input.reason,
        sanitize(input.message, ctx.secrets),
        JSON.stringify(input.payload ?? {}),
      ],
    ),
  );
}

async function resolveQuarantine(
  ctx: IngestContext,
  entityType: IntegrationEntity,
  externalId: string,
): Promise<void> {
  await ctx.withTenant((db) =>
    db.query(
      `UPDATE integration_quarantine
          SET resolved_at = now(), resolved_run_id = $4
        WHERE connection_id = $1 AND entity_type = $2 AND external_id = $3 AND resolved_at IS NULL`,
      [ctx.connectionId, entityType, externalId, ctx.runId],
    ),
  );
}

type IngestContext = {
  organizationId: string;
  connectionId: string;
  runId: string;
  connector: Connector;
  connectorContext: ConnectorContext;
  withTenant: TenantRunner;
  /** Decrypted credential values, stripped from any message before it is stored. */
  secrets: string[];
};

async function ingestResource(db: Queryable, mapped: ResourceMap, ctx: IngestContext): Promise<"imported" | "updated"> {
  const data = mapped.data;
  const code = data.code.trim().toUpperCase();
  const name = data.name.trim();
  if (!code || !name) throw new RecordQuarantine("validation", "Resource code and name are required.");

  const capacity = Number.isFinite(data.capacity) ? Math.max(1, Math.trunc(data.capacity as number)) : 1;
  const maxHours = Number.isFinite(data.maxHours) ? Math.max(0.5, data.maxHours as number) : 4;
  const status = data.status ?? "ready";

  const linked = await rowsOf<{ id: string; status: string }>(
    db,
    "SELECT id, status FROM resources WHERE source_connection_id = $1 AND source_external_id = $2",
    [ctx.connectionId, mapped.externalId],
  );

  let internalId: string;
  let outcome: "imported" | "updated";

  if (linked[0]) {
    internalId = linked[0].id;
    // Local operational holds win over a source refresh.
    const effectiveStatus =
      linked[0].status === "maintenance" || linked[0].status === "suspended" ? linked[0].status : status;
    await db.query(
      `UPDATE resources
          SET name = $2, category = $3, description = $4, location = $5, capacity = $6,
              status = $7, requires_approval = $8, max_hours_per_booking = $9
        WHERE id = $1`,
      [
        internalId,
        name,
        data.category ?? "General",
        data.description ?? "",
        data.location ?? "",
        capacity,
        effectiveStatus,
        Boolean(data.requiresApproval),
        maxHours,
      ],
    );
    outcome = "updated";
  } else {
    const sameCode = await rowsOf<{ id: string }>(db, "SELECT id FROM resources WHERE code = $1", [code]);
    if (sameCode[0]) {
      throw new RecordQuarantine(
        "conflict",
        `Resource code ${code} already exists and is not linked to external id ${mapped.externalId}.`,
      );
    }

    const organization = await rowsOf<{ open_hour: number; close_hour: number }>(
      db,
      "SELECT open_hour, close_hour FROM organizations WHERE id = $1",
      [ctx.organizationId],
    );
    const hours = organization[0] ?? { open_hour: 9, close_hour: 18 };
    const opensAt = padHour(hours.open_hour);
    const closesAt = padHour(hours.close_hour > hours.open_hour ? hours.close_hour : 18);

    const inserted = await rowsOf<{ id: string }>(
      db,
      `INSERT INTO resources
         (organization_id, code, name, category, description, location, capacity, status,
          requires_approval, max_hours_per_booking, source_connection_id, source_external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        ctx.organizationId,
        code,
        name,
        data.category ?? "General",
        data.description ?? "",
        data.location ?? "",
        capacity,
        status,
        Boolean(data.requiresApproval),
        maxHours,
        ctx.connectionId,
        mapped.externalId,
      ],
    );
    internalId = inserted[0].id;

    for (let weekday = 1; weekday <= 6; weekday += 1) {
      await db.query(
        `INSERT INTO availability_rules (organization_id, resource_id, weekday, opens_at, closes_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (resource_id, weekday) DO NOTHING`,
        [ctx.organizationId, internalId, weekday, opensAt, closesAt],
      );
    }
    outcome = "imported";
  }

  await db.query(
    `INSERT INTO integration_entity_map (organization_id, connection_id, entity_type, external_id, internal_id)
     VALUES ($1, $2, 'resource', $3, $4)
     ON CONFLICT (connection_id, entity_type, external_id)
     DO UPDATE SET internal_id = EXCLUDED.internal_id, updated_at = now()`,
    [ctx.organizationId, ctx.connectionId, mapped.externalId, internalId],
  );

  return outcome;
}

async function ingestBooking(
  db: Queryable,
  mapped: BookingMap,
  ctx: IngestContext,
): Promise<"imported" | "duplicates"> {
  const data = mapped.data;
  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new RecordQuarantine("validation", "startsAt and endsAt must be ISO 8601 timestamps.");
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new RecordQuarantine("validation", "endsAt must be after startsAt.");
  }

  let resourceId: string | null = null;
  if (data.resourceExternalId) {
    const mappedResource = await rowsOf<{ internal_id: string }>(
      db,
      `SELECT internal_id FROM integration_entity_map
        WHERE connection_id = $1 AND entity_type = 'resource' AND external_id = $2`,
      [ctx.connectionId, data.resourceExternalId],
    );
    resourceId = mappedResource[0]?.internal_id ?? null;
  } else if (data.resourceCode) {
    const byCode = await rowsOf<{ id: string; status: string }>(
      db,
      "SELECT id, status FROM resources WHERE code = $1",
      [data.resourceCode.trim().toUpperCase()],
    );
    if (byCode[0]?.status === "retired") {
      throw new RecordQuarantine("conflict", `Resource ${data.resourceCode} is retired.`);
    }
    resourceId = byCode[0]?.id ?? null;
  }

  if (!resourceId) {
    throw new RecordQuarantine(
      "conflict",
      `Resource ${data.resourceExternalId ?? data.resourceCode ?? "(missing)"} is not known to this connection.`,
    );
  }

  const member = await rowsOf<{ id: string }>(
    db,
    `SELECT u.id
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE lower(u.email) = $1 AND m.organization_id = $2
      LIMIT 1`,
    [data.userEmail.trim().toLowerCase(), ctx.organizationId],
  );
  if (!member[0]) {
    // Prevents attributing a booking to a user outside this institution.
    throw new RecordQuarantine("validation", `User ${data.userEmail} is not a member of this institution.`);
  }

  const existing = await rowsOf<{ id: string }>(
    db,
    "SELECT id FROM bookings WHERE source_connection_id = $1 AND source_external_id = $2",
    [ctx.connectionId, mapped.externalId],
  );
  if (existing[0]) {
    // A booking is an event, not a projection: replaying it must not mutate it.
    return "duplicates";
  }

  const inserted = await rowsOf<{ id: string }>(
    db,
    `INSERT INTO bookings
       (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose, attendees,
        source_connection_id, source_external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      ctx.organizationId,
      resourceId,
      member[0].id,
      startsAt.toISOString(),
      endsAt.toISOString(),
      data.status ?? "confirmed",
      data.purpose ?? "Imported from an external system",
      Number.isFinite(data.attendees) ? Math.max(1, Math.trunc(data.attendees as number)) : 1,
      ctx.connectionId,
      mapped.externalId,
    ],
  );

  await db.query(
    `INSERT INTO integration_entity_map (organization_id, connection_id, entity_type, external_id, internal_id)
     VALUES ($1, $2, 'booking', $3, $4)`,
    [ctx.organizationId, ctx.connectionId, mapped.externalId, inserted[0].id],
  );

  return "imported";
}

async function ingestRecord(record: RawRecord, ctx: IngestContext): Promise<keyof SyncCounts> {
  const mapped = ctx.connector.map(record, ctx.connectorContext);

  if (!mapped.ok) {
    await quarantine(ctx, {
      entityType: record.entityType,
      externalId: record.externalId,
      reason: "validation",
      message: describeIssues(mapped.issues),
      payload: record.payload,
    });
    return "quarantined";
  }

  try {
    const outcome = await ctx.withTenant(async (db) => {
      const existing = await rowsOf<{ internal_id: string }>(
        db,
        `SELECT internal_id FROM integration_entity_map
          WHERE connection_id = $1 AND entity_type = $2 AND external_id = $3`,
        [ctx.connectionId, mapped.entityType, mapped.externalId],
      );
      // Bookings are immutable events once imported. Resources are refreshed so
      // a renamed or recategorised asset in the source system reaches ResourceOS.
      if (existing[0] && mapped.entityType === "booking") return "duplicates" as const;
      return mapped.entityType === "resource"
        ? await ingestResource(db, mapped, ctx)
        : await ingestBooking(db, mapped, ctx);
    });

    await resolveQuarantine(ctx, mapped.entityType, mapped.externalId);
    return outcome;
  } catch (error) {
    let reason: QuarantineReason = "error";
    if (error instanceof RecordQuarantine) reason = error.reason;
    else if (isSlotConflict(error)) reason = "conflict";
    else if (isUniqueViolation(error)) {
      // A concurrent run already ingested this record.
      return "duplicates";
    }

    const message =
      error instanceof RecordQuarantine
        ? error.message
        : reason === "conflict"
          ? "The requested slot is already held by another booking."
          : error instanceof Error
            ? error.message
            : "Record ingestion failed.";

    await quarantine(ctx, {
      entityType: record.entityType,
      externalId: record.externalId,
      reason,
      message,
      payload: record.payload,
    });
    return reason === "error" ? "failed" : "quarantined";
  }
}

async function pullWithRetry(
  connector: Connector,
  context: ConnectorContext,
  cursor: string | null,
  attempts: number,
  delayMs: number,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connector.pull(context, cursor);
    } catch (error) {
      lastError = error;
      // A permanent failure (bad cursor, rejected credential) is not retried.
      if (isNonRetryable(error)) throw error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

export async function runSync(options: RunSyncOptions): Promise<SyncResult> {
  const {
    organizationId,
    connectionId,
    actorId,
    connector,
    withTenant,
    mode = "incremental",
    decryptCredentials,
    maxPages = 20,
    pullAttempts = 2,
    retryDelayMs = 250,
    log = () => {},
  } = options;

  const { connection, previousRunStatus } = await withTenant(async (db) => {
    const found = await rowsOf<ConnectionRow>(
      db,
      `SELECT id, provider, status, config, checkpoint, credentials_ciphertext
         FROM integration_connections WHERE id = $1`,
      [connectionId],
    );
    const recent = await rowsOf<{ status: string }>(
      db,
      `SELECT status FROM integration_sync_runs
        WHERE connection_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [connectionId],
    );
    return { connection: found[0] ?? null, previousRunStatus: recent[0]?.status ?? null };
  });

  if (!connection) {
    throw new IntegrationSyncError("connection_not_found", "This integration connection does not exist for your institution.");
  }
  if (connection.status !== "active") {
    throw new IntegrationSyncError("connection_revoked", "This connection has been revoked and cannot start a new sync.");
  }
  if (connection.provider !== connector.id) {
    throw new IntegrationSyncError("connector_mismatch", "The connection provider does not match the connector being run.");
  }

  const credentials = decryptCredentials ? decryptCredentials(connection.credentials_ciphertext) : null;
  const connectorContext: ConnectorContext = {
    organizationId,
    connectionId,
    config: connection.config ?? {},
    credentials,
  };

  // Incremental runs always resume. A full run normally re-reads from the start,
  // but when the previous pass stopped at the page cap it must continue from the
  // committed checkpoint: restarting from scratch would re-walk the same pages,
  // hit the cap again and never finish.
  const resumingCap = mode === "full" && previousRunStatus === "partial";
  const startCursor = mode === "incremental" || resumingCap ? connection.checkpoint : null;

  const runId = (
    await withTenant((db) =>
      rowsOf<{ id: string }>(
        db,
        `INSERT INTO integration_sync_runs (organization_id, connection_id, mode, cursor_before, started_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [organizationId, connectionId, mode, startCursor, actorId],
      ),
    )
  )[0].id;

  const secrets = Object.values(credentials ?? {}).filter((value) => typeof value === "string" && value.length >= 4);
  const counts: SyncCounts = { imported: 0, updated: 0, duplicates: 0, quarantined: 0, failed: 0 };
  const ingestContext: IngestContext = {
    organizationId,
    connectionId,
    runId,
    connector,
    connectorContext,
    withTenant,
    secrets,
  };

  let cursor = startCursor;
  let pages = 0;
  // False until the feed has actually been walked to its end.
  let exhausted = false;

  try {
    while (pages < maxPages) {
      const state = await withTenant((db) =>
        rowsOf<{ status: string }>(db, "SELECT status FROM integration_connections WHERE id = $1", [connectionId]),
      );
      if (state[0]?.status !== "active") {
        throw new IntegrationSyncError("connection_revoked", "The connection was revoked while the sync was running.");
      }

      const page = await pullWithRetry(connector, connectorContext, cursor, pullAttempts, retryDelayMs);

      for (const record of page.records) {
        const outcome = await ingestRecord(record, ingestContext);
        counts[outcome] += 1;
      }

      cursor = page.nextCursor;
      pages += 1;

      await withTenant((db) =>
        db.query(
          "UPDATE integration_connections SET checkpoint = $2, last_synced_at = now() WHERE id = $1",
          [connectionId, cursor],
        ),
      );

      log(`page ${pages}: ${page.records.length} record(s), next cursor ${cursor ?? "end"}`);
      if (!page.hasMore || !cursor || page.records.length === 0) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted) {
      // The page cap ended the run while the source still had records. Every
      // ingested page is already committed and the checkpoint is saved, so this
      // is a resumable pause, not a failure and definitely not a success.
      const note = `Stopped at the page limit (${maxPages} pages) with more records available. Run again to continue from the saved checkpoint.`;
      await withTenant(async (db) => {
        await db.query(
          `UPDATE integration_sync_runs
              SET status = 'partial', note = $8, cursor_after = $2, imported = $3, updated = $4,
                  duplicates = $5, quarantined = $6, failed = $7, finished_at = now()
            WHERE id = $1`,
          [
            runId,
            cursor,
            counts.imported,
            counts.updated,
            counts.duplicates,
            counts.quarantined,
            counts.failed,
            note,
          ],
        );
        await db.query(
          `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, metadata)
           VALUES ($1, $2, 'integration.sync_partial', 'integration_connection', $3, $4, $5)`,
          [
            organizationId,
            actorId,
            connectionId,
            `Sync ${mode} incomplete after ${pages} page(s): ${counts.imported} imported, ${counts.updated} updated, ${counts.duplicates} duplicate(s), ${counts.quarantined} quarantined`,
            JSON.stringify({ runId, mode, pages, maxPages, ...counts }),
          ],
        );
      });

      log(`sync partial: ${note}`);
      return { runId, status: "partial", cursorAfter: cursor, note, ...counts };
    }

    await withTenant(async (db) => {
      await db.query(
        `UPDATE integration_sync_runs
            SET status = 'succeeded', cursor_after = $2, imported = $3, updated = $4,
                duplicates = $5, quarantined = $6, failed = $7, finished_at = now()
          WHERE id = $1`,
        [runId, cursor, counts.imported, counts.updated, counts.duplicates, counts.quarantined, counts.failed],
      );
      await db.query(
        `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, metadata)
         VALUES ($1, $2, 'integration.sync_succeeded', 'integration_connection', $3, $4, $5)`,
        [
          organizationId,
          actorId,
          connectionId,
          `Sync ${mode}: ${counts.imported} imported, ${counts.updated} updated, ${counts.duplicates} duplicate(s), ${counts.quarantined} quarantined`,
          JSON.stringify({ runId, mode, ...counts }),
        ],
      );
    });

    return { runId, status: "succeeded", cursorAfter: cursor, ...counts };
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : "Sync failed", secrets);
    const countsForRun = { ...counts };

    await withTenant(async (db) => {
      await db.query(
        `UPDATE integration_sync_runs
            SET status = 'failed', error = $2, cursor_after = $3, imported = $4, updated = $5,
                duplicates = $6, quarantined = $7, failed = $8, finished_at = now()
          WHERE id = $1`,
        [
          runId,
          message,
          cursor,
          countsForRun.imported,
          countsForRun.updated,
          countsForRun.duplicates,
          countsForRun.quarantined,
          countsForRun.failed,
        ],
      );
      await db.query(
        `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, metadata)
         VALUES ($1, $2, 'integration.sync_failed', 'integration_connection', $3, $4, $5)`,
        [
          organizationId,
          actorId,
          connectionId,
          `Sync ${mode} failed: ${message}`,
          JSON.stringify({ runId, mode, ...countsForRun }),
        ],
      );
    }).catch(() => {});

    log(`sync failed: ${message}`);
    return { runId, status: "failed", cursorAfter: cursor, error: message, ...countsForRun };
  }
}
