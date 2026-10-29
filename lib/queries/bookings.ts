import "server-only";
import { withOrg } from "../db";

export type BookingListItem = {
  id: string;
  resourceId: string;
  resourceCode: string;
  resourceName: string;
  userId: string;
  userName: string;
  userEmail: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  purpose: string;
  attendees: number;
  createdAt: Date;
  decisionNote: string | null;
  cancelReason: string | null;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  conditionNote: string | null;
  requiresApproval: boolean;
  checkInOpen: boolean;
  hasOpenSession: boolean;
  cancellable: boolean;
};

type RawBooking = {
  id: string;
  resource_id: string;
  resource_code: string;
  resource_name: string;
  user_id: string;
  user_name: string;
  user_email: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  purpose: string;
  attendees: number;
  created_at: Date;
  decision_note: string | null;
  cancel_reason: string | null;
  checked_in_at: Date | null;
  checked_out_at: Date | null;
  condition_note: string | null;
  requires_approval: boolean;
};

function mapBooking(row: RawBooking): BookingListItem {
  const now = Date.now();
  const start = new Date(row.starts_at).getTime();
  const end = new Date(row.ends_at).getTime();
  return {
    id: row.id,
    resourceId: row.resource_id,
    resourceCode: row.resource_code,
    resourceName: row.resource_name,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    purpose: row.purpose,
    attendees: row.attendees,
    createdAt: row.created_at,
    decisionNote: row.decision_note,
    cancelReason: row.cancel_reason,
    checkedInAt: row.checked_in_at,
    checkedOutAt: row.checked_out_at,
    conditionNote: row.condition_note,
    requiresApproval: row.requires_approval,
    checkInOpen:
      row.status === "confirmed" &&
      !row.checked_in_at &&
      now >= start - 30 * 60_000 &&
      now <= end,
    hasOpenSession: Boolean(row.checked_in_at) && !row.checked_out_at,
    cancellable: ["requested", "confirmed"].includes(row.status) && end > now,
  };
}

const BASE_SELECT = `
  SELECT b.id, b.resource_id, b.starts_at, b.ends_at, b.status, b.purpose, b.attendees,
         b.created_at, b.decision_note, b.cancel_reason,
         us.started_at AS checked_in_at, us.ended_at AS checked_out_at, us.condition_note,
         r.code AS resource_code, r.name AS resource_name, r.requires_approval,
         b.user_id, u.name AS user_name, u.email AS user_email
    FROM bookings b
    JOIN resources r ON r.id = b.resource_id
    JOIN users u ON u.id = b.user_id
    LEFT JOIN usage_sessions us ON us.booking_id = b.id`;

export async function listBookings(
  organizationId: string,
  options: {
    userId?: string;
    status?: string;
    resourceId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  } = {},
): Promise<BookingListItem[]> {
  return withOrg(organizationId, async (db) => {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (options.userId) {
      params.push(options.userId);
      conditions.push(`b.user_id = $${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conditions.push(`b.status = $${params.length}`);
    }
    if (options.resourceId) {
      params.push(options.resourceId);
      conditions.push(`b.resource_id = $${params.length}`);
    }
    if (options.from) {
      params.push(options.from);
      conditions.push(`b.ends_at >= $${params.length}`);
    }
    if (options.to) {
      params.push(options.to);
      conditions.push(`b.starts_at <= $${params.length}`);
    }
    params.push(options.limit ?? 80);
    const { rows } = await db.query<RawBooking>(
      `${BASE_SELECT}
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY b.starts_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapBooking);
  });
}

export async function getPendingApprovals(organizationId: string): Promise<BookingListItem[]> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<RawBooking>(
      `${BASE_SELECT}
        WHERE b.status = 'requested'
        ORDER BY b.starts_at`,
    );
    return rows.map(mapBooking);
  });
}

export async function getBooking(organizationId: string, bookingId: string): Promise<BookingListItem | null> {
  return withOrg(organizationId, async (db) => {
    const { rows } = await db.query<RawBooking>(`${BASE_SELECT} WHERE b.id = $1`, [bookingId]);
    return rows[0] ? mapBooking(rows[0]) : null;
  });
}

export async function getBookingsForDay(organizationId: string, date: Date): Promise<BookingListItem[]> {
  return withOrg(organizationId, async (db) => {
    const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    const { rows } = await db.query<RawBooking>(
      `${BASE_SELECT}
        WHERE tstzrange(b.starts_at, b.ends_at) && tstzrange($1, $2)
          AND b.status IN ('requested','confirmed')
        ORDER BY b.starts_at`,
      [date, dayEnd],
    );
    return rows.map(mapBooking);
  });
}
