import "server-only";
import type { Queryable } from "./db";

type AuditInput = {
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
};

export async function recordAudit(db: Queryable, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.organizationId,
      input.actorId,
      input.action,
      input.entityType,
      input.entityId,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function notifyUser(
  db: Queryable,
  input: {
    organizationId: string;
    userId: string;
    title: string;
    body?: string;
    link?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (organization_id, user_id, title, body, link)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.organizationId, input.userId, input.title, input.body ?? "", input.link ?? null],
  );
}

export async function notifyManagers(
  db: Queryable,
  input: { organizationId: string; title: string; body: string; link: string; excludeUserId?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (organization_id, user_id, title, body, link)
     SELECT $1, m.user_id, $2, $3, $4
       FROM memberships m
      WHERE m.organization_id = $1
        AND m.role IN ('admin', 'manager')
        AND m.user_id <> coalesce($5, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [input.organizationId, input.title, input.body, input.link, input.excludeUserId ?? null],
  );
}

export async function recordUnmetDemand(
  db: Queryable,
  input: {
    organizationId: string;
    resourceId: string;
    userId: string;
    startsAt: Date;
    endsAt: Date;
    reason:
      | "conflict"
      | "no_training"
      | "quota"
      | "blackout"
      | "resource_down"
      | "approval_rejected"
      | "not_ready";
  },
): Promise<void> {
  await db.query(
    `INSERT INTO unmet_demand_events (organization_id, resource_id, user_id, starts_at, ends_at, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.organizationId, input.resourceId, input.userId, input.startsAt, input.endsAt, input.reason],
  );
}
