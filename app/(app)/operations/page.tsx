import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getResourceOptions } from "@/lib/queries/resources";
import {
  listIncidents,
  listMaintenance,
  listUpcomingBlackouts,
} from "@/lib/queries/operations";
import {
  createMaintenanceAction,
  reportIncidentAction,
  resolveIncidentAction,
  resolveMaintenanceAction,
} from "@/lib/actions/operations";
import { formatRange, istDateKey, timeAgo } from "@/lib/format";
import { canManage, isStaff } from "@/lib/roles";
import { Badge, EmptyState, Flash, PageHeader, SectionHeading, SeverityBadge } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { Icon } from "@/components/icons";

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; resource?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const staff = isStaff(user.role);
  const manager = canManage(user.role);
  const [resources, incidents, maintenance, blackouts] = await Promise.all([
    getResourceOptions(user.organizationId),
    listIncidents(user.organizationId),
    staff ? listMaintenance(user.organizationId) : Promise.resolve([]),
    listUpcomingBlackouts(user.organizationId),
  ]);

  const selectedResource = params.resource ?? "";
  const today = istDateKey();
  const openIncidents = incidents.filter((incident) => incident.status !== "resolved");
  const closedIncidents = incidents.filter((incident) => incident.status === "resolved");

  return (
    <div>
      <PageHeader
        eyebrow="Facility operations"
        title="Operations"
        description="Report incidents, schedule maintenance and keep resource status accurate for everyone."
        actions={
          <Link href="/resources" className="btn-secondary">
            Resource catalogue
          </Link>
        }
      />

      <Flash error={params.error} ok={params.ok} />

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <section className="card">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading
                title="Open incidents"
                description="Evidence stays attached to the resource, booking and reporter."
              />
            </div>
            {openIncidents.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No open incidents. Good news.</p>
            ) : (
              <ul className="divide-y divide-line">
                {openIncidents.map((incident) => (
                  <li key={incident.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{incident.title}</p>
                          <SeverityBadge severity={incident.severity} />
                          <Badge tone={incident.status === "open" ? "amber" : "violet"}>{incident.status}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          {incident.resourceCode} · {incident.resourceName} · reported by {incident.reportedByName} ·{" "}
                          {timeAgo(incident.createdAt)}
                        </p>
                      </div>
                    </div>
                    {incident.description ? (
                      <p className="mt-2 rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-ink/80">
                        {incident.description}
                      </p>
                    ) : null}
                    {manager ? (
                      <form action={resolveIncidentAction} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                        <input type="hidden" name="incident_id" value={incident.id} />
                        <div className="flex-1">
                          <label className="label" htmlFor={`resolution-${incident.id}`}>
                            Resolution
                          </label>
                          <input
                            id={`resolution-${incident.id}`}
                            name="resolution"
                            required
                            className="input"
                            placeholder="What was found and fixed?"
                          />
                        </div>
                        <label className="flex items-center gap-2 pb-2 text-[11px] text-muted">
                          <input type="checkbox" name="release_resource" value="yes" className="h-3.5 w-3.5" />
                          Mark resource ready
                        </label>
                        <SubmitButton className="btn-primary" pendingLabel="Closing…">
                          Close incident
                        </SubmitButton>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {staff ? (
            <section id="maintenance" className="card scroll-mt-24">
              <div className="border-b border-line px-5 py-4">
                <SectionHeading
                  title="Maintenance"
                  description="A maintenance window creates a booking blackout and can suspend the resource."
                />
              </div>
              {maintenance.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted">No maintenance records.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {maintenance.map((record) => (
                    <li key={record.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold">{record.title}</p>
                            <Badge
                              tone={
                                record.status === "resolved" ? "green" : record.status === "in_progress" ? "amber" : "slate"
                              }
                            >
                              {record.status.replace("_", " ")}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {record.resourceCode} · {record.resourceName}
                            {record.blackoutStart && record.blackoutEnd
                              ? ` · ${formatRange(record.blackoutStart, record.blackoutEnd)}`
                              : ""}
                          </p>
                          {record.description ? (
                            <p className="mt-1 text-xs text-ink/70">{record.description}</p>
                          ) : null}
                          <p className="mt-1 text-[11px] text-muted">
                            Created by {record.createdByName ?? "staff"} · {timeAgo(record.createdAt)}
                          </p>
                        </div>
                        {record.status !== "resolved" ? (
                          <form action={resolveMaintenanceAction}>
                            <input type="hidden" name="maintenance_id" value={record.id} />
                            <SubmitButton className="btn-secondary text-xs" pendingLabel="Closing…">
                              Mark resolved
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {closedIncidents.length > 0 ? (
            <section className="card">
              <div className="border-b border-line px-5 py-4">
                <SectionHeading title="Closed incidents" description="Resolution is preserved for audit." />
              </div>
              <ul className="divide-y divide-line">
                {closedIncidents.slice(0, 6).map((incident) => (
                  <li key={incident.id} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium">{incident.title}</p>
                      <Badge tone="green">resolved</Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {incident.resourceCode} · {timeAgo(incident.createdAt)}
                    </p>
                    {incident.resolution ? (
                      <p className="mt-1 text-[11px] text-ink/70">{incident.resolution}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="space-y-5">
          <section className="card-pad">
            <SectionHeading title="Report an incident" description="Anyone with access can raise a safety or damage issue." />
            <form action={reportIncidentAction} className="space-y-3">
              <div>
                <label htmlFor="resource_id" className="label">
                  Resource
                </label>
                <select id="resource_id" name="resource_id" required defaultValue={selectedResource} className="input">
                  <option value="" disabled>
                    Choose a resource
                  </option>
                  {resources.map((resource) => (
                    <option key={resource.id} value={resource.id}>
                      {resource.code} — {resource.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="title" className="label">
                  Summary
                </label>
                <input id="title" name="title" required maxLength={160} className="input" placeholder="Coolant leak near control cabinet" />
              </div>
              <div>
                <label htmlFor="description" className="label">
                  What happened?
                </label>
                <textarea id="description" name="description" rows={3} className="input" placeholder="Include time, symptoms and anything you already did." />
              </div>
              <div>
                <label htmlFor="severity" className="label">
                  Severity
                </label>
                <select id="severity" name="severity" defaultValue="medium" className="input">
                  <option value="low">Low — cosmetic or minor</option>
                  <option value="medium">Medium — affects operation</option>
                  <option value="high">High — safety or major damage</option>
                </select>
              </div>
              <SubmitButton className="btn-primary w-full" pendingLabel="Reporting…">
                Report incident
              </SubmitButton>
            </form>
          </section>

          {staff ? (
            <section className="card-pad">
              <SectionHeading
                title="Schedule maintenance"
                description="Overlapping bookings must be acknowledged before the window is blocked."
              />
              <form action={createMaintenanceAction} className="space-y-3">
                <div>
                  <label htmlFor="m_resource" className="label">
                    Resource
                  </label>
                  <select id="m_resource" name="resource_id" required defaultValue={selectedResource} className="input">
                    <option value="" disabled>
                      Choose a resource
                    </option>
                    {resources.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.code} — {resource.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="m_title" className="label">
                    Title
                  </label>
                  <input id="m_title" name="title" required maxLength={160} className="input" placeholder="Quarterly spindle alignment" />
                </div>
                <div>
                  <label htmlFor="m_description" className="label">
                    Work description
                  </label>
                  <textarea id="m_description" name="description" rows={2} className="input" placeholder="Vendor, scope, parts required" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="starts_at" className="label">
                      Starts
                    </label>
                    <input
                      id="starts_at"
                      name="starts_at"
                      type="datetime-local"
                      required
                      defaultValue={`${today}T09:00`}
                      className="input"
                    />
                  </div>
                  <div>
                    <label htmlFor="ends_at" className="label">
                      Ends
                    </label>
                    <input
                      id="ends_at"
                      name="ends_at"
                      type="datetime-local"
                      required
                      defaultValue={`${today}T17:00`}
                      className="input"
                    />
                  </div>
                </div>
                <label className="flex items-start gap-2 text-[11px] text-muted">
                  <input type="checkbox" name="force" value="yes" className="mt-0.5 h-3.5 w-3.5" />
                  Override existing bookings (they will be notified, not cancelled)
                </label>
                <SubmitButton className="btn-primary w-full" pendingLabel="Scheduling…">
                  Schedule maintenance
                </SubmitButton>
              </form>
            </section>
          ) : null}

          <section className="card-pad">
            <SectionHeading title="Upcoming blackouts" description="Booking is blocked inside these windows." />
            {blackouts.length === 0 ? (
              <EmptyState title="No upcoming blackouts" />
            ) : (
              <ul className="space-y-2.5">
                {blackouts.map((blackout) => (
                  <li key={blackout.id} className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700">
                      <Icon name="wrench" className="h-3.5 w-3.5" />
                    </span>
                    <div>
                      <p className="text-xs font-medium text-ink/85">
                        {blackout.resourceCode} · {blackout.reason}
                      </p>
                      <p className="text-[11px] text-muted">{formatRange(blackout.startsAt, blackout.endsAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
