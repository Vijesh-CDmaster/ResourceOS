import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDashboard } from "@/lib/queries/dashboard";
import { markNotificationsReadAction } from "@/lib/actions/admin";
import { formatDate, formatRange, timeAgo } from "@/lib/format";
import { isStaff } from "@/lib/roles";
import { Icon } from "@/components/icons";
import { Badge, BookingBadge, EmptyState, Flash, Meter, PageHeader, SectionHeading, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date()),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; denied?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const data = await getDashboard(user.organizationId, user.userId, user.role);
  const staff = isStaff(user.role);
  const error = params.denied ? "You do not have access to that area." : params.error;

  return (
    <div>
      <PageHeader
        eyebrow={formatDate(new Date())}
        title={`${greeting()}, ${user.name.split(" ")[0]}`}
        description={
          staff
            ? "Here is the operational picture across the facility this week."
            : "Your bookings, certifications and facility updates in one place."
        }
        actions={
          <>
            <Link href="/resources" className="btn-primary">
              <Icon name="plus" className="h-4 w-4" />
              Book a resource
            </Link>
            {staff ? (
              <Link href="/approvals" className="btn-secondary">
                Review approvals
              </Link>
            ) : null}
          </>
        }
      />

      <Flash error={error} ok={params.ok} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Ready resources"
          value={`${data.stats.readyResources}/${data.stats.totalResources}`}
          hint="Available to eligible users"
        />
        <Stat
          label={staff ? "Pending approvals" : "My upcoming bookings"}
          value={staff ? data.stats.pendingApprovals : data.upcoming.length}
          hint={staff ? "Waiting on a facility manager" : "Requests and confirmed slots"}
          tone={data.stats.pendingApprovals > 0 && staff ? "amber" : "brand"}
        />
        <Stat
          label="Bookings today"
          value={data.stats.bookingsToday}
          hint="Confirmed or requested across the facility"
          tone="violet"
        />
        <Stat
          label="30-day no-show rate"
          value={`${data.stats.noShowRate.toFixed(1)}%`}
          hint={data.stats.openIncidents > 0 ? `${data.stats.openIncidents} open incident(s)` : "No open incidents"}
          tone={data.stats.noShowRate > 10 ? "amber" : "green"}
        />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[1.45fr_1fr]">
        <section className="card">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold">Your upcoming sessions</h2>
              <p className="text-xs text-muted">Check in from My bookings when you arrive.</p>
            </div>
            <Link href="/bookings" className="text-xs font-medium text-brand-700 hover:underline">
              View all
            </Link>
          </div>
          {data.upcoming.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No upcoming bookings"
                description="Browse the facility catalogue to reserve an instrument or workspace."
                action={
                  <Link href="/resources" className="btn-secondary">
                    Browse resources
                  </Link>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.upcoming.map((booking) => (
                <li key={booking.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                    <Icon name="calendar" className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{booking.resourceName}</p>
                    <p className="text-xs text-muted">{formatRange(booking.startsAt, booking.endsAt)}</p>
                  </div>
                  <BookingBadge status={booking.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section id="notifications" className="card scroll-mt-24">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold">Notifications</h2>
              <p className="text-xs text-muted">{data.unreadNotifications} unread</p>
            </div>
            {data.notifications.some((n) => !n.readAt) ? (
              <form action={markNotificationsReadAction}>
                <SubmitButton className="btn-ghost px-2 py-1 text-xs" pendingLabel="Marking…">
                  Mark all read
                </SubmitButton>
              </form>
            ) : null}
          </div>
          {data.notifications.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Nothing new right now.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.notifications.map((notification) => (
                <li key={notification.id} className="px-5 py-3.5">
                  <div className="flex items-start gap-2">
                    {!notification.readAt ? (
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                    ) : (
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-transparent" />
                    )}
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium leading-snug">{notification.title}</p>
                      {notification.body ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted">{notification.body}</p>
                      ) : null}
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                        <span>{timeAgo(notification.createdAt)}</span>
                        {notification.link ? (
                          <Link href={notification.link} className="font-medium text-brand-700 hover:underline">
                            Open
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <section className="card-pad">
          <SectionHeading
            title="Certifications on file"
            description="Bookings are blocked when training lapses."
          />
          {data.trainingExpiring.length === 0 ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              No certifications recorded. Some resources require training before booking.
            </p>
          ) : (
            <ul className="space-y-3">
              {data.trainingExpiring.map((training) => (
                <li key={training.courseName}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-ink">{training.courseName}</span>
                    <span className="text-muted">expires {formatDate(training.expiresAt)}</span>
                  </div>
                  <Meter value={70} tone="green" />
                </li>
              ))}
            </ul>
          )}
        </section>

        {staff ? (
          <section className="card-pad">
            <SectionHeading
              title="Recent activity"
              description="Every mutation is written to the audit trail."
              action={
                <Link href="/audit" className="text-xs font-medium text-brand-700 hover:underline">
                  Full trail
                </Link>
              }
            />
            {data.recentActivity.length === 0 ? (
              <p className="text-sm text-muted">No activity yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.recentActivity.map((event) => (
                  <li key={event.id} className="flex items-start gap-2.5 text-xs">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                      <Icon name="check" className="h-3 w-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="leading-snug text-ink/85">{event.summary}</p>
                      <p className="text-[11px] text-muted">
                        {event.actorName ?? "System"} · {timeAgo(event.createdAt)}
                      </p>
                    </div>
                    <Badge tone="slate">{event.action.split(".")[1]?.replace("_", " ")}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <section className="card-pad">
            <SectionHeading title="How booking works" description="Rules applied to every request." />
            <ol className="space-y-2.5 text-sm text-ink/80">
              {[
                "Membership and training are verified before a slot can be requested.",
                "PostgreSQL rejects overlapping reservations, even under concurrent submits.",
                "Approvals, check-in and check-out are recorded with actor and timestamp.",
                "Cancellations and rejections feed the unmet-demand report.",
              ].map((step, index) => (
                <li key={step} className="flex gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-700">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}
