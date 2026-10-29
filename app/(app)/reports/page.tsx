import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getReports } from "@/lib/queries/reports";
import { formatHours, istDateKey, shiftDays } from "@/lib/format";
import { EmptyState, Flash, Meter, PageHeader, SectionHeading, Stat } from "@/components/ui";
import { Icon } from "@/components/icons";

const REASON_LABEL: Record<string, string> = {
  conflict: "Slot conflict",
  no_training: "Training missing",
  quota: "Quota reached",
  blackout: "Blocked window",
  resource_down: "Resource unavailable",
  approval_rejected: "Approval rejected",
  not_ready: "Resource not ready",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; error?: string; ok?: string }>;
}) {
  const user = await requireRole("admin", "manager", "technician");
  const params = await searchParams;
  const today = istDateKey();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? "") ? params.from! : shiftDays(today, -30);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? "") ? params.to! : today;
  const report = await getReports(user.organizationId, from, to);
  const query = `from=${from}&to=${to}`;
  const maxWeekly = Math.max(1, ...report.weekly.map((point) => point.bookings));
  const unmetTotal = report.unmetDemand.reduce((sum, row) => sum + row.count, 0);

  return (
    <div>
      <PageHeader
        eyebrow="Decision support"
        title="Utilization & demand"
        description="Downtime-adjusted utilization, no-show rate and unmet demand for the selected period."
        actions={
          <>
            <Link href={`/api/reports/utilization?${query}`} className="btn-secondary">
              <Icon name="chart" className="h-4 w-4" />
              Export utilization CSV
            </Link>
            <Link href={`/api/reports/bookings?${query}`} className="btn-secondary">
              Export bookings
            </Link>
          </>
        }
      />

      <Flash error={params.error} ok={params.ok} />

      <form action="/reports" method="get" className="card mb-5 flex flex-wrap items-end gap-3 p-3.5">
        <div>
          <label htmlFor="from" className="label">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={from} className="input w-44" />
        </div>
        <div>
          <label htmlFor="to" className="label">
            To
          </label>
          <input id="to" name="to" type="date" defaultValue={to} className="input w-44" />
        </div>
        <button type="submit" className="btn-primary">
          Apply range
        </button>
        <span className="pb-2 text-xs text-muted">
          {report.utilization.length} resources · {report.totals.bookings} bookings in range
        </span>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Utilization"
          value={`${report.totals.utilizationPct.toFixed(1)}%`}
          hint={`${formatHours(report.totals.bookedHours)} booked of ${formatHours(report.totals.availableHours)} available`}
        />
        <Stat
          label="Actual usage"
          value={formatHours(report.totals.actualHours)}
          hint="From check-in to check-out"
          tone="violet"
        />
        <Stat
          label="No-show rate"
          value={`${report.totals.noShowRate.toFixed(1)}%`}
          hint={`${report.totals.noShows} no-show(s)`}
          tone={report.totals.noShowRate > 10 ? "amber" : "green"}
        />
        <Stat
          label="Unmet demand"
          value={report.totals.unmetDemand}
          hint="Rejected, blocked, conflicting or ineligible requests"
          tone={report.totals.unmetDemand > 0 ? "amber" : "slate"}
        />
      </div>

      <section className="card mt-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <SectionHeading title="Resource utilization" description="Booked hours ÷ (open hours − downtime)." />
          <Link href={`/api/reports/unmet-demand?${query}`} className="text-xs font-medium text-brand-700 hover:underline">
            Unmet demand CSV
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="table min-w-[820px]">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Status</th>
                <th className="text-right">Open</th>
                <th className="text-right">Downtime</th>
                <th className="text-right">Booked</th>
                <th className="text-right">Actual</th>
                <th className="text-right">No-shows</th>
                <th className="w-40">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {report.utilization.map((row) => (
                <tr key={row.resourceId}>
                  <td>
                    <p className="text-sm font-medium">{row.name}</p>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-muted">{row.code}</p>
                  </td>
                  <td>
                    <span className="text-xs capitalize text-muted">{row.status}</span>
                  </td>
                  <td className="text-right text-xs">{formatHours(row.availableHours)}</td>
                  <td className="text-right text-xs">{formatHours(row.downtimeHours)}</td>
                  <td className="text-right text-xs font-medium">{formatHours(row.bookedHours)}</td>
                  <td className="text-right text-xs">{formatHours(row.actualHours)}</td>
                  <td className="text-right text-xs">{row.noShows}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Meter
                        value={row.utilizationPct}
                        tone={row.utilizationPct > 80 ? "amber" : row.utilizationPct > 0 ? "brand" : "slate"}
                      />
                      <span className="w-10 text-right text-[11px] font-medium">
                        {row.utilizationPct.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <section className="card-pad">
          <SectionHeading
            title="Unmet demand"
            description="Every blocked or rejected attempt, grouped by cause."
            action={
              unmetTotal > 0 ? (
                <Link href={`/api/reports/unmet-demand?${query}`} className="text-xs font-medium text-brand-700 hover:underline">
                  Export
                </Link>
              ) : null
            }
          />
          {report.unmetDemand.length === 0 ? (
            <EmptyState title="No unmet demand recorded" />
          ) : (
            <ul className="space-y-2">
              {report.unmetDemand.map((row) => (
                <li key={`${row.resourceCode}-${row.reason}`} className="flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink/85">{row.resourceName}</p>
                    <p className="text-[11px] text-muted">{REASON_LABEL[row.reason] ?? row.reason}</p>
                  </div>
                  <span className="rounded-full bg-canvas px-2 py-0.5 font-semibold text-ink/70">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card-pad">
          <SectionHeading title="Weekly completed volume" description="Completed, cancelled and no-show bookings per week." />
          {report.weekly.length === 0 ? (
            <EmptyState title="No history in this range" />
          ) : (
            <div className="flex h-36 items-end gap-2">
              {report.weekly.map((point) => (
                <div key={point.week} className="flex flex-1 flex-col items-center gap-1">
                  <div className="relative flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t bg-brand-500/85"
                      style={{ height: `${Math.max(4, (point.bookings / maxWeekly) * 100)}%` }}
                      title={`${point.bookings} bookings, ${point.noShows} no-shows`}
                    />
                    {point.noShows > 0 ? (
                      <div
                        className="absolute bottom-0 w-full rounded-t bg-red-400/70"
                        style={{ height: `${Math.max(2, (point.noShows / maxWeekly) * 100)}%` }}
                      />
                    ) : null}
                  </div>
                  <span className="text-[9px] text-muted">{point.week.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-4 text-[10px] text-muted">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-brand-500" /> Bookings</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-red-400" /> No-shows</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3 text-xs">
            <p className="text-muted">Incidents open</p>
            <p className="text-right font-semibold">{report.incidents.open}</p>
            <p className="text-muted">Investigating</p>
            <p className="text-right font-semibold">{report.incidents.investigating}</p>
            <p className="text-muted">High severity</p>
            <p className="text-right font-semibold text-red-700">{report.incidents.high}</p>
          </div>
        </section>
      </div>

      <section className="card mt-5 overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <SectionHeading title="Most active users" description="Useful for fair-allocation reviews; never for automated penalties." />
        </div>
        <div className="overflow-x-auto">
          <table className="table min-w-[640px]">
            <thead>
              <tr>
                <th>User</th>
                <th>Department</th>
                <th className="text-right">Bookings</th>
                <th className="text-right">Hours</th>
                <th className="text-right">No-shows</th>
              </tr>
            </thead>
            <tbody>
              {report.topUsers.map((row) => (
                <tr key={row.userId}>
                  <td>
                    <p className="text-sm font-medium">{row.userName}</p>
                    <p className="text-[11px] text-muted">{row.email}</p>
                  </td>
                  <td className="text-xs">{row.department ?? "—"}</td>
                  <td className="text-right text-xs">{row.bookings}</td>
                  <td className="text-right text-xs font-medium">{formatHours(row.hours)}</td>
                  <td className="text-right text-xs">{row.noShows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
