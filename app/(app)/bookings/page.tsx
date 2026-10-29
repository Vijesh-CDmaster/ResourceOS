import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listBookings } from "@/lib/queries/bookings";
import { cancelBookingAction, checkInAction, checkOutAction } from "@/lib/actions/bookings";
import { formatRange, formatTime } from "@/lib/format";
import { canManage } from "@/lib/roles";
import { BookingBadge, EmptyState, Flash, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { Icon } from "@/components/icons";

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "requested", label: "Requested" },
  { value: "confirmed", label: "Confirmed" },
  { value: "completed", label: "Completed" },
  { value: "no_show", label: "No-show" },
  { value: "cancelled", label: "Cancelled" },
];

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; status?: string; error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const staffScope = canManage(user.role) && params.scope === "all";
  const bookings = await listBookings(user.organizationId, {
    userId: staffScope ? undefined : user.userId,
    status: params.status || undefined,
    limit: 100,
  });

  const tabHref = (status: string) => {
    const search = new URLSearchParams();
    if (params.scope) search.set("scope", params.scope);
    if (status) search.set("status", status);
    const query = search.toString();
    return query ? `/bookings?${query}` : "/bookings";
  };

  return (
    <div>
      <PageHeader
        eyebrow="Reservations"
        title={staffScope ? "All bookings" : "My bookings"}
        description="Check in at the start of your slot, close it when you finish, and cancel early if plans change."
        actions={
          <>
            {canManage(user.role) ? (
              <Link
                href={staffScope ? "/bookings" : "/bookings?scope=all"}
                className="btn-secondary"
              >
                {staffScope ? "Show only mine" : "View all facility bookings"}
              </Link>
            ) : null}
            <Link href="/resources" className="btn-primary">
              <Icon name="plus" className="h-4 w-4" />
              New booking
            </Link>
          </>
        }
      />

      <Flash error={params.error} ok={params.ok} />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={tabHref(tab.value)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              (params.status ?? "") === tab.value
                ? "border-brand-700 bg-brand-700 text-white"
                : "border-line bg-white text-muted hover:border-brand-200"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {bookings.length === 0 ? (
        <EmptyState
          title="No bookings here"
          description="Reserve a resource to start building usage history for reporting."
          action={
            <Link href="/resources" className="btn-primary">
              Browse resources
            </Link>
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table min-w-[860px]">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Slot</th>
                  {staffScope ? <th>Booked by</th> : null}
                  <th>Purpose</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => {
                  const canCheckIn = booking.checkInOpen;
                  const canCheckOut = booking.hasOpenSession;
                  const canCancel = booking.cancellable;
                  const backTo = staffScope ? "/bookings?scope=all" : "/bookings";

                  return (
                    <tr key={booking.id} className="align-top">
                      <td>
                        <p className="text-sm font-medium">{booking.resourceName}</p>
                        <p className="font-mono text-[10px] uppercase tracking-wide text-muted">{booking.resourceCode}</p>
                      </td>
                      <td>
                        <p className="text-xs">{formatRange(booking.startsAt, booking.endsAt)}</p>
                        {booking.checkedInAt ? (
                          <p className="mt-0.5 text-[11px] text-emerald-700">
                            Checked in {formatTime(booking.checkedInAt)}
                            {booking.checkedOutAt ? ` · out ${formatTime(booking.checkedOutAt)}` : ""}
                          </p>
                        ) : null}
                      </td>
                      {staffScope ? (
                        <td>
                          <p className="text-xs font-medium">{booking.userName}</p>
                          <p className="text-[11px] text-muted">{booking.userEmail}</p>
                        </td>
                      ) : null}
                      <td className="max-w-[220px]">
                        <p className="truncate text-xs text-ink/80">{booking.purpose || "—"}</p>
                        <p className="text-[11px] text-muted">{booking.attendees} attendee(s)</p>
                      </td>
                      <td>
                        <BookingBadge status={booking.status} />
                        {booking.decisionNote ? (
                          <p className="mt-1 max-w-[180px] text-[11px] text-muted">{booking.decisionNote}</p>
                        ) : null}
                        {booking.cancelReason ? (
                          <p className="mt-1 max-w-[180px] text-[11px] text-muted">{booking.cancelReason}</p>
                        ) : null}
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {canCheckIn ? (
                            <form action={checkInAction}>
                              <input type="hidden" name="booking_id" value={booking.id} />
                              <input type="hidden" name="back_to" value={backTo} />
                              <SubmitButton className="btn-primary px-2.5 py-1 text-xs" pendingLabel="…">
                                Check in
                              </SubmitButton>
                            </form>
                          ) : null}
                          {canCheckOut ? (
                            <details className="relative">
                              <summary className="btn-secondary cursor-pointer list-none px-2.5 py-1 text-xs">
                                Close session
                              </summary>
                              <form
                                action={checkOutAction}
                                className="absolute right-0 z-20 mt-1 w-64 space-y-2 rounded-xl border border-line bg-white p-3 shadow-lg"
                              >
                                <input type="hidden" name="booking_id" value={booking.id} />
                                <input type="hidden" name="back_to" value={backTo} />
                                <div>
                                  <label className="label" htmlFor={`condition-${booking.id}`}>
                                    Condition
                                  </label>
                                  <input
                                    id={`condition-${booking.id}`}
                                    name="condition"
                                    className="input"
                                    placeholder="Returned clean"
                                  />
                                </div>
                                <div>
                                  <label className="label" htmlFor={`consumables-${booking.id}`}>
                                    Consumables used
                                  </label>
                                  <input id={`consumables-${booking.id}`} name="consumables" className="input" placeholder="Optional" />
                                </div>
                                <SubmitButton className="btn-primary w-full py-1.5 text-xs" pendingLabel="Closing…">
                                  Record checkout
                                </SubmitButton>
                              </form>
                            </details>
                          ) : null}
                          {canCancel ? (
                            <form action={cancelBookingAction}>
                              <input type="hidden" name="booking_id" value={booking.id} />
                              <input type="hidden" name="back_to" value={backTo} />
                              <input type="hidden" name="reason" value="Cancelled by user" />
                              <SubmitButton className="btn-danger px-2.5 py-1 text-xs" pendingLabel="…">
                                Cancel
                              </SubmitButton>
                            </form>
                          ) : null}
                          {!canCheckIn && !canCheckOut && !canCancel ? (
                            <span className="text-[11px] text-muted">—</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="mt-4 text-[11px] text-muted">
        Check-in opens 30 minutes before the slot. Unexcused no-shows are recorded automatically after the grace period.
      </p>
    </div>
  );
}
