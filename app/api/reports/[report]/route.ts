import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getReports } from "@/lib/queries/reports";
import { listBookings } from "@/lib/queries/bookings";
import { listAuditEvents } from "@/lib/queries/admin";
import { istDateKey, shiftDays, toCsv } from "@/lib/format";
import { isStaff } from "@/lib/roles";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ report: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { report } = await params;
  const search = request.nextUrl.searchParams;
  const today = istDateKey();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(search.get("from") ?? "")
    ? search.get("from")!
    : shiftDays(today, -30);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(search.get("to") ?? "") ? search.get("to")! : today;
  const rangeStart = new Date(`${from}T00:00:00+05:30`);
  const rangeEnd = new Date(`${to}T00:00:00+05:30`);
  const stamp = `${from}_to_${to}`;

  let csv = "";
  let filename = "";

  if (report === "utilization") {
    const data = await getReports(user.organizationId, from, to);
    csv = toCsv(
      data.utilization.map((row) => ({
        code: row.code,
        resource: row.name,
        status: row.status,
        available_hours: row.availableHours.toFixed(2),
        downtime_hours: row.downtimeHours.toFixed(2),
        booked_hours: row.bookedHours.toFixed(2),
        actual_hours: row.actualHours.toFixed(2),
        utilization_pct: row.utilizationPct.toFixed(1),
        no_shows: row.noShows,
        completed: row.completed,
        cancelled: row.cancelled,
        requested: row.requested,
      })),
      [
        "code",
        "resource",
        "status",
        "available_hours",
        "downtime_hours",
        "booked_hours",
        "actual_hours",
        "utilization_pct",
        "no_shows",
        "completed",
        "cancelled",
        "requested",
      ],
    );
    filename = `resourceos_utilization_${stamp}.csv`;
  } else if (report === "bookings") {
    const bookings = await listBookings(user.organizationId, {
      from: rangeStart,
      to: rangeEnd,
      limit: 5000,
    });
    csv = toCsv(
      bookings.map((booking) => ({
        resource_code: booking.resourceCode,
        resource: booking.resourceName,
        user: booking.userName,
        email: booking.userEmail,
        starts_at: booking.startsAt.toISOString(),
        ends_at: booking.endsAt.toISOString(),
        status: booking.status,
        purpose: booking.purpose,
        attendees: booking.attendees,
        checked_in_at: booking.checkedInAt?.toISOString() ?? "",
        checked_out_at: booking.checkedOutAt?.toISOString() ?? "",
        condition_note: booking.conditionNote ?? "",
        cancel_reason: booking.cancelReason ?? "",
        decision_note: booking.decisionNote ?? "",
      })),
      [
        "resource_code",
        "resource",
        "user",
        "email",
        "starts_at",
        "ends_at",
        "status",
        "purpose",
        "attendees",
        "checked_in_at",
        "checked_out_at",
        "condition_note",
        "cancel_reason",
        "decision_note",
      ],
    );
    filename = `resourceos_bookings_${stamp}.csv`;
  } else if (report === "unmet-demand") {
    const data = await getReports(user.organizationId, from, to);
    csv = toCsv(
      data.unmetDemand.map((row) => ({
        resource_code: row.resourceCode,
        resource: row.resourceName,
        reason: row.reason,
        count: row.count,
      })),
      ["resource_code", "resource", "reason", "count"],
    );
    filename = `resourceos_unmet_demand_${stamp}.csv`;
  } else if (report === "audit") {
    const events = await listAuditEvents(user.organizationId, { limit: 2000 });
    csv = toCsv(
      events.map((event) => ({
        created_at: event.createdAt.toISOString(),
        actor: event.actorName ?? "system",
        action: event.action,
        entity_type: event.entityType,
        entity_id: event.entityId ?? "",
        summary: event.summary,
      })),
      ["created_at", "actor", "action", "entity_type", "entity_id", "summary"],
    );
    filename = `resourceos_audit_${stamp}.csv`;
  } else {
    return NextResponse.json({ error: "Unknown report" }, { status: 404 });
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
