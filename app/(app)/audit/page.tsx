import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { listAuditEvents } from "@/lib/queries/admin";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, EmptyState, Flash, PageHeader } from "@/components/ui";

const ACTION_GROUPS = [
  { value: "", label: "All events" },
  { value: "booking", label: "Bookings" },
  { value: "maintenance", label: "Maintenance" },
  { value: "incident", label: "Incidents" },
  { value: "training", label: "Training" },
  { value: "resource", label: "Resources" },
  { value: "organization", label: "Policy" },
  { value: "member", label: "Members" },
];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; error?: string; ok?: string }>;
}) {
  const user = await requireRole("admin", "manager", "technician");
  const params = await searchParams;
  const events = await listAuditEvents(user.organizationId, { action: params.action, limit: 150 });
  const href = (action: string) => (action ? `/audit?action=${action}` : "/audit");

  return (
    <div>
      <PageHeader
        eyebrow="Evidence"
        title="Audit trail"
        description="Append-only record of every consequential action: actor, entity and time."
        actions={
          <Link href="/api/reports/audit" className="btn-secondary">
            Export CSV
          </Link>
        }
      />

      <Flash error={params.error} ok={params.ok} />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {ACTION_GROUPS.map((group) => (
          <Link
            key={group.value}
            href={href(group.value)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              (params.action ?? "") === group.value
                ? "border-brand-700 bg-brand-700 text-white"
                : "border-line bg-white text-muted hover:border-brand-200"
            }`}
          >
            {group.label}
          </Link>
        ))}
      </div>

      {events.length === 0 ? (
        <EmptyState title="No audit events for this filter" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table min-w-[760px]">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Event</th>
                  <th>Summary</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap">
                      <p className="text-xs">{timeAgo(event.createdAt)}</p>
                      <p className="text-[10px] text-muted">{formatDateTime(event.createdAt)}</p>
                    </td>
                    <td>
                      <p className="text-xs font-medium">{event.actorName ?? "System"}</p>
                      <p className="text-[10px] capitalize text-muted">{event.actorRole ?? "automated"}</p>
                    </td>
                    <td>
                      <Badge tone="slate">{event.action}</Badge>
                    </td>
                    <td className="max-w-[360px] text-xs text-ink/80">{event.summary}</td>
                    <td>
                      <p className="text-[11px] text-muted">{event.entityType}</p>
                      {event.entityId ? (
                        <p className="font-mono text-[9px] text-muted">{event.entityId.slice(0, 8)}</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="mt-4 text-[11px] text-muted">
        Showing the latest {events.length} event(s). Exports include the full trail.
      </p>
    </div>
  );
}
