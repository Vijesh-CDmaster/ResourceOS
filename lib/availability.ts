import "server-only";
import { withOrg } from "./db";
import { istWeekday, parseInstituteTime } from "./format";

export type SlotState = "free" | "booked" | "blackout" | "past";

export type Slot = {
  startsAt: Date;
  endsAt: Date;
  state: SlotState;
  label?: string;
};

export type DayAvailability = {
  date: string;
  openTime: string | null;
  closeTime: string | null;
  closed: boolean;
  slots: Slot[];
};

type RuleRow = { weekday: number; opens_at: string; closes_at: string };
type BookingRow = { starts_at: Date; ends_at: Date; status: string; user_name: string };
type BlackoutRow = { starts_at: Date; ends_at: Date; reason: string };

const SLOT_MINUTES = 30;

export async function getDayAvailability(
  organizationId: string,
  resourceId: string,
  dateKey: string,
): Promise<DayAvailability> {
  const dayStart = parseInstituteTime(dateKey, "00:00");
  if (!dayStart) return { date: dateKey, openTime: null, closeTime: null, closed: true, slots: [] };
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const weekday = istWeekday(dayStart);

  return withOrg(organizationId, async (db) => {
    const ruleResult = await db.query<RuleRow>(
      "SELECT weekday, opens_at, closes_at FROM availability_rules WHERE resource_id = $1 AND weekday = $2",
      [resourceId, weekday],
    );
    const rule = ruleResult.rows[0];
    if (!rule) {
      return { date: dateKey, openTime: null, closeTime: null, closed: true, slots: [] };
    }

    const [bookings, blackouts] = await Promise.all([
      db.query<BookingRow>(
        `SELECT b.starts_at, b.ends_at, b.status, u.name AS user_name
           FROM bookings b JOIN users u ON u.id = b.user_id
          WHERE b.resource_id = $1
            AND b.status IN ('requested','confirmed','completed')
            AND tstzrange(b.starts_at, b.ends_at) && tstzrange($2, $3)`,
        [resourceId, dayStart, dayEnd],
      ),
      db.query<BlackoutRow>(
        `SELECT starts_at, ends_at, reason FROM blackout_periods
          WHERE resource_id = $1 AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)`,
        [resourceId, dayStart, dayEnd],
      ),
    ]);

    const openTime = rule.opens_at.slice(0, 5);
    const closeTime = rule.closes_at.slice(0, 5);
    const open = parseInstituteTime(dateKey, openTime);
    const close = parseInstituteTime(dateKey, closeTime);
    if (!open || !close) {
      return { date: dateKey, openTime: null, closeTime: null, closed: true, slots: [] };
    }

    const slots: Slot[] = [];
    for (let cursor = open.getTime(); cursor < close.getTime(); cursor += SLOT_MINUTES * 60_000) {
      const startsAt = new Date(cursor);
      const endsAt = new Date(cursor + SLOT_MINUTES * 60_000);
      const booking = bookings.rows.find(
        (b) => new Date(b.starts_at) < endsAt && new Date(b.ends_at) > startsAt,
      );
      const blackout = blackouts.rows.find(
        (b) => new Date(b.starts_at) < endsAt && new Date(b.ends_at) > startsAt,
      );
      let state: SlotState = "free";
      let label: string | undefined;
      if (endsAt.getTime() <= Date.now()) {
        state = "past";
      } else if (booking) {
        state = "booked";
        label = booking.status === "confirmed" || booking.status === "completed" ? "Booked" : "Requested";
      } else if (blackout) {
        state = "blackout";
        label = blackout.reason || "Blocked";
      }
      slots.push({ startsAt, endsAt, state, label });
    }

    return { date: dateKey, openTime, closeTime, closed: false, slots };
  });
}
