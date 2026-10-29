# Operational readiness

A free calendar slot is not permission to use an instrument. ResourceOS evaluates
whether an asset is actually **usable** and enforces that verdict on the server at
three points: booking creation, approval, and check-in.

```
lib/readiness.ts            domain: snapshot → verdict + reasons (pure)
lib/queries/readiness.ts    board, per-asset detail, stock views (tenant-scoped)
lib/actions/readiness.ts    calibration, policy, consumables, stock (audited)
components/readiness-panel.tsx   verdict + reasons + next step
app/(app)/readiness        board and per-asset workspace
app/(app)/consumables      catalogue, stock adjustment, movement history
```

## The gates

| Gate | Source | Severity |
|---|---|---|
| Asset lifecycle | `resources.status` (`retired` / `suspended` / `maintenance`) | block |
| Calibration | `resources.requires_calibration` + latest `calibration_records` | block when required and missing, failed or expired; warning within 14 days of expiry |
| Safety incidents | `incidents` with `status <> 'resolved'` | `high` blocks; `medium`/`low` warn |
| Blocking hold | `resource_holds` with `status = 'active'` (raised by a work order) | block — cleared only by an authorised release |
| Emergency restriction | `emergency_overrides` with action `restrict_resource`, not revoked, inside its window | block until it expires or is revoked |
| Maintenance window | `blackout_periods` covering the requested time | block |
| Consumables | `resource_consumables` → `consumables.stock` | mandatory short → block; below `min_stock` → warn |
| Training and eligibility | existing booking rules (training expiry, quota, horizon) | unchanged |

A resource is `ready`, `ready with warnings`, or `blocked`. Every reason carries a
sentence of cause and a specific next step — e.g. *"Calibration expired on 20 Sept
2026. Bookings are blocked until a valid calibration is recorded."*

Calibration is opt-in per asset: `requires_calibration` defaults to `false`, so
existing resources are unaffected until a manager enables it. A `null` calibration
is only a block when the asset declares the requirement, and an asset without a
requirement is never "ready because zero cost" — the requirement itself is the
data.

## Where it is enforced

- **Booking creation** (`createBookingAction`) — blocks before the row is written
  and records the refusal as `unmet_demand_events.reason = 'not_ready'`, so refused
  demand shows up in reports instead of disappearing.
- **Approval** (`decideBookingAction`) — re-evaluated because a request can sit in
  the queue while calibration expires or an incident is raised. A refusal leaves
  the request `requested`; it is not auto-rejected.
- **Check-in** (`checkInAction`) — re-evaluated at the moment of use, then required
  consumables are deducted.

Warnings never block. Blocks are never bypassed by the scheduling flows. The
emergency-override workflow in [docs/work-orders.md](work-orders.md) can restrict an
asset or cancel bookings, but it explicitly cannot clear calibration, safety holds,
resource holds, retirement, quota or training — those are resolved by their own
workflow. A completed repair does not clear a hold either: only an authorised
release does, and release re-runs this evaluation before it commits.

## Consumables

`consumables` holds `stock` and `min_stock` as `numeric(12,2)` with `CHECK (stock >= 0)`.
`resource_consumables` links an item to an asset with `qty_per_session` and
`mandatory`. Every change writes a `consumable_movements` row (`purchase`,
`adjustment`, `consumption`, `reversal`) with actor and note.

On check-in, `consumeRequiredConsumables`:

1. `SELECT … FOR UPDATE OF c` over the required items, serialising competing sessions;
2. skips any item already consumed for this booking;
3. `UPDATE … WHERE stock >= qty RETURNING` so stock can never go negative;
4. inserts one movement row, protected by a unique partial index
   (`booking_id, consumable_id` where `reason = 'consumption'`), so a retried
   check-in cannot deduct twice.

Stock is *checked* at booking and *deducted* at check-in. Reservations are not held
between those points; the check-in gate is what prevents a session starting without
materials.

## Permissions

| Action | admin | manager | technician | member |
|---|---|---|---|---|
| View readiness board and reasons | ✓ | ✓ | ✓ | ✓ (read-only) |
| Record a calibration | ✓ | ✓ | ✓ | — |
| Change the calibration requirement | ✓ | ✓ | — | — |
| Create a consumable, adjust stock | ✓ | ✓ | ✓ | — |
| Attach or remove a resource requirement | ✓ | ✓ | — | — |

Authorisation is checked inside the server action (`isStaff` / `canManage`), not by
hiding the form. RLS covers `calibration_records`, `consumables`,
`resource_consumables` and `consumable_movements`. Every change writes an
`audit_events` row (`calibration.recorded`, `calibration.policy_changed`,
`consumable.created`, `consumable.stock_adjusted`, `consumable.linked`,
`consumable.unlinked`, `consumable.consumed`).

## Demo data

`db/seed-readiness-demo.mjs` adds synthetic fixtures to an isolated `_demo`
database only (guarded by `DEMO_SEED_CONFIRM=yes`, the database-name suffix, and a
refusal to run twice):

- **SEM-01** — calibration required and valid.
- **XRD-01** — calibration expired → blocked with the expiry date.
- **3DP-01** — calibration missing *and* PLA filament below the session quantity →
  two blocking reasons.

## Known limitations (this slice)

- **Calibration is not refreshed by the repair workflow.** A verified repair
  restores the asset only if calibration is still valid; a repair does not create a
  calibration record, and release is blocked until one is entered.
- **No calibration reminders or scheduled jobs.** Overdue calibration is surfaced on
  the readiness board, not by email.
- **No vendor/AMC, SOP versioning, samples/jobs, waitlists, guest access, cost
  allocation or offline mode.** Not started.
- **Single hard-coded warning window** (14 days) rather than per-asset policy.
- Consumable deduction happens at check-in, not at booking, so two bookings can both
  pass the stock check and only the first check-in consumes the stock.
