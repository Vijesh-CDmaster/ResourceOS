import { requireRole } from "@/lib/auth";
import { canManage } from "@/lib/roles";
import { listConnections, listQuarantine, listSyncRuns } from "@/lib/queries/integrations";
import { listConnectors } from "@/lib/integrations/registry";
import { createConnectionAction, revokeConnectionAction, syncConnectionAction } from "@/lib/actions/integrations";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, EmptyState, Flash, PageHeader, SectionHeading } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const RUN_TONE: Record<string, "green" | "amber" | "red"> = {
  succeeded: "green",
  running: "amber",
  partial: "amber",
  failed: "red",
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireRole("admin", "manager");
  const params = await searchParams;
  const [connections, runs, quarantine] = await Promise.all([
    listConnections(user.organizationId),
    listSyncRuns(user.organizationId),
    listQuarantine(user.organizationId),
  ]);
  const connectors = listConnectors();
  const isAdmin = user.role === "admin";
  const openIssues = quarantine.filter((item) => !item.resolvedAt);

  return (
    <div>
      <PageHeader
        eyebrow="External systems"
        title="Integrations"
        description="Connect external booking, laboratory-management, finance and maintenance systems. Imported records stay inside this institution; nothing is shared across tenants."
      />

      <Flash error={params.error} ok={params.ok} />

      <section className="card mb-5">
        <div className="border-b border-line px-5 py-4">
          <SectionHeading
            title="Connections"
            description="Each connection is bound to this workspace and runs with its own source identifiers, checkpoint and quarantine."
          />
        </div>
        {connections.length === 0 ? (
          <div className="px-5 py-8">
            <EmptyState
              title="No connections yet"
              description="Add one below to import resources or bookings from another system."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[860px]">
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Status</th>
                  <th className="text-right">Mapped records</th>
                  <th className="text-right">Open issues</th>
                  <th>Last sync</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => {
                  const active = connection.status === "active";
                  return (
                    <tr key={connection.id}>
                      <td>
                        <p className="text-sm font-medium">{connection.name}</p>
                        <p className="text-[11px] text-muted">
                          {connection.provider}
                          {connection.hasCredentials ? " · credentials stored" : " · no credentials"}
                        </p>
                      </td>
                      <td>
                        <Badge tone={active ? "green" : "slate"}>{connection.status}</Badge>
                      </td>
                      <td className="text-right text-xs">{connection.mappedEntities}</td>
                      <td className="text-right text-xs">
                        {connection.openIssues > 0 ? (
                          <span className="font-semibold text-amber-700">{connection.openIssues}</span>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </td>
                      <td className="text-xs text-muted">
                        {connection.lastSyncedAt ? (
                          <>
                            <p>{timeAgo(connection.lastSyncedAt)}</p>
                            {connection.lastRunStatus ? (
                              <Badge tone={RUN_TONE[connection.lastRunStatus] ?? "slate"}>
                                {connection.lastRunStatus}
                              </Badge>
                            ) : null}
                          </>
                        ) : (
                          "never"
                        )}
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-1.5">
                          {active && canManage(user.role) ? (
                            <>
                              <form action={syncConnectionAction}>
                                <input type="hidden" name="connection_id" value={connection.id} />
                                <input type="hidden" name="mode" value="incremental" />
                                <SubmitButton className="btn-secondary" pendingLabel="Syncing…">
                                  Sync
                                </SubmitButton>
                              </form>
                              <form action={syncConnectionAction}>
                                <input type="hidden" name="connection_id" value={connection.id} />
                                <input type="hidden" name="mode" value="full" />
                                <SubmitButton className="btn-secondary" pendingLabel="Re-syncing…">
                                  Re-sync
                                </SubmitButton>
                              </form>
                            </>
                          ) : null}
                          {active && isAdmin ? (
                            <form action={revokeConnectionAction}>
                              <input type="hidden" name="connection_id" value={connection.id} />
                              <SubmitButton className="btn-secondary" pendingLabel="Revoking…">
                                Revoke
                              </SubmitButton>
                            </form>
                          ) : null}
                          {!active ? (
                            <span className="text-[11px] text-muted">
                              revoked{connection.revokedAt ? ` ${formatDateTime(connection.revokedAt)}` : ""}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <section className="card">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading
                title="Sync history"
                description="Every run records what it imported, skipped or quarantined. A run that stops at the page limit is marked partial — run it again to continue."
              />
            </div>
            {runs.length === 0 ? (
              <div className="px-5 py-8">
                <EmptyState title="No sync runs yet" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Status</th>
                      <th className="text-right">In / Upd / Dup</th>
                      <th className="text-right">Held / Failed</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <p className="text-xs font-medium">{run.connectionName}</p>
                          <p className="text-[11px] text-muted">{run.mode}</p>
                        </td>
                        <td>
                          <Badge tone={RUN_TONE[run.status] ?? "slate"}>{run.status}</Badge>
                          {run.error ? <p className="mt-1 max-w-[240px] truncate text-[11px] text-red-700">{run.error}</p> : null}
                          {run.note ? (
                            <p className="mt-1 max-w-[240px] text-[11px] text-amber-700">{run.note}</p>
                          ) : null}
                        </td>
                        <td className="text-right text-xs">
                          {run.imported} / {run.updated} / {run.duplicates}
                        </td>
                        <td className="text-right text-xs">
                          {run.quarantined} / {run.failed}
                        </td>
                        <td className="text-xs text-muted">{timeAgo(run.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading
                title="Quarantine"
                description="Records that failed validation, conflicted with local data or errored. Fix the source, then run a re-sync to retry them."
              />
            </div>
            {quarantine.length === 0 ? (
              <div className="px-5 py-8">
                <EmptyState title="Nothing quarantined" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Record</th>
                      <th>Reason</th>
                      <th>Message</th>
                      <th className="text-right">Attempts</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quarantine.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <p className="font-mono text-[11px]">{item.externalId}</p>
                          <p className="text-[10px] uppercase tracking-wide text-muted">
                            {item.connectionName} · {item.entityType}
                          </p>
                        </td>
                        <td>
                          <Badge tone={item.reason === "error" ? "red" : item.reason === "conflict" ? "amber" : "slate"}>
                            {item.reason}
                          </Badge>
                          {item.resolvedAt ? (
                            <p className="mt-1 text-[10px] text-emerald-700">resolved</p>
                          ) : null}
                        </td>
                        <td className="max-w-[280px] text-xs text-muted">{item.message}</td>
                        <td className="text-right text-xs">{item.attempts}</td>
                        <td className="text-xs text-muted">{timeAgo(item.lastSeenAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {openIssues.length > 0 ? (
              <p className="border-t border-line px-5 py-3 text-[11px] text-muted">
                {openIssues.length} record(s) still held. A re-sync revalidates each one; anything still invalid stays queued
                instead of blocking the rest of the feed.
              </p>
            ) : null}
          </section>
        </div>

        <div className="space-y-5">
          <section className="card-pad">
            <SectionHeading title="Available connectors" description="A connector is code, not configuration: see docs/integrations.md." />
            <ul className="mt-3 space-y-3">
              {connectors.map((connector) => (
                <li key={connector.id} className="rounded-lg border border-line p-3">
                  <p className="text-sm font-medium">{connector.label}</p>
                  <p className="font-mono text-[10px] text-muted">{connector.id}</p>
                  <p className="mt-1 text-xs text-muted">{connector.description}</p>
                  <p className="mt-1 text-[11px] text-muted">Entities: {connector.entities.join(", ")}</p>
                </li>
              ))}
            </ul>
          </section>

          {isAdmin ? (
            <section className="card-pad">
              <SectionHeading
                title="New connection"
                description="Credentials are encrypted with the server key before they are stored and are never shown again."
              />
              <form action={createConnectionAction} className="mt-3 space-y-3">
                <div>
                  <label htmlFor="provider" className="label">
                    Provider
                  </label>
                  <select id="provider" name="provider" required className="input">
                    {connectors.map((connector) => (
                      <option key={connector.id} value={connector.id}>
                        {connector.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="name" className="label">
                    Name
                  </label>
                  <input id="name" name="name" required maxLength={80} className="input" placeholder="Central instrumentation feed" />
                </div>
                <div>
                  <label htmlFor="config" className="label">
                    Settings (JSON, non-secret)
                  </label>
                  <textarea
                    id="config"
                    name="config"
                    rows={5}
                    className="input font-mono text-[11px]"
                    placeholder={'{\n  "records": [\n    { "entityType": "resource", "externalId": "SEM-01", "payload": { "code": "SEM-01", "name": "Scanning Electron Microscope" } }\n  ]\n}'}
                  />
                </div>
                <div>
                  <label htmlFor="credentials" className="label">
                    Credentials (JSON, encrypted)
                  </label>
                  <textarea
                    id="credentials"
                    name="credentials"
                    rows={2}
                    className="input font-mono text-[11px]"
                    placeholder={'{ "apiKey": "…" }'}
                  />
                </div>
                <SubmitButton className="btn-primary w-full" pendingLabel="Creating…">
                  Create connection
                </SubmitButton>
              </form>
              <p className="mt-3 text-[11px] text-muted">
                Credentials require <code className="font-mono">INTEGRATION_ENCRYPTION_KEY</code> on the server. Revoking a
                connection deletes its stored credentials and checkpoint, keeping the imported records and audit trail.
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
