import { requireRole } from "@/lib/auth";
import { getPendingApprovals } from "@/lib/queries/bookings";
import { decideBookingAction } from "@/lib/actions/bookings";
import { formatRange, timeAgo } from "@/lib/format";
import { EmptyState, Flash, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireRole("admin", "manager");
  const params = await searchParams;
  const pending = await getPendingApprovals(user.organizationId);

  return (
    <div>
      <PageHeader
        eyebrow="Booking control"
        title="Approvals"
        description="Review requests against training, capacity and existing commitments before confirming."
      />

      <Flash error={params.error} ok={params.ok} />

      {pending.length === 0 ? (
        <EmptyState
          title="No pending requests"
          description="Every approval request has been decided. New requests will appear here."
        />
      ) : (
        <div className="space-y-4">
          {pending.map((booking) => (
            <article key={booking.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{booking.resourceName}</h2>
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted">
                      {booking.resourceCode}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{formatRange(booking.startsAt, booking.endsAt)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium">{booking.userName}</p>
                  <p className="text-[11px] text-muted">{booking.userEmail}</p>
                  <p className="mt-1 text-[11px] text-muted">requested {timeAgo(booking.createdAt)}</p>
                </div>
              </div>

              <div className="grid gap-4 px-5 py-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Purpose</p>
                  <p className="mt-0.5 text-sm text-ink/85">{booking.purpose || "—"}</p>
                  <p className="mt-1 text-[11px] text-muted">{booking.attendees} attendee(s)</p>
                </div>
                <form action={decideBookingAction} className="flex w-full flex-col gap-2 sm:w-80">
                  <input type="hidden" name="booking_id" value={booking.id} />
                  <input
                    name="note"
                    className="input"
                    placeholder="Decision note (visible to the requester)"
                    maxLength={300}
                  />
                  <div className="flex gap-2">
                    <SubmitButton
                      className="btn-primary flex-1"
                      name="decision"
                      value="approve"
                      pendingLabel="Approving…"
                    >
                      Approve
                    </SubmitButton>
                    <SubmitButton
                      className="btn-danger flex-1"
                      name="decision"
                      value="reject"
                      pendingLabel="Rejecting…"
                    >
                      Reject
                    </SubmitButton>
                  </div>
                </form>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
