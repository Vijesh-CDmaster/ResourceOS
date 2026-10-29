"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isBookingConflict, isUniqueViolation, withOrg } from "../db";
import { requireUser } from "../auth";
import { canManage, isStaff } from "../roles";
import { istWeekday, minutesFromMidnight, parseInstituteTime } from "../format";
import { notifyManagers, notifyUser, recordAudit, recordUnmetDemand } from "../audit";
import { bookingGate, consumeRequiredConsumables } from "../readiness";
import { fail, field, optionalField, ok } from "../action-utils";

type CreateResult =
  | { ok: true; bookingId: string; status: string; resourceName: string }
  | {
      ok: false;
      reason: "conflict" | "no_training" | "quota" | "blackout" | "resource_down" | "not_ready";
      message: string;
    };

export async function createBookingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const resourceId = field(formData, "resource_id");
  const dateKey = field(formData, "date");
  const startTime = field(formData, "start");
  const hours = Number(field(formData, "hours"));
  const purpose = field(formData, "purpose");
  const attendees = Math.max(1, Number(field(formData, "attendees") || 1));
  const idempotencyKey = optionalField(formData, "request_key");
  const backTo = `/resources/${resourceId}?date=${dateKey}`;

  const startsAt = parseInstituteTime(dateKey, startTime);
  if (!startsAt) fail(backTo, "Choose a valid date and start time.");
  if (!Number.isFinite(hours) || hours <= 0) fail(backTo, "Choose a slot length.");
  if (!purpose) fail(backTo, "Describe what the resource will be used for.");
  const endsAt = new Date(startsAt.getTime() + hours * 3_600_000);
  if (startsAt.getTime() < Date.now() - 60_000) fail(backTo, "That start time has already passed.");
  const horizon = new Date(Date.now() + user.maxHorizonDays * 24 * 3_600_000);
  if (startsAt > horizon) fail(backTo, `Bookings open ${user.maxHorizonDays} days ahead.`);

  let result: CreateResult;
  try {
    result = await withOrg(user.organizationId, async (db) => {
      const resourceResult = await db.query<{
        id: string;
        name: string;
        status: string;
        requires_approval: boolean;
        max_hours_per_booking: string;
        training_course_id: string | null;
      }>(
        `SELECT id, name, status, requires_approval, max_hours_per_booking, training_course_id
           FROM resources WHERE id = $1`,
        [resourceId],
      );
      const resource = resourceResult.rows[0];
      if (!resource) return { ok: false as const, reason: "resource_down" as const, message: "That resource no longer exists." };
      if (resource.status === "retired") {
        return { ok: false as const, reason: "resource_down" as const, message: "This resource has been retired." };
      }
      if (resource.status !== "ready") {
        return {
          ok: false as const,
          reason: "resource_down" as const,
          message: `${resource.name} is currently ${resource.status} and cannot be booked.`,
        };
      }

      const maxHours = Number(resource.max_hours_per_booking);
      if (hours > maxHours) {
        fail(backTo, `The maximum booking length for ${resource.name} is ${maxHours} hours.`);
      }

      const ruleResult = await db.query<{ opens_at: string; closes_at: string }>(
        "SELECT opens_at, closes_at FROM availability_rules WHERE resource_id = $1 AND weekday = $2",
        [resourceId, istWeekday(startsAt)],
      );
      const rule = ruleResult.rows[0];
      const startMinutes = minutesFromMidnight(startsAt);
      const endMinutes = startMinutes + hours * 60;
      const openMinutes = rule ? Number(rule.opens_at.slice(0, 2)) * 60 + Number(rule.opens_at.slice(3, 5)) : 0;
      const closeMinutes = rule ? Number(rule.closes_at.slice(0, 2)) * 60 + Number(rule.closes_at.slice(3, 5)) : 0;
      if (!rule || startMinutes < openMinutes || endMinutes > closeMinutes) {
        return {
          ok: false as const,
          reason: "blackout" as const,
          message: rule
            ? `${resource.name} is bookable ${rule.opens_at.slice(0, 5)}–${rule.closes_at.slice(0, 5)} on this day.`
            : `${resource.name} is closed on this day.`,
        };
      }

      if (resource.training_course_id) {
        const training = await db.query<{ expires_at: Date }>(
          `SELECT expires_at FROM training_records
            WHERE user_id = $1 AND course_id = $2 AND expires_at > $3
            ORDER BY expires_at DESC LIMIT 1`,
          [user.userId, resource.training_course_id, startsAt],
        );
        if (training.rows.length === 0) {
          return {
            ok: false as const,
            reason: "no_training" as const,
            message: `You need valid training for ${resource.name}. Ask a facility manager to record your certification.`,
          };
        }
      }

      const active = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM bookings
          WHERE user_id = $1 AND status IN ('requested','confirmed') AND ends_at > now()`,
        [user.userId],
      );
      if ((active.rows[0]?.count ?? 0) >= user.maxActiveBookings) {
        return {
          ok: false as const,
          reason: "quota" as const,
          message: `You already have ${user.maxActiveBookings} active bookings. Cancel one before requesting another.`,
        };
      }

      const blackout = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM blackout_periods
          WHERE resource_id = $1 AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)`,
        [resourceId, startsAt, endsAt],
      );
      if ((blackout.rows[0]?.count ?? 0) > 0) {
        return {
          ok: false as const,
          reason: "blackout" as const,
          message: "That window is blocked for maintenance or a facility closure.",
        };
      }

      // Operational readiness: calibration, open safety holds, maintenance and
      // required stock. A single hard block stops the request and is recorded as
      // unmet demand, so the facility can see what capacity it could not use.
      const gate = await bookingGate(db, resourceId, startsAt);
      if (!gate.ok) {
        return { ok: false as const, reason: "not_ready" as const, message: gate.message };
      }

      const status = resource.requires_approval ? "requested" : "confirmed";
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose, attendees, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [user.organizationId, resourceId, user.userId, startsAt, endsAt, status, purpose, attendees, idempotencyKey],
      );
      const bookingId = inserted.rows[0].id;

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: status === "requested" ? "booking.requested" : "booking.confirmed",
        entityType: "booking",
        entityId: bookingId,
        summary: `${user.name} booked ${resource.name} for ${hours}h`,
        metadata: { startsAt, endsAt, resourceId },
      });

      if (status === "requested") {
        await notifyManagers(db, {
          organizationId: user.organizationId,
          title: `Approval needed: ${resource.name}`,
          body: `${user.name} requested ${hours}h starting ${startsAt.toISOString()}.`,
          link: "/approvals",
          excludeUserId: user.userId,
        });
      } else {
        await notifyUser(db, {
          organizationId: user.organizationId,
          userId: user.userId,
          title: `Booking confirmed: ${resource.name}`,
          body: "Your slot is confirmed. Check in from your bookings page when you arrive.",
          link: "/bookings",
        });
      }

      return { ok: true as const, bookingId, status, resourceName: resource.name };
    });
  } catch (error) {
    if (isBookingConflict(error)) {
      await withOrg(user.organizationId, (db) =>
        recordUnmetDemand(db, {
          organizationId: user.organizationId,
          resourceId,
          userId: user.userId,
          startsAt,
          endsAt,
          reason: "conflict",
        }),
      ).catch(() => {});
      fail(backTo, "Another booking took that slot just now. Pick a different window.");
    }
    if (isUniqueViolation(error)) {
      // The same form was submitted twice; treat the retry as success.
      redirect("/bookings?ok=Booking%20already%20recorded");
    }
    throw error;
  }

  if (!result.ok) {
    await withOrg(user.organizationId, (db) =>
      recordUnmetDemand(db, {
        organizationId: user.organizationId,
        resourceId,
        userId: user.userId,
        startsAt,
        endsAt,
        reason: result.reason,
      }),
    ).catch(() => {});
    fail(backTo, result.message);
  }

  revalidatePath("/dashboard");
  revalidatePath("/bookings");
  revalidatePath("/approvals");
  revalidatePath(backTo);
  ok(
    "/bookings",
    result.status === "requested"
      ? `${result.resourceName} request sent for approval.`
      : `${result.resourceName} booked.`,
  );
}

export async function decideBookingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail("/dashboard", "Only facility managers can approve bookings.");
  const bookingId = field(formData, "booking_id");
  const decision = field(formData, "decision");
  const note = field(formData, "note");
  if (!["approve", "reject"].includes(decision)) fail("/approvals", "Unknown decision.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const bookingResult = await db.query<{
        id: string;
        status: string;
        user_id: string;
        starts_at: Date;
        ends_at: Date;
        resource_id: string;
        resource_name: string;
      }>(
        `SELECT b.id, b.status, b.user_id, b.starts_at, b.ends_at, b.resource_id, r.name AS resource_name
           FROM bookings b JOIN resources r ON r.id = b.resource_id
          WHERE b.id = $1 FOR UPDATE`,
        [bookingId],
      );
      const booking = bookingResult.rows[0];
      if (!booking) throw new Error("Booking not found.");
      if (booking.status !== "requested") throw new Error("This request has already been decided.");

      const status = decision === "approve" ? "confirmed" : "rejected";
      await db.query(
        `UPDATE bookings SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
        [bookingId, status, user.userId, note || null],
      );

      if (decision === "reject") {
        await recordUnmetDemand(db, {
          organizationId: user.organizationId,
          resourceId: booking.resource_id,
          userId: booking.user_id,
          startsAt: booking.starts_at,
          endsAt: booking.ends_at,
          reason: "approval_rejected",
        });
      }

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: decision === "approve" ? "booking.approved" : "booking.rejected",
        entityType: "booking",
        entityId: bookingId,
        summary: `${user.name} ${decision === "approve" ? "approved" : "rejected"} ${booking.resource_name}`,
        metadata: { note },
      });

      await notifyUser(db, {
        organizationId: user.organizationId,
        userId: booking.user_id,
        title: `${booking.resource_name}: ${decision === "approve" ? "approved" : "not approved"}`,
        body: note || (decision === "approve" ? "Your booking is confirmed." : "Speak to the facility team for an alternative slot."),
        link: "/bookings",
      });
    });
  } catch (error) {
    if (isBookingConflict(error)) {
      fail("/approvals", "Cannot approve: the resource is already committed for part of that window.");
    }
    fail("/approvals", error instanceof Error ? error.message : "Could not update the request.");
  }

  revalidatePath("/approvals");
  revalidatePath("/bookings");
  revalidatePath("/dashboard");
  ok("/approvals", decision === "approve" ? "Request approved." : "Request rejected and logged as unmet demand.");
}

export async function cancelBookingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const bookingId = field(formData, "booking_id");
  const reason = field(formData, "reason") || "Cancelled by user";
  const backTo = field(formData, "back_to") || "/bookings";

  await withOrg(user.organizationId, async (db) => {
    const bookingResult = await db.query<{
      id: string;
      status: string;
      user_id: string;
      starts_at: Date;
      resource_name: string;
    }>(
      `SELECT b.id, b.status, b.user_id, b.starts_at, r.name AS resource_name
         FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE b.id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = bookingResult.rows[0];
    if (!booking) throw new Error("Booking not found.");
    const isOwner = booking.user_id === user.userId;
    if (!isOwner && !canManage(user.role)) throw new Error("You cannot cancel this booking.");
    if (!["requested", "confirmed"].includes(booking.status)) throw new Error("Only open bookings can be cancelled.");
    if (booking.starts_at.getTime() < Date.now() && !isStaff(user.role)) {
      throw new Error("A session that has already started must be closed by the facility team.");
    }

    await db.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3 WHERE id = $1`,
      [bookingId, user.userId, reason],
    );
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "booking.cancelled",
      entityType: "booking",
      entityId: bookingId,
      summary: `${user.name} cancelled ${booking.resource_name}`,
      metadata: { reason },
    });
    if (!isOwner) {
      await notifyUser(db, {
        organizationId: user.organizationId,
        userId: booking.user_id,
        title: `Booking cancelled: ${booking.resource_name}`,
        body: reason,
        link: "/bookings",
      });
    }
  }).catch((error: unknown) => {
    fail(backTo, error instanceof Error ? error.message : "Could not cancel the booking.");
  });

  revalidatePath("/bookings");
  revalidatePath("/dashboard");
  ok(backTo, "Booking cancelled.");
}

export async function checkInAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const bookingId = field(formData, "booking_id");
  const backTo = field(formData, "back_to") || "/bookings";

  await withOrg(user.organizationId, async (db) => {
    const bookingResult = await db.query<{
      id: string;
      status: string;
      user_id: string;
      resource_id: string;
      starts_at: Date;
      ends_at: Date;
      resource_name: string;
    }>(
      `SELECT b.id, b.status, b.user_id, b.resource_id, b.starts_at, b.ends_at, r.name AS resource_name
         FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE b.id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = bookingResult.rows[0];
    if (!booking) throw new Error("Booking not found.");
    if (booking.user_id !== user.userId && !isStaff(user.role)) throw new Error("This is not your booking.");
    if (booking.status !== "confirmed") throw new Error("Only confirmed bookings can be checked in.");
    const opens = new Date(booking.starts_at.getTime() - 30 * 60_000);
    if (Date.now() < opens.getTime()) throw new Error("Check-in opens 30 minutes before the slot.");
    if (Date.now() > booking.ends_at.getTime()) throw new Error("This slot has already ended.");

    // Readiness is re-checked at the moment of use, not only at booking time: a
    // calibration can expire, an incident can be raised, or stock can run out
    // between approval and check-in.
    const gate = await bookingGate(db, booking.resource_id, new Date());
    if (!gate.ok) {
      throw new Error(`Check-in blocked. ${gate.message}`);
    }

    await db.query(
      `INSERT INTO usage_sessions (organization_id, booking_id, started_at) VALUES ($1, $2, now())
       ON CONFLICT (booking_id) DO NOTHING`,
      [user.organizationId, bookingId],
    );

    // Deduct required consumables exactly once per booking. Throws (rolling the
    // check-in back) if a competing session took the last unit.
    const consumed = await consumeRequiredConsumables(db, {
      organizationId: user.organizationId,
      bookingId,
      resourceId: booking.resource_id,
      actorId: user.userId,
    });
    if (consumed.length > 0) {
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "consumable.consumed",
        entityType: "booking",
        entityId: bookingId,
        summary: `Consumed ${consumed
          .map((item) => `${item.quantity} ${item.unit} ${item.name}`)
          .join(", ")}`,
        metadata: { resourceId: booking.resource_id, consumed },
      });
    }
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "booking.checked_in",
      entityType: "booking",
      entityId: bookingId,
      summary: `${user.name} checked in to ${booking.resource_name}`,
    });
  }).catch((error: unknown) => {
    fail(backTo, error instanceof Error ? error.message : "Could not check in.");
  });

  revalidatePath("/bookings");
  ok(backTo, "Checked in. Close the session when you finish.");
}

export async function checkOutAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const bookingId = field(formData, "booking_id");
  const condition = field(formData, "condition");
  const consumables = field(formData, "consumables");
  const backTo = field(formData, "back_to") || "/bookings";

  await withOrg(user.organizationId, async (db) => {
    const bookingResult = await db.query<{
      id: string;
      status: string;
      user_id: string;
      resource_name: string;
    }>(
      `SELECT b.id, b.status, b.user_id, r.name AS resource_name
         FROM bookings b JOIN resources r ON r.id = b.resource_id
        WHERE b.id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = bookingResult.rows[0];
    if (!booking) throw new Error("Booking not found.");
    if (booking.user_id !== user.userId && !isStaff(user.role)) throw new Error("This is not your booking.");
    if (booking.status !== "confirmed") throw new Error("Only an open, checked-in session can be closed.");

    const session = await db.query<{ id: string }>(
      "SELECT id FROM usage_sessions WHERE booking_id = $1 AND ended_at IS NULL FOR UPDATE",
      [bookingId],
    );
    if (!session.rows[0]) throw new Error("Check in before closing the session.");

    await db.query(
      `UPDATE usage_sessions SET ended_at = now(), condition_note = $2, consumables = $3 WHERE id = $1`,
      [session.rows[0].id, condition, consumables],
    );
    await db.query("UPDATE bookings SET status = 'completed' WHERE id = $1", [bookingId]);
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorId: user.userId,
      action: "booking.checked_out",
      entityType: "booking",
      entityId: bookingId,
      summary: `${user.name} closed ${booking.resource_name}`,
      metadata: { condition, consumables },
    });
  }).catch((error: unknown) => {
    fail(backTo, error instanceof Error ? error.message : "Could not close the session.");
  });

  revalidatePath("/bookings");
  ok(backTo, "Session closed and usage recorded.");
}
