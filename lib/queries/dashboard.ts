import "server-only";
import { withOrg } from "../db";
import type { Role } from "../roles";
import { isStaff } from "../roles";

export type DashboardData = {
  upcoming: Array<{
    id: string;
    resourceName: string;
    resourceCode: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
  }>;
  notifications: Array<{
    id: string;
    title: string;
    body: string;
    link: string | null;
    createdAt: Date;
    readAt: Date | null;
  }>;
  unreadNotifications: number;
  stats: {
    readyResources: number;
    totalResources: number;
    pendingApprovals: number;
    openIncidents: number;
    bookingsToday: number;
    noShowRate: number;
  };
  trainingExpiring: Array<{ courseName: string; expiresAt: Date }>;
  recentActivity: Array<{ id: string; summary: string; action: string; createdAt: Date; actorName: string | null }>;
};

export async function getDashboard(
  organizationId: string,
  userId: string,
  role: Role,
): Promise<DashboardData> {
  return withOrg(organizationId, async (db) => {
    const staff = isStaff(role);
    const [upcoming, notifications, unread, resourceCounts, pending, incidents, today, training, activity] =
      await Promise.all([
        db.query<{
          id: string;
          resource_name: string;
          resource_code: string;
          starts_at: Date;
          ends_at: Date;
          status: string;
        }>(
          `SELECT b.id, b.starts_at, b.ends_at, b.status, r.name AS resource_name, r.code AS resource_code
             FROM bookings b JOIN resources r ON r.id = b.resource_id
            WHERE b.user_id = $1 AND b.ends_at > now()
              AND b.status IN ('requested','confirmed')
            ORDER BY b.starts_at LIMIT 4`,
          [userId],
        ),
        db.query<{ id: string; title: string; body: string; link: string | null; created_at: Date; read_at: Date | null }>(
          `SELECT id, title, body, link, created_at, read_at FROM notifications
            WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
          [userId],
        ),
        db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
          [userId],
        ),
        db.query<{ ready: number; total: number }>(
          `SELECT count(*) FILTER (WHERE status = 'ready')::int AS ready, count(*)::int AS total
             FROM resources WHERE status <> 'retired'`,
        ),
        staff
          ? db.query<{ count: number }>("SELECT count(*)::int AS count FROM bookings WHERE status = 'requested'")
          : Promise.resolve({ rows: [{ count: 0 }] }),
        staff
          ? db.query<{ count: number }>("SELECT count(*)::int AS count FROM incidents WHERE status <> 'resolved'")
          : Promise.resolve({ rows: [{ count: 0 }] }),
        db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM bookings
            WHERE status IN ('requested','confirmed') AND starts_at::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
        ),
        db.query<{ course_name: string; expires_at: Date }>(
          `SELECT tc.name AS course_name, tr.expires_at
             FROM training_records tr JOIN training_courses tc ON tc.id = tr.course_id
            WHERE tr.user_id = $1 AND tr.expires_at > now()
            ORDER BY tr.expires_at LIMIT 3`,
          [userId],
        ),
        staff
          ? db.query<{ id: string; summary: string; action: string; created_at: Date; actor_name: string | null }>(
              `SELECT a.id, a.summary, a.action, a.created_at, u.name AS actor_name
                 FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
                ORDER BY a.created_at DESC LIMIT 8`,
            )
          : Promise.resolve({ rows: [] }),
      ]);

    // 30-day no-show rate across the tenant.
    const kpi = await db.query<{ total: number; no_shows: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
         FROM bookings
        WHERE starts_at > now() - interval '30 days'
          AND status IN ('completed','no_show','confirmed','cancelled')`,
    );
    const total = kpi.rows[0]?.total ?? 0;
    const noShows = kpi.rows[0]?.no_shows ?? 0;

    return {
      upcoming: upcoming.rows.map((row) => ({
        id: row.id,
        resourceName: row.resource_name,
        resourceCode: row.resource_code,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
      })),
      notifications: notifications.rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        link: row.link,
        createdAt: row.created_at,
        readAt: row.read_at,
      })),
      unreadNotifications: unread.rows[0]?.count ?? 0,
      stats: {
        readyResources: resourceCounts.rows[0]?.ready ?? 0,
        totalResources: resourceCounts.rows[0]?.total ?? 0,
        pendingApprovals: pending.rows[0]?.count ?? 0,
        openIncidents: incidents.rows[0]?.count ?? 0,
        bookingsToday: today.rows[0]?.count ?? 0,
        noShowRate: total > 0 ? (noShows / total) * 100 : 0,
      },
      trainingExpiring: training.rows.map((row) => ({
        courseName: row.course_name,
        expiresAt: row.expires_at,
      })),
      recentActivity: activity.rows.map((row) => ({
        id: row.id,
        summary: row.summary,
        action: row.action,
        createdAt: row.created_at,
        actorName: row.actor_name,
      })),
    };
  });
}

export async function getDepartmentName(
  organizationId: string,
  departmentId: string | null,
): Promise<string | null> {
  if (!departmentId) return null;
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<{ name: string }>("SELECT name FROM departments WHERE id = $1", [departmentId]);
    return rows[0]?.name ?? null;
  });
}

export async function getShellCounts(
  organizationId: string,
  userId: string,
  departmentId: string | null,
  canApprove: boolean,
): Promise<{ departmentName: string | null; pendingCount: number; unreadCount: number }> {
  return withOrg(organizationId, async (db) => {
    const [department, pending, unread] = await Promise.all([
      departmentId
        ? db.query<{ name: string }>("SELECT name FROM departments WHERE id = $1", [departmentId])
        : Promise.resolve({ rows: [] as Array<{ name: string }> }),
      canApprove
        ? db.query<{ count: number }>("SELECT count(*)::int AS count FROM bookings WHERE status = 'requested'")
        : Promise.resolve({ rows: [{ count: 0 }] }),
      db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [userId],
      ),
    ]);
    return {
      departmentName: department.rows[0]?.name ?? null,
      pendingCount: pending.rows[0]?.count ?? 0,
      unreadCount: unread.rows[0]?.count ?? 0,
    };
  });
}
