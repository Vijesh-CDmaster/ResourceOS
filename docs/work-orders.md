# Work orders, verified release and emergency override

Two operational workflows that share one rule: **a repair is not a release**.

```
lib/work-orders.ts              lifecycle, permissions, verification rules (pure)
lib/actions/work-orders.ts      raise → assign → start → complete → verify → release
lib/queries/work-orders.ts      list, detail with history, overrides, delivery counts
lib/notifications.ts            honest in-app + email outbox recording
app/(app)/work-orders           the operator workspace
db/migrations/0005_*.sql        work_orders, work_order_events, resource_holds,
                                emergency_overrides, override bookings, outbox
```

## Why a separate hold

A work order records the *repair process*: who owns it, what was diagnosed, what
was replaced, how long it was down, what it cost. A **resource hold** records
*whether the asset may be used*. They are separate tables on purpose:

- Completing a repair moves the work order forward and leaves the hold active.
- Verifying the repair (where policy requires it) still leaves the hold active.
- Only an authorised **release** clears the hold, and only after the full
  readiness evaluation passes.

So there is no path where a technician's sign-off silently returns an unsafe
asset to the booking pool.

## Lifecycle

```
reported → assigned → in_progress → repair_completed → closed
                ↑          ↓   ↘
                │   waiting_parts → in_progress
                │          ↓
                └──── awaiting_verification → verified → closed
                            (rejected → in_progress, rework)
```

| From | Allowed next |
|---|---|
| `reported` | `assigned` |
| `assigned` | `in_progress` |
| `in_progress` | `waiting_parts`, `repair_completed`, `awaiting_verification` |
| `waiting_parts` | `in_progress` |
| `repair_completed` | `awaiting_verification`, `closed` (only when policy does not require verification) |
| `awaiting_verification` | `verified`, `in_progress` (verification rejected) |
| `verified` | `closed`, `in_progress` (reopen) |
| `closed` | `in_progress` (reopen) |

`advance()` refuses any move that is not in this table, so an action cannot skip
verification or close a job that was never repaired. Every transition writes a
`work_order_events` row with actor, from/to status, kind and note. The table is
**append-only at the database level** (`work_order_events_no_rewrite`), so the
history cannot be edited or deleted by anyone, including the application role.

`waiting_parts` records which part is awaited and notifies managers. **Escalation**
is deliberately a priority change rather than a lifecycle jump: it sets
`priority = 'urgent'`, writes an event and an audit row, and tells the managers
why. The job keeps its place in the flow.

## Independent verification

`resources.requires_independent_verification` (default **true**) decides whether
the person who signed off the repair may also verify it. The value is snapshotted
onto the work order at creation, so a later policy change cannot retroactively
make a past verification look independent (or vice versa).

- `completeRepair` → `awaiting_verification` when required, `repair_completed`
  when not.
- Verification requires the `awaiting_verification` state and a verifier who is
  not `repair_completed_by` (when the policy applies).
- **Reject** requires a written reason, returns the job to `in_progress` and
  records a `verification_rejected` event.
- A verifier may not release: `release` is restricted to administrators and
  facility managers even after verification.

## The release gate

`releaseWorkOrderAction` is the only operation that clears a hold. Inside one
transaction it:

1. locks the work order and the resource (`FOR UPDATE`);
2. refuses unless the state is `verified`, or `repair_completed` when the policy
   does not require verification;
3. releases **this work order's** active hold;
4. closes the linked incident with the release note as its resolution;
5. sets the asset back to `ready` only when no other hold remains;
6. re-runs `evaluateReadiness` on the resulting state — expired calibration,
   another hold, an emergency restriction, an open safety incident or missing
   stock abort the transaction and the hold stays active;
7. closes the work order, stamps `downtime_end` and audits `work_order.released`
   with the rationale and the resulting readiness verdict.

Because step 6 runs after steps 3–5, the gate sees what the asset would look like
*after* release rather than before it. Concurrent release attempts serialise on
the row lock: exactly one closes the job and records a hold release.

Reopening a closed or verified order returns it to `in_progress`, raises a fresh
hold and puts the asset back under maintenance. The reason is mandatory.

## Emergency override

An override is for the failure modes a workflow cannot schedule: an urgent
exception, a temporary restriction, cancelling or flagging bookings, or
communicating downtime. It is **not** a way to use an unsafe asset.

Actions: `operational_exception`, `scheduling_exception`, `restrict_resource`,
`cancel_bookings`, `relocate_bookings`, `communicate_downtime`.

Every override stores the organisation, resource, actor and role, the action and
scope, a mandatory human-readable reason (**≥ 20 characters**), the linked
incident, start and expiry, the previous and resulting state, and the affected
bookings with their delivery status. `emergency_overrides` is append-only except
for the three revocation columns, enforced by a trigger.

**What cannot be overridden** (`lib/work-orders.ts → NON_OVERRIDABLE`): expired,
failed or missing calibration; an open safety hold; an active resource hold; a
retired asset; a booking quota; missing training. A `scheduling_exception` against
any of those is refused with the condition named. Restricting an asset or
informing users is always allowed because it grants no additional access — the
override can only make things stricter, never looser.

Expiry is real: `restrict_resource` takes effect through readiness
(`emergency_restriction`), so it lapses at `expires_at` without a background job.
Cancelling or relocating bookings requires an expiry because the scope is a time
window. Revoking requires a written reason and is itself audited.

`cancel_bookings` actually cancels the overlapping open bookings and records
`status_before → status_after` per booking. `relocate_bookings` notifies the
affected users and records them for rebooking; it does not silently move a
booking into a slot that might conflict.

## Communication

| Channel | What actually happens |
|---|---|
| In-app (`notifications`) | Stored and rendered in the shell. Real delivery. |
| Email (`notification_outbox`) | Recorded as `unavailable` when no transport is configured, with the setup path in `last_error`; `pending` when a transport is configured but no worker exists. Never `sent` without a send. |

Setup path: set `SMTP_URL` (or `EMAIL_DELIVERY_URL`) and run a worker that drains
`notification_outbox` rows with `status = 'pending'`, setting `sent`/`failed`,
`attempts` and `sent_at`. Until then the UI states plainly that email is not
configured.

## Permissions

| Action | admin | manager | technician | member |
|---|---|---|---|---|
| Raise a work order | ✓ | ✓ | ✓ | — |
| Assign / reassign | ✓ | ✓ | — | — |
| Start, wait for parts, resume, complete repair | ✓ | ✓ | ✓ | — |
| Escalate | ✓ | ✓ | ✓ | — |
| Verify (independent) | ✓ | ✓ | ✓ (not own work) | — |
| Release, reopen | ✓ | ✓ | — | — |
| Record / revoke an override | ✓ | ✓ | — | — |

Authorisation is enforced inside each server action, not by hiding the form. Every
write is tenant-scoped (`withOrg`) and covered by RLS on all seven new tables.

## Capital evidence

Closed work orders feed the capital-decision evidence as maintenance facts
(`source: "work_order"`), with downtime computed from `downtime_start`/`downtime_end`.
Actual costs and estimates stay labelled: `maintenance.actualCost` sums only
recorded actuals, `maintenance.estimatedCost` sums estimates, and
`maintenance.verifiedRepairs` counts the verified jobs. Estimates are never folded
into the actual figure, and no saving is inferred.

## Tests

`tests/work-orders.test.mjs` (24 tests) covers conversion and uniqueness, valid
and invalid transitions, assignment and release permissions, repair completion
without hold clearance, self-verification refusal, rejected verification and
rework, authorised release, expired calibration still blocking, override
authorisation, reason/expiry validation, non-overridable conditions, concurrent
release, reopen, affected-booking records, unavailable email delivery, append-only
history, cross-tenant access and RLS. It builds and drops
`resourceos_workorders_test` only.

## Known limitations

- **No email sender.** The outbox is evidence, not delivery.
- **No vendor portal or SLA tracking.** Vendors are recorded as free-text name and
  contact; assignment is internal.
- **Relocation is recorded, not rescheduled.** The affected user is told to rebook;
  no automatic conflict-free move is attempted.
- **One hold per work order.** A reopened job raises a new hold; holds from other
  causes stay independent by design.
- **No scheduled escalation.** Escalation is manual; there is no timer that
  escalates a job after N hours.
- **Downtime is manual.** It starts when work starts and ends at release; waiting
  time before assignment is not counted.
