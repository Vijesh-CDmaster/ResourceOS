import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDayAvailability } from "@/lib/availability";
import { istDateKey } from "@/lib/format";
import { withOrg } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const date = request.nextUrl.searchParams.get("date") ?? istDateKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const exists = await withOrg(user.organizationId, async (db) => {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM resources WHERE id = $1", [id]);
    return rows.length > 0;
  });
  if (!exists) return NextResponse.json({ error: "Resource not found" }, { status: 404 });

  const availability = await getDayAvailability(user.organizationId, id, date);
  return NextResponse.json(
    {
      resourceId: id,
      date: availability.date,
      closed: availability.closed,
      openTime: availability.openTime,
      closeTime: availability.closeTime,
      slots: availability.slots.map((slot) => ({
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        state: slot.state,
        label: slot.label ?? null,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
