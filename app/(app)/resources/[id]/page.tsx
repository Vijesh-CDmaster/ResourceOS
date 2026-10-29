import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth";
import { getResourceDetail } from "@/lib/queries/resources";
import { getResourceReadiness } from "@/lib/readiness";
import { ReadinessPanel } from "@/components/readiness-panel";
import { createBookingAction } from "@/lib/actions/bookings";
import { updateResourceStatusAction } from "@/lib/actions/resources";
import { formatDate, formatHours, formatRange, formatTime, istDateKey, shiftDays } from "@/lib/format";
import { isStaff } from "@/lib/roles";
import { Icon } from "@/components/icons";
import { Badge, BookingBadge, Flash, ResourceBadge, SectionHeading } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DURATIONS = [1, 1.5, 2, 3, 4, 6, 8];

function timeValue(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export default async function ResourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string; error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? "") ? query.date! : istDateKey();
  const detail = await getResourceDetail(user.organizationId, user.userId, id, dateKey);
  if (!detail) notFound();
  const readiness = await getResourceReadiness(user.organizationId, id);

  const slots = detail.availability.slots;
  const freeStarts = slots
    .map((slot, index) => {
      if (slot.state !== "free") return null;
      let minutes = 0;
      for (let cursor = index; cursor < slots.length && slots[cursor].state === "free"; cursor++) {
        minutes += 30;
      }
      return { value: timeValue(slot.startsAt), label: formatTime(slot.startsAt), maxHours: minutes / 60 };
    })
    .filter((slot): slot is { value: string; label: string; maxHours: number } => slot !== null && slot.maxHours >= 1);

  const bookable = detail.status === "ready";
  const staff = isStaff(user.role);
  const backTo = `/resources/${id}?date=${dateKey}`;

  return (
    <div>
      <div className="mb-4">
        <Link href="/resources" className="text-xs font-medium text-muted hover:text-ink">
          ← All resources
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-600">
              {detail.code}
            </span>
            <ResourceBadge status={detail.status} />
            {detail.requiresApproval ? <Badge tone="amber">Requires approval</Badge> : <Badge tone="green">Instant booking</Badge>}
          </div>
          <h1 className="mt-1.5 text-[28px] font-semibold tracking-[-0.02em]">{detail.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {detail.facilityName ?? "Unassigned facility"} · {detail.location || "No location set"} ·{" "}
            {detail.departmentName ?? "All departments"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {staff ? (
            <Link href={`/capital/${detail.id}`} className="btn-secondary">
              Capital evidence
            </Link>
          ) : null}
          {staff ? (
            <Link href={`/readiness?resource=${detail.id}`} className="btn-secondary">
              Calibration &amp; stock
            </Link>
          ) : null}
          <Link href={`/operations?resource=${detail.id}`} className="btn-secondary">
            Report an issue
          </Link>
        </div>
      </div>

      <Flash error={query.error} ok={query.ok} />

      <div className="mb-5">
        <ReadinessPanel result={readiness} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-5">
          <section className="card-pad">
            <SectionHeading title="About this resource" />
            <p className="text-sm leading-relaxed text-ink/80">{detail.description || "No description provided."}</p>
            {Object.keys(detail.specs).length > 0 ? (
              <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2.5 border-t border-line pt-4 sm:grid-cols-2">
                {Object.entries(detail.specs).map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-3 text-sm">
                    <dt className="text-xs text-muted">{key}</dt>
                    <dd className="text-right font-medium text-ink/85">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>

          <section className="card-pad">
            <SectionHeading title="Access rules" description="Checked on every booking request." />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-canvas/60 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted">Training</p>
                <p className="mt-0.5 text-sm font-medium">
                  {detail.trainingName ?? "None required"}
                </p>
                {detail.trainingName ? (
                  <p className={`mt-0.5 text-[11px] ${detail.trainingValid ? "text-emerald-700" : "text-red-700"}`}>
                    {detail.trainingValid
                      ? `Valid until ${formatDate(detail.trainingExpiresAt!)}`
                      : "Not on file or expired — you cannot book yet"}
                  </p>
                ) : null}
              </div>
              <div className="rounded-lg border border-line bg-canvas/60 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted">Booking limits</p>
                <p className="mt-0.5 text-sm font-medium">Up to {formatHours(detail.maxHours)} per slot</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {user.maxActiveBookings} active bookings · {user.maxHorizonDays}-day horizon
                </p>
              </div>
              <div className="rounded-lg border border-line bg-canvas/60 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted">Approval</p>
                <p className="mt-0.5 text-sm font-medium">
                  {detail.requiresApproval ? "Facility manager reviews each request" : "Confirmed immediately"}
                </p>
              </div>
              <div className="rounded-lg border border-line bg-canvas/60 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted">Capacity</p>
                <p className="mt-0.5 text-sm font-medium">{detail.capacity} person(s)</p>
                {detail.openIncidents > 0 ? (
                  <p className="mt-0.5 text-[11px] text-amber-700">{detail.openIncidents} open incident(s)</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Opening hours</p>
              <div className="flex flex-wrap gap-1.5">
                {detail.rules.length === 0 ? (
                  <span className="text-xs text-muted">No availability configured.</span>
                ) : (
                  detail.rules.map((rule) => (
                    <span key={rule.weekday} className="rounded-md bg-white px-2 py-1 text-[11px] text-ink/75 ring-1 ring-line">
                      {WEEKDAYS[rule.weekday].slice(0, 3)} {rule.opensAt}–{rule.closesAt}
                    </span>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <SectionHeading title="Upcoming reservations" />
              <span className="text-xs text-muted">{detail.upcomingCount} active</span>
            </div>
            {detail.upcoming.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">Nothing booked on this resource yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {detail.upcoming.map((booking) => (
                  <li key={booking.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div>
                      <p className="text-sm font-medium">{formatRange(booking.startsAt, booking.endsAt)}</p>
                      <p className="text-xs text-muted">
                        {booking.userId === user.userId ? "You" : booking.userName}
                      </p>
                    </div>
                    <BookingBadge status={booking.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.blackouts.length > 0 ? (
            <section className="card-pad">
              <SectionHeading title="Blocked periods" description="Bookings are rejected inside these windows." />
              <ul className="space-y-2">
                {detail.blackouts.map((blackout) => (
                  <li key={blackout.id} className="flex items-start gap-2.5 rounded-lg bg-amber-50/70 px-3 py-2">
                    <Icon name="wrench" className="mt-0.5 h-3.5 w-3.5 text-amber-700" />
                    <div>
                      <p className="text-xs font-medium text-amber-900">{blackout.reason}</p>
                      <p className="text-[11px] text-amber-800/80">{formatRange(blackout.startsAt, blackout.endsAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {staff ? (
            <section className="card-pad">
              <SectionHeading title="Facility controls" description="Status changes are audited and block new bookings." />
              <form action={updateResourceStatusAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="resource_id" value={detail.id} />
                <input type="hidden" name="back_to" value={backTo} />
                <div className="sm:w-44">
                  <label className="label" htmlFor="status">
                    Status
                  </label>
                  <select id="status" name="status" defaultValue={detail.status} className="input">
                    <option value="ready">Ready</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="suspended">Suspended</option>
                    <option value="retired">Retired</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="label" htmlFor="note">
                    Reason / note
                  </label>
                  <input id="note" name="note" className="input" placeholder="Optional note for the audit trail" />
                </div>
                <SubmitButton className="btn-secondary" pendingLabel="Updating…">
                  Update status
                </SubmitButton>
              </form>
            </section>
          ) : null}
        </div>

        <div className="space-y-5 xl:sticky xl:top-24 xl:self-start">
          <section className="card overflow-hidden">
            <div className="border-b border-line bg-brand-50/50 px-5 py-4">
              <h2 className="text-sm font-semibold">Reserve a slot</h2>
              <p className="text-xs text-muted">
                {formatDate(`${dateKey}T12:00:00+05:30`)} · {detail.availability.closed ? "Closed" : `${detail.availability.openTime}–${detail.availability.closeTime}`}
              </p>
            </div>

            <div className="px-5 pt-4">
              <form action={`/resources/${detail.id}`} method="get" className="flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="date" className="label">
                    Date
                  </label>
                  <input id="date" name="date" type="date" defaultValue={dateKey} className="input" />
                </div>
                <div className="flex gap-1.5">
                  <Link
                    href={`/resources/${detail.id}?date=${shiftDays(dateKey, -1)}`}
                    className="btn-secondary px-2.5"
                    aria-label="Previous day"
                  >
                    ‹
                  </Link>
                  <button type="submit" className="btn-secondary">
                    Go
                  </button>
                  <Link
                    href={`/resources/${detail.id}?date=${shiftDays(dateKey, 1)}`}
                    className="btn-secondary px-2.5"
                    aria-label="Next day"
                  >
                    ›
                  </Link>
                </div>
              </form>

              {slots.length > 0 ? (
                <div className="mt-4">
                  <div className="flex flex-wrap gap-[3px]">
                    {slots.map((slot) => {
                      const tone =
                        slot.state === "free"
                          ? "bg-brand-100 border-brand-200"
                          : slot.state === "booked"
                            ? "bg-slate-200 border-slate-300"
                            : slot.state === "blackout"
                              ? "bg-amber-200 border-amber-300"
                              : "bg-transparent border-line";
                      return (
                        <span
                          key={slot.startsAt.toISOString()}
                          title={`${formatTime(slot.startsAt)} — ${slot.state}`}
                          className={`h-5 w-3.5 rounded-[3px] border ${tone}`}
                        />
                      );
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-brand-200" /> Free</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-slate-300" /> Booked</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-amber-300" /> Blocked</span>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="p-5">
              {!bookable ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
                  This resource is <strong>{detail.status}</strong>. Booking is disabled until facility staff release it.
                </div>
              ) : detail.availability.closed ? (
                <div className="rounded-lg border border-line bg-canvas px-3 py-3 text-xs text-muted">
                  Closed on this day. Pick another date to see availability.
                </div>
              ) : freeStarts.length === 0 ? (
                <div className="rounded-lg border border-line bg-canvas px-3 py-3 text-xs text-muted">
                  No usable free window on this day. Try the next day.
                </div>
              ) : (
                <form action={createBookingAction} className="space-y-3">
                  <input type="hidden" name="resource_id" value={detail.id} />
                  <input type="hidden" name="date" value={dateKey} />
                  <input type="hidden" name="request_key" value={randomUUID()} />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="start" className="label">
                        Start
                      </label>
                      <select id="start" name="start" required className="input">
                        {freeStarts.map((slot) => (
                          <option key={slot.value} value={slot.value}>
                            {slot.label} · up to {formatHours(slot.maxHours)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="hours" className="label">
                        Duration
                      </label>
                      <select id="hours" name="hours" required defaultValue="1" className="input">
                        {DURATIONS.filter((duration) => duration <= detail.maxHours).map((duration) => (
                          <option key={duration} value={duration}>
                            {formatHours(duration)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="purpose" className="label">
                      Purpose
                    </label>
                    <input
                      id="purpose"
                      name="purpose"
                      required
                      maxLength={200}
                      className="input"
                      placeholder="e.g. Dissertation sample run"
                    />
                  </div>
                  <div>
                    <label htmlFor="attendees" className="label">
                      Attendees
                    </label>
                    <input
                      id="attendees"
                      name="attendees"
                      type="number"
                      min={1}
                      max={detail.capacity}
                      defaultValue={1}
                      className="input"
                    />
                  </div>

                  {!detail.trainingValid ? (
                    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                      Training required: {detail.trainingName}. Ask a facility manager to record your certification.
                    </p>
                  ) : null}

                  <SubmitButton className="btn-primary w-full" pendingLabel="Reserving…">
                    {detail.requiresApproval ? "Request booking" : "Confirm booking"}
                  </SubmitButton>
                  <p className="text-center text-[10px] text-muted">
                    Availability, quota and training are re-checked on submit.
                  </p>
                </form>
              )}
            </div>
          </section>

          <section className="card-pad">
            <SectionHeading title="Need help?" />
            <p className="text-xs leading-relaxed text-muted">
              Facility managers can adjust a booking, record training or block the resource for maintenance. Report
              damage or unsafe conditions immediately from Operations.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/bookings" className="btn-secondary text-xs">
                My bookings
              </Link>
              <Link href="/operations" className="btn-secondary text-xs">
                Operations
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
