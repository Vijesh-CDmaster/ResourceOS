import "server-only";
import { withOrg } from "../db";
import type { Role } from "../roles";

export type MemberItem = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
  departmentName: string | null;
  createdAt: Date;
  validTrainings: number;
  upcomingBookings: number;
};

export async function listMembers(organizationId: string): Promise<MemberItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      user_id: string;
      name: string;
      email: string;
      role: Role;
      department_id: string | null;
      department_name: string | null;
      created_at: Date;
      valid_trainings: number;
      upcoming_bookings: number;
    }>(
      `SELECT u.id AS user_id, u.name, u.email, m.role, m.department_id, d.name AS department_name,
              m.created_at,
              (SELECT count(*)::int FROM training_records tr
                WHERE tr.user_id = u.id AND tr.expires_at > now()) AS valid_trainings,
              (SELECT count(*)::int FROM bookings b
                WHERE b.user_id = u.id AND b.status IN ('requested','confirmed') AND b.ends_at > now()) AS upcoming_bookings
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN departments d ON d.id = m.department_id
        WHERE m.organization_id = $1
        ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'technician' THEN 2 ELSE 3 END, u.name`,
      [organizationId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      departmentId: row.department_id,
      departmentName: row.department_name,
      createdAt: row.created_at,
      validTrainings: row.valid_trainings,
      upcomingBookings: row.upcoming_bookings,
    }));
  });
}

export type TrainingRecordItem = {
  id: string;
  userName: string;
  courseName: string;
  grantedAt: Date;
  expiresAt: Date;
  expired: boolean;
};

export async function listTrainingRecords(organizationId: string): Promise<TrainingRecordItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      user_name: string;
      course_name: string;
      granted_at: Date;
      expires_at: Date;
      expired: boolean;
    }>(
      `SELECT tr.id, u.name AS user_name, tc.name AS course_name, tr.granted_at, tr.expires_at,
              (tr.expires_at <= now()) AS expired
         FROM training_records tr
         JOIN users u ON u.id = tr.user_id
         JOIN training_courses tc ON tc.id = tr.course_id
        ORDER BY tr.expires_at DESC
        LIMIT 60`,
    );
    return rows.map((row) => ({
      id: row.id,
      userName: row.user_name,
      courseName: row.course_name,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      expired: row.expired,
    }));
  });
}

export async function getAdminLookups(organizationId: string) {
  return withOrg(organizationId, async (db) => {
    const [members, courses, departments, facilities, org] = await Promise.all([
      db.query<{ id: string; name: string; email: string }>(
        "SELECT u.id, u.name, u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.organization_id = $1 ORDER BY u.name",
        [organizationId],
      ),
      db.query<{ id: string; name: string; validity_months: number }>(
        "SELECT id, name, validity_months FROM training_courses ORDER BY name",
      ),
      db.query<{ id: string; name: string }>("SELECT id, name FROM departments ORDER BY name"),
      db.query<{ id: string; name: string; location: string }>("SELECT id, name, location FROM facilities ORDER BY name"),
      db.query<{
        name: string;
        slug: string;
        open_hour: number;
        close_hour: number;
        max_active_bookings: number;
        max_horizon_days: number;
        no_show_grace_minutes: number;
        timezone: string;
      }>(
        "SELECT name, slug, open_hour, close_hour, max_active_bookings, max_horizon_days, no_show_grace_minutes, timezone FROM organizations WHERE id = $1",
        [organizationId],
      ),
    ]);
    return {
      members: members.rows,
      courses: courses.rows,
      departments: departments.rows,
      facilities: facilities.rows,
      organization: org.rows[0] ?? null,
    };
  });
}

export async function listAuditEvents(
  organizationId: string,
  options: { limit?: number; action?: string } = {},
) {
  return withOrg(organizationId, async (db) => {
    const params: unknown[] = [];
    let filter = "";
    if (options.action) {
      params.push(`${options.action}%`);
      filter = `WHERE a.action LIKE $${params.length}`;
    }
    params.push(options.limit ?? 100);
    const { rows } = await db.query<{
      id: string;
      action: string;
      summary: string;
      entity_type: string;
      entity_id: string | null;
      created_at: Date;
      actor_name: string | null;
      actor_role: Role | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT a.id, a.action, a.summary, a.entity_type, a.entity_id, a.created_at,
              u.name AS actor_name, m.role AS actor_role, a.metadata
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN memberships m ON m.user_id = a.actor_id AND m.organization_id = a.organization_id
        ${filter}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      entityType: row.entity_type,
      entityId: row.entity_id,
      createdAt: row.created_at,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      metadata: row.metadata,
    }));
  });
}
