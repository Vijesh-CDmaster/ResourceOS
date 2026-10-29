import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManage, isStaff } from "@/lib/roles";
import { getResourceOptions } from "@/lib/queries/resources";
import {
  getDeliverySummary,
  listAssignableStaff,
  listConvertibleIncidents,
  listOverrides,
  listWorkOrders,
} from "@/lib/queries/work-orders";
import {
  assignWorkOrderAction,
  completeRepairAction,
  createEmergencyOverrideAction,
  createWorkOrderAction,
  escalateWorkOrderAction,
  releaseWorkOrderAction,
  reopenWorkOrderAction,
  resumeWorkOrderAction,
  revokeEmergencyOverrideAction,
  startWorkOrderAction,
  verifyWorkOrderAction,
  waitForPartsAction,
} from "@/lib/actions/work-orders";
import {
  OVERRIDE_ACTIONS,
  OVERRIDE_ACTION_LABEL,
  WORK_ORDER_STATUS_LABEL,
  isOpenStatus,
  isReleasable,
  statusMeaning,
  type OverrideAction,
  type WorkOrderStatus,
} from "@/lib/work-orders";
import { EMAIL_SETUP_PATH } from "@/lib/notifications";
import { formatDateTime, istDateKey, timeAgo } from "@/lib/format";
import { Badge, EmptyState, Flash, PageHeader, SectionHeading, Stat, type Tone } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { Icon } from "@/components/icons";

const STATUS_TONE: Record<WorkOrderStatus, Tone> = {
  reported: "amber",
  assigned: "brand",
  in_progress: "violet",
  waiting_parts: "amber",
  repair_completed: "brand",
  awaiting_verification: "amber",
  verified: "green",
  closed: "slate",
};

function priorityTone(priority: string): Tone {
  if (priority === "urgent") return "red";
  if (priority === "high") return "amber";
  return "slate";
}

function deliveryTone(status: string): Tone {
  if (status === "sent") return "green";
  if (status === "failed") return "red";
  if (status === "unavailable") return "amber";
  return "slate";
}

function money(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; incident?: string; error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  if (!isStaff(user.role)) redirect("/dashboard?denied=1");
  const params = await searchParams;
  const staff = isStaff(user.role);
  const manager = canManage(user.role);

  const [orders, incidents, staffList, overrides, delivery, resources] = await Promise.all([
    listWorkOrders(user.organizationId),
    listConvertibleIncidents(user.organizationId),
    manager ? listAssignableStaff(user.organizationId) : Promise.resolve([]),
    listOverrides(user.organizationId),
    getDeliverySummary(user.organizationId),
    getResourceOptions(user.organizationId),
  ]);

  const selected =
    orders.find((order) => order.id === params.order) ??
    orders.find((order) => order.incidentId && order.incidentId === params.incident) ??
    orders[0] ??
    null;

  const open = orders.filter((order) => isOpenStatus(order.status));
  const awaiting = open.filter((order) => order.status === "awaiting_verification");
  const held = orders.filter((order) => order.activeHold).length;
  const presetIncident = incidents.find((incident) => incident.id === params.incident) ?? null;

  return (
    <div>
      <PageHeader
        eyebrow="Facility operations"
        title="Work orders"
        description="Convert an incident into a job, record the repair, verify it independently where required, and release the asset explicitly. A completed repair never releases an asset by itself."
        actions={
          <>
            <Link href="/readiness" className="btn-secondary">
              Readiness board
            </Link>
            <Link href="/operations" className="btn-secondary">
              Operations
            </Link>
          </>
        }
      />

      <Flash error={params.error} ok={params.ok} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Open work orders" value={open.length} hint={`${orders.length} in total`} />
        <Stat label="Awaiting verification" value={awaiting.length} hint="Independent check required" tone="amber" />
        <Stat label="Assets held" value={held} hint="Not bookable until released" tone="red" />
        <Stat
          label="Email delivery"
          value={delivery.unavailable > 0 ? "Not configured" : delivery.pending > 0 ? `${delivery.pending} queued` : delivery.sent}
          hint={delivery.unavailable > 0 ? "In-app only" : "See outbox"}
          tone={delivery.unavailable > 0 ? "amber" : "green"}
        />
      </div>

      {delivery.unavailable > 0 ? (
        <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
          <strong>{delivery.unavailable} message{delivery.unavailable === 1 ? "" : "s"} recorded as unavailable.</strong>{" "}
          {EMAIL_SETUP_PATH} No email is ever reported as sent by this build.
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
          <section className="card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <SectionHeading title="Work orders" description="Open jobs first, then by priority." />
              <p className="text-[11px] text-muted">Status history is append-only</p>
            </div>
            {orders.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="No work orders yet"
                  description="Raise one from an open incident to start the repair and release process."
                />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {orders.map((order) => {
                  const active = selected?.id === order.id;
                  return (
                    <li key={order.id} className={active ? "bg-brand-50/40" : undefined}>
                      <Link
                        href={`/work-orders?order=${order.id}`}
                        className="block px-5 py-4 transition hover:bg-canvas"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[11px] text-muted">{order.code}</span>
                          <p className="text-sm font-semibold text-ink">{order.resourceName}</p>
                          <Badge tone={STATUS_TONE[order.status]}>{WORK_ORDER_STATUS_LABEL[order.status]}</Badge>
                          <Badge tone={priorityTone(order.priority)}>{order.priority}</Badge>
                          {order.activeHold ? <Badge tone="red">held</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          {order.incidentTitle ?? order.diagnosis ?? "No diagnosis recorded"} ·{" "}
                          {order.assigneeName ?? order.vendorName ?? "Unassigned"} · raised {timeAgo(order.createdAt)}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {staff ? (
            <section className="card-pad">
              <SectionHeading
                title="Raise a work order"
                description="Convert an open incident, or open a job directly against an asset."
              />
              {incidents.length === 0 && orders.length > 0 ? (
                <p className="mb-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
                  No open incident is waiting for a work order. You can still raise one against an asset.
                </p>
              ) : null}
              <form action={createWorkOrderAction} className="space-y-3">
                <div>
                  <label htmlFor="incident_id" className="label">
                    Open incident (optional)
                  </label>
                  <select
                    id="incident_id"
                    name="incident_id"
                    defaultValue={presetIncident?.id ?? ""}
                    className="input"
                  >
                    <option value="">No incident — raise against an asset</option>
                    {incidents.map((incident) => (
                      <option key={incident.id} value={incident.id}>
                        {incident.severity.toUpperCase()} · {incident.resourceCode} · {incident.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="resource_id" className="label">
                      Asset (when no incident is chosen)
                    </label>
                    <select id="resource_id" name="resource_id" defaultValue={presetIncident?.resourceId ?? ""} className="input">
                      <option value="">Choose an asset</option>
                      {resources.map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.code} — {resource.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="priority" className="label">
                      Priority
                    </label>
                    <select id="priority" name="priority" defaultValue="normal" className="input">
                      <option value="urgent">Urgent</option>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="assignee_id" className="label">
                      Assign to (optional)
                    </label>
                    <select id="assignee_id" name="assignee_id" className="input">
                      <option value="">Leave unassigned</option>
                      {staffList.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name} · {person.role}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="vendor_name" className="label">
                      External provider (optional)
                    </label>
                    <input id="vendor_name" name="vendor_name" maxLength={120} className="input" placeholder="Vendor or AMC partner" />
                  </div>
                </div>
                <div>
                  <label htmlFor="diagnosis" className="label">
                    Diagnosis / scope
                  </label>
                  <textarea
                    id="diagnosis"
                    name="diagnosis"
                    rows={2}
                    maxLength={2000}
                    className="input"
                    placeholder="What is suspected, and what must be checked before release?"
                  />
                </div>
                <p className="text-[11px] text-muted">
                  Raising a work order holds the asset. The hold is released only by an authorised release.
                </p>
                <SubmitButton className="btn-primary" pendingLabel="Raising…">
                  Raise work order
                </SubmitButton>
              </form>
            </section>
          ) : null}
        </div>

        <div className="space-y-5">
          {selected ? (
            <section className="card overflow-hidden">
              <div className="border-b border-line px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-muted">{selected.code}</span>
                  <Badge tone={STATUS_TONE[selected.status]}>{WORK_ORDER_STATUS_LABEL[selected.status]}</Badge>
                  <Badge tone={priorityTone(selected.priority)}>{selected.priority}</Badge>
                  {selected.activeHold ? <Badge tone="red">asset held</Badge> : <Badge tone="green">no hold</Badge>}
                </div>
                <h2 className="mt-1.5 text-lg font-semibold text-ink">{selected.resourceName}</h2>
                <p className="mt-0.5 text-xs text-muted">
                  {statusMeaning(selected.status, selected.requiresVerification)}
                </p>
              </div>

              <div className="space-y-4 px-5 py-4">
                <dl className="grid grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <dt className="text-muted">Raised by</dt>
                    <dd className="font-medium text-ink/85">
                      {selected.createdByName ?? "—"} · {formatDateTime(selected.createdAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Assigned</dt>
                    <dd className="font-medium text-ink/85">
                      {selected.assigneeName ?? selected.vendorName ?? "Unassigned"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Repair signed off by</dt>
                    <dd className="font-medium text-ink/85">
                      {selected.repairCompletedByName ?? "—"}
                      {selected.repairCompletedAt ? ` · ${formatDateTime(selected.repairCompletedAt)}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Verified by</dt>
                    <dd className="font-medium text-ink/85">
                      {selected.verifiedByName ?? (selected.requiresVerification ? "Required" : "Not required")}
                      {selected.verifiedAt ? ` · ${formatDateTime(selected.verifiedAt)}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Parts / labour</dt>
                    <dd className="font-medium text-ink/85">
                      {selected.partsUsed || "—"} · {selected.labourHours}h
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Cost (estimate / actual)</dt>
                    <dd className="font-medium text-ink/85">
                      {money(selected.estimatedCost)} / {money(selected.actualCost)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Downtime</dt>
                    <dd className="font-medium text-ink/85">
                      {selected.downtimeStart ? formatDateTime(selected.downtimeStart) : "Not started"}
                      {selected.downtimeEnd ? ` → ${formatDateTime(selected.downtimeEnd)}` : " → ongoing"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Incident</dt>
                    <dd className="font-medium text-ink/85">{selected.incidentTitle ?? "—"}</dd>
                  </div>
                </dl>

                {selected.diagnosis ? (
                  <div className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-ink/80">
                    <span className="font-semibold">Diagnosis: </span>
                    {selected.diagnosis}
                  </div>
                ) : null}
                {selected.repairNotes ? (
                  <div className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-ink/80">
                    <span className="font-semibold">Repair: </span>
                    {selected.repairNotes}
                  </div>
                ) : null}
                {selected.verificationNotes ? (
                  <div className="rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-ink/80">
                    <span className="font-semibold">Verification: </span>
                    {selected.verificationNotes}
                  </div>
                ) : null}

                <div className="space-y-3 border-t border-line pt-4">
                  {manager && (selected.status === "reported" || selected.status === "assigned") ? (
                    <form action={assignWorkOrderAction} className="space-y-2">
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <label className="label" htmlFor={`assignee-${selected.id}`}>
                        {selected.status === "reported" ? "Assign an owner" : "Reassign"}
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <select
                          id={`assignee-${selected.id}`}
                          name="assignee_id"
                          defaultValue={selected.assignedTo ?? ""}
                          className="input"
                        >
                          <option value="">Internal technician…</option>
                          {staffList.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.name} · {person.role}
                            </option>
                          ))}
                        </select>
                        <input name="vendor_name" defaultValue={selected.vendorName} className="input" placeholder="or external vendor" />
                        <SubmitButton className="btn-primary shrink-0" pendingLabel="Assigning…">
                          Assign
                        </SubmitButton>
                      </div>
                    </form>
                  ) : null}

                  {staff && (selected.status === "assigned" || (selected.status === "reported" && !manager)) ? (
                    <form action={startWorkOrderAction}>
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <SubmitButton className="btn-primary" pendingLabel="Starting…">
                        Start repair
                      </SubmitButton>
                    </form>
                  ) : null}

                  {staff && selected.status === "in_progress" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <form action={waitForPartsAction} className="space-y-2 rounded-xl border border-line p-3">
                        <input type="hidden" name="work_order_id" value={selected.id} />
                        <label className="label" htmlFor={`parts-${selected.id}`}>
                          Waiting for parts
                        </label>
                        <input id={`parts-${selected.id}`} name="note" required className="input" placeholder="Which part is awaited?" />
                        <SubmitButton className="btn-secondary w-full" pendingLabel="Saving…">
                          Mark waiting
                        </SubmitButton>
                      </form>
                      <form action={resumeWorkOrderAction} className="space-y-2 rounded-xl border border-line p-3">
                        <input type="hidden" name="work_order_id" value={selected.id} />
                        <label className="label">Resume</label>
                        <p className="text-[11px] text-muted">Only if the job was waiting on parts.</p>
                        <SubmitButton className="btn-secondary w-full" pendingLabel="Saving…">
                          Resume work
                        </SubmitButton>
                      </form>
                    </div>
                  ) : null}

                  {staff && selected.status === "waiting_parts" ? (
                    <form action={resumeWorkOrderAction}>
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <SubmitButton className="btn-primary" pendingLabel="Resuming…">
                        Parts received — resume
                      </SubmitButton>
                    </form>
                  ) : null}

                  {staff && selected.status === "in_progress" ? (
                    <form action={completeRepairAction} className="space-y-2 rounded-xl border border-line p-3">
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <label className="label" htmlFor={`repair-${selected.id}`}>
                        Sign off the repair
                      </label>
                      <textarea
                        id={`repair-${selected.id}`}
                        name="repair_notes"
                        required
                        minLength={10}
                        rows={2}
                        className="input"
                        placeholder="What was actually done? At least 10 characters."
                      />
                      <div className="grid gap-2 sm:grid-cols-2">
                        <input name="parts_used" className="input" placeholder="Parts used" />
                        <input name="labour_hours" type="number" min="0" step="0.25" defaultValue="0" className="input" placeholder="Labour hours" />
                        <input name="estimated_cost" type="number" min="0" step="1" className="input" placeholder="Estimated cost" />
                        <input name="actual_cost" type="number" min="0" step="1" className="input" placeholder="Actual cost (if known)" />
                      </div>
                      <p className="text-[11px] text-muted">
                        Signing off does not release the asset.{" "}
                        {selected.requiresVerification
                          ? "Independent verification is required first."
                          : "A facility manager must still release it."}
                      </p>
                      <SubmitButton className="btn-primary w-full" pendingLabel="Saving…">
                        Repair complete
                      </SubmitButton>
                    </form>
                  ) : null}

                  {staff && selected.status === "awaiting_verification" ? (
                    <form action={verifyWorkOrderAction} className="space-y-2 rounded-xl border border-line p-3">
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <label className="label" htmlFor={`verify-${selected.id}`}>
                        Independent verification
                      </label>
                      {selected.requiresVerification && selected.repairCompletedBy === user.userId ? (
                        <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-800">
                          You signed off this repair. Independent verification requires someone else.
                        </p>
                      ) : null}
                      <textarea
                        id={`verify-${selected.id}`}
                        name="verification_notes"
                        rows={2}
                        className="input"
                        placeholder="What did you check? Required to reject."
                      />
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" name="decision" value="verify" className="btn-primary">
                          Verify repair
                        </button>
                        <button type="submit" name="decision" value="reject" className="btn-danger">
                          Reject — rework
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {manager && isReleasable(selected.status, selected.requiresVerification) ? (
                    <form action={releaseWorkOrderAction} className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <label className="label" htmlFor={`release-${selected.id}`}>
                        Release the asset
                      </label>
                      <p className="text-[11px] text-muted">
                        Readiness is re-checked when you release. Expired calibration, another hold or missing stock will block it.
                      </p>
                      <textarea
                        id={`release-${selected.id}`}
                        name="release_note"
                        required
                        minLength={10}
                        rows={2}
                        className="input"
                        placeholder="Why is it safe to return this asset to service?"
                      />
                      <SubmitButton className="btn-primary w-full" pendingLabel="Releasing…">
                        Release and close
                      </SubmitButton>
                    </form>
                  ) : null}

                  {staff && isOpenStatus(selected.status) && selected.status !== "verified" && selected.priority !== "urgent" ? (
                    <form action={escalateWorkOrderAction} className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50/40 p-3 sm:flex-row">
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <input
                        name="note"
                        required
                        minLength={10}
                        className="input flex-1"
                        placeholder="Why does this need urgent attention?"
                      />
                      <SubmitButton className="btn-secondary shrink-0" pendingLabel="Escalating…">
                        Escalate
                      </SubmitButton>
                    </form>
                  ) : null}

                  {manager && (selected.status === "closed" || selected.status === "verified") ? (
                    <form action={reopenWorkOrderAction} className="space-y-2 rounded-xl border border-line p-3">
                      <input type="hidden" name="work_order_id" value={selected.id} />
                      <label className="label" htmlFor={`reopen-${selected.id}`}>
                        Reopen
                      </label>
                      <input
                        id={`reopen-${selected.id}`}
                        name="reason"
                        required
                        minLength={10}
                        className="input"
                        placeholder="What failed, and why is the asset unsafe again?"
                      />
                      <SubmitButton className="btn-secondary w-full" pendingLabel="Reopening…">
                        Reopen and hold asset
                      </SubmitButton>
                    </form>
                  ) : null}

                </div>

                <div className="border-t border-line pt-4">
                  <SectionHeading title="Status history" description="Append-only. Every entry names the actor." />
                  <ol className="space-y-2">
                    {selected.history.map((event) => (
                      <li key={event.id} className="flex gap-2 text-[11px]">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                        <div>
                          <p className="font-medium text-ink/85">
                            {event.fromStatus ? `${event.fromStatus} → ${event.toStatus}` : event.toStatus}
                            {event.kind !== "status" ? ` · ${event.kind.replace(/_/g, " ")}` : ""}
                          </p>
                          <p className="text-muted">
                            {event.actorName ?? "System"} · {formatDateTime(event.createdAt)}
                            {event.note ? ` · ${event.note}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>
          ) : null}

          <section className="card-pad">
            <SectionHeading
              title="Emergency override"
              description="Record a justified operational exception, restrict an asset, or tell affected users. Calibration and safety holds cannot be overridden."
            />
            {manager ? (
              <form action={createEmergencyOverrideAction} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="o_resource" className="label">
                      Asset
                    </label>
                    <select id="o_resource" name="resource_id" required defaultValue={selected?.resourceId ?? ""} className="input">
                      <option value="" disabled>
                        Choose an asset
                      </option>
                      {resources.map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.code} — {resource.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="o_action" className="label">
                      Action
                    </label>
                    <select id="o_action" name="action" defaultValue="operational_exception" className="input">
                      {OVERRIDE_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {OVERRIDE_ACTION_LABEL[action as OverrideAction]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="o_scope" className="label">
                    Scope
                  </label>
                  <input
                    id="o_scope"
                    name="scope"
                    required
                    minLength={5}
                    maxLength={240}
                    className="input"
                    placeholder="e.g. Tonight 18:00–22:00, cleanroom access only"
                  />
                </div>
                <div>
                  <label htmlFor="o_reason" className="label">
                    Reason (human-readable, at least 20 characters)
                  </label>
                  <textarea
                    id="o_reason"
                    name="reason"
                    required
                    minLength={20}
                    rows={2}
                    className="input"
                    placeholder="What happened, who decided, and what is the safe alternative?"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="o_expires" className="label">
                      Expires at (required for restrictions and booking changes)
                    </label>
                    <input
                      id="o_expires"
                      name="expires_at"
                      type="datetime-local"
                      min={`${istDateKey()}T00:00`}
                      className="input"
                    />
                  </div>
                  <div>
                    <label htmlFor="o_condition" className="label">
                      Linked unresolved condition (optional)
                    </label>
                    <select id="o_condition" name="condition" className="input">
                      <option value="">None</option>
                      {incidents.map((incident) => (
                        <option key={incident.id} value={incident.id}>
                          {incident.resourceCode} · {incident.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-[11px] text-muted">
                  An override cannot bypass expired calibration, a safety hold, a retired asset, missing training or a quota.
                  It records the exception and notifies the people affected.
                </p>
                <SubmitButton className="btn-danger w-full" pendingLabel="Recording…">
                  Record override
                </SubmitButton>
              </form>
            ) : (
              <p className="text-xs text-muted">Only administrators and facility managers can record an emergency override.</p>
            )}
          </section>

          <section className="card">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading title="Recent overrides" description="Action, scope, reason, expiry and affected bookings." />
            </div>
            {overrides.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No emergency overrides recorded.</p>
            ) : (
              <ul className="divide-y divide-line">
                {overrides.map((override) => {
                  const state = override.revokedAt ? "revoked" : override.expired ? "expired" : "active";
                  return (
                    <li key={override.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={state === "active" ? "red" : state === "expired" ? "slate" : "green"}>{state}</Badge>
                        <p className="text-sm font-semibold text-ink">{override.resourceName}</p>
                        <span className="text-[11px] text-muted">{override.action.replace(/_/g, " ")}</span>
                      </div>
                      <p className="mt-1 text-xs text-ink/80">{override.scope}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {override.reason}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        {override.createdByName ?? "—"} · {formatDateTime(override.createdAt)}
                        {override.expiresAt ? ` · expires ${formatDateTime(override.expiresAt)}` : " · no expiry"}
                        {override.revokeReason ? ` · revoked: ${override.revokeReason}` : ""}
                      </p>

                      {override.affected.length > 0 ? (
                        <div className="mt-2 overflow-x-auto">
                          <table className="table text-[11px]">
                            <thead>
                              <tr>
                                <th>Booking</th>
                                <th>User</th>
                                <th>Status</th>
                                <th>Notification</th>
                              </tr>
                            </thead>
                            <tbody>
                              {override.affected.map((booking) => (
                                <tr key={booking.id}>
                                  <td>
                                    {booking.startsAt && booking.endsAt
                                      ? `${formatDateTime(booking.startsAt)} → ${formatDateTime(booking.endsAt)}`
                                      : "—"}
                                  </td>
                                  <td>{booking.userName ?? "—"}</td>
                                  <td>
                                    {booking.statusBefore === booking.statusAfter
                                      ? booking.statusAfter
                                      : `${booking.statusBefore} → ${booking.statusAfter}`}
                                  </td>
                                  <td>
                                    <Badge tone={deliveryTone(booking.notificationStatus)}>{booking.notificationStatus}</Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="mt-1 text-[11px] text-muted">No bookings were affected.</p>
                      )}

                      {manager && state === "active" ? (
                        <form action={revokeEmergencyOverrideAction} className="mt-2 flex flex-col gap-2 sm:flex-row">
                          <input type="hidden" name="override_id" value={override.id} />
                          <input name="revoke_reason" required minLength={10} className="input flex-1" placeholder="Why is the override no longer needed?" />
                          <SubmitButton className="btn-secondary shrink-0" pendingLabel="Revoking…">
                            Revoke
                          </SubmitButton>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card-pad">
            <SectionHeading title="Communication" description="What this build actually sends." />
            <ul className="space-y-2 text-xs text-muted">
              <li className="flex items-start gap-2">
                <Icon name="check" className="mt-0.5 h-3.5 w-3.5 text-emerald-600" />
                In-app notifications are delivered and appear in the recipient&apos;s notification list.
              </li>
              <li className="flex items-start gap-2">
                <Icon name="clock" className="mt-0.5 h-3.5 w-3.5 text-amber-600" />
                Email rows are recorded as <strong className="text-ink/80">unavailable</strong> when no transport is configured;
                nothing is reported as sent.
              </li>
            </ul>
            <p className="mt-3 text-[11px] text-muted">
              Outbox: {delivery.pending} pending · {delivery.sent} sent · {delivery.unavailable} unavailable ·{" "}
              {delivery.failed} failed.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
