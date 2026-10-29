import "server-only";
import { withOrg } from "../db";

// Every query here runs inside withOrg, so RLS scopes rows to the caller's
// institution. `credentials_ciphertext` is never selected: only a boolean
// "has credentials" flag reaches the UI.

export type ConnectionItem = {
  id: string;
  provider: string;
  name: string;
  status: "active" | "revoked";
  config: Record<string, unknown>;
  hasCredentials: boolean;
  checkpoint: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
  mappedEntities: number;
  openIssues: number;
  lastRunStatus: "running" | "succeeded" | "failed" | "partial" | null;
  lastRunAt: Date | null;
};

export async function listConnections(organizationId: string): Promise<ConnectionItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      provider: string;
      name: string;
      status: "active" | "revoked";
      config: Record<string, unknown>;
      has_credentials: boolean;
      checkpoint: string | null;
      last_synced_at: Date | null;
      created_at: Date;
      revoked_at: Date | null;
      mapped_entities: number;
      open_issues: number;
      last_run_status: "running" | "succeeded" | "failed" | "partial" | null;
      last_run_at: Date | null;
    }>(
      `SELECT c.id, c.provider, c.name, c.status, c.config,
              c.credentials_ciphertext IS NOT NULL AS has_credentials,
              c.checkpoint, c.last_synced_at, c.created_at, c.revoked_at,
              (SELECT count(*)::int FROM integration_entity_map m WHERE m.connection_id = c.id) AS mapped_entities,
              (SELECT count(*)::int FROM integration_quarantine q
                WHERE q.connection_id = c.id AND q.resolved_at IS NULL) AS open_issues,
              r.status AS last_run_status,
              r.started_at AS last_run_at
         FROM integration_connections c
         LEFT JOIN LATERAL (
           SELECT status, started_at FROM integration_sync_runs sr
            WHERE sr.connection_id = c.id
            ORDER BY sr.started_at DESC LIMIT 1
         ) r ON true
        WHERE c.organization_id = $1
        ORDER BY c.created_at DESC`,
      [organizationId],
    );
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      config: row.config ?? {},
      hasCredentials: row.has_credentials,
      checkpoint: row.checkpoint,
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      mappedEntities: row.mapped_entities,
      openIssues: row.open_issues,
      lastRunStatus: row.last_run_status,
      lastRunAt: row.last_run_at,
    }));
  });
}

export type SyncRunItem = {
  id: string;
  connectionName: string;
  provider: string;
  mode: string;
  status: string;
  imported: number;
  updated: number;
  duplicates: number;
  quarantined: number;
  failed: number;
  error: string | null;
  note: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

export async function listSyncRuns(organizationId: string, limit = 20): Promise<SyncRunItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      connection_name: string;
      provider: string;
      mode: string;
      status: string;
      imported: number;
      updated: number;
      duplicates: number;
      quarantined: number;
      failed: number;
      error: string | null;
      note: string | null;
      started_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT sr.id, c.name AS connection_name, c.provider, sr.mode, sr.status,
              sr.imported, sr.updated, sr.duplicates, sr.quarantined, sr.failed,
              sr.error, sr.note, sr.started_at, sr.finished_at
         FROM integration_sync_runs sr
         JOIN integration_connections c ON c.id = sr.connection_id
        WHERE sr.organization_id = $1
        ORDER BY sr.started_at DESC
        LIMIT $2`,
      [organizationId, Math.min(100, Math.max(1, limit))],
    );
    return rows.map((row) => ({
      id: row.id,
      connectionName: row.connection_name,
      provider: row.provider,
      mode: row.mode,
      status: row.status,
      imported: row.imported,
      updated: row.updated,
      duplicates: row.duplicates,
      quarantined: row.quarantined,
      failed: row.failed,
      error: row.error,
      note: row.note,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  });
}

export type QuarantineItem = {
  id: string;
  connectionName: string;
  entityType: string;
  externalId: string;
  reason: string;
  message: string;
  attempts: number;
  lastSeenAt: Date;
  resolvedAt: Date | null;
};

export async function listQuarantine(organizationId: string, limit = 25): Promise<QuarantineItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      connection_name: string;
      entity_type: string;
      external_id: string;
      reason: string;
      message: string;
      attempts: number;
      last_seen_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT q.id, c.name AS connection_name, q.entity_type, q.external_id, q.reason,
              q.message, q.attempts, q.last_seen_at, q.resolved_at
         FROM integration_quarantine q
         JOIN integration_connections c ON c.id = q.connection_id
        WHERE q.organization_id = $1
        ORDER BY q.resolved_at NULLS FIRST, q.last_seen_at DESC
        LIMIT $2`,
      [organizationId, Math.min(100, Math.max(1, limit))],
    );
    return rows.map((row) => ({
      id: row.id,
      connectionName: row.connection_name,
      entityType: row.entity_type,
      externalId: row.external_id,
      reason: row.reason,
      message: row.message,
      attempts: row.attempts,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at,
    }));
  });
}
