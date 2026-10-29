# Capital decisions

Equipment decisions in ResourceOS are evidence-backed and human-owned. The system
assesses five alternatives for an asset, shows the arithmetic and the gaps in the
data, and stores the result as a **Capital Decision Record**. It never makes the
decision: an administrator or facility manager records it, with their name, a
rationale and a timestamp.

Nothing in this feature calls an external service. There is no LLM, no
forecasting, and no claim of guaranteed savings.

---

## The workflow

1. **Dashboard** — `/capital` lists every asset with utilisation, unmet demand,
   maintenance spend and downtime, plus risk flags (low use, repair burden, poor
   condition, beyond expected life, open incidents).
2. **Evidence** — `/capital/{resourceId}` shows one asset: lifecycle facts,
   demand, reliability, comparable assets and data coverage. The window is
   switchable between 90, 180 and 365 days.
3. **Alternatives** — the same page scores all five options and shows exactly
   which signals triggered, with weights, and what evidence is missing.
4. **Recommendation** — the highest-scoring applicable option, with a confidence
   level and the reasons for it.
5. **Generate** — stores the evidence snapshot, all five assessments, the
   assumptions and the recommendation as a `capital_decisions` row with status
   `pending`.
6. **Decide** — `/capital/decisions/{id}`; the authorised person picks one of the
   five options and writes a rationale (minimum 12 characters). The record becomes
   `decided`, and the choice is audited, including whether it overrode the system.
7. **Saved record** — the same page renders the *stored* snapshot. It is not
   recomputed, so the record still reads the same after the asset is renamed,
   re-costed or retired.

---

## The five options

| Option | When it scores | Cost shown |
|---|---|---|
| `buy_new` | Repair is a large share of replacement, life is exhausted, demand is high, downtime is material | Replacement cost, annualised over remaining life |
| `repair` | Repair is affordable relative to replacement, useful life remains, the asset is in active use, faults are not chronic | Repair estimate (mean resolved repair × 1.15, floored at the last repair) |
| `share` | Under-used by its owner, other departments record unmet demand, condition is sound | No new spend; running cost per used hour |
| `reallocate` | Owner barely uses it, another department has demand and a busier peer exists, condition is usable | No new spend |
| `retire` | Life exhausted, condition poor, demand negligible, repair uneconomic | Maintenance spend and downtime avoided |

Scores are the sum of triggered signal weights (fixed, visible numbers in the UI).
They rank alternatives; they are **not** probabilities, savings forecasts or a
substitute for a quotation. Ties are broken by least disruption:
`repair → share → reallocate → buy_new → retire`.

---

## Calculations

All figures come from rows in the tenant's own database. There are no stored
aggregates, so a report can never drift from the underlying records.

| Metric | Definition |
|---|---|
| Available hours | `window days × (close_hour − open_hour) − recorded maintenance downtime hours` |
| Utilisation | `actual usage hours from check-in/check-out sessions ÷ available hours` |
| Booked utilisation | `hours of confirmed, completed and no-show bookings ÷ available hours` |
| No-show rate | `no-shows ÷ (completed + no-shows)` |
| Repair estimate | `max(mean resolved repair cost × 1.15, most recent resolved repair cost)`; unknown, not zero, when there is no resolved maintenance |
| Replacement cost | Recorded replacement quote; when absent, `acquisition cost × 1.15`, flagged `derived` |
| Repair-to-replacement share | `repair estimate ÷ replacement cost` |
| Downtime share | `maintenance downtime hours ÷ gross available hours` |
| Cost per used hour | `maintenance spend ÷ actual usage hours` |
| Confidence | `low` when usage is below 10 hours, the window is under 30 days, or the leading option lacks required evidence; `high` only when sessions, cost, life expectancy and a strong score coincide |

Known limitations, shown on screen as well as here:

- Usage hours only count sessions that were checked in and out. Completed bookings
  without a session make utilisation a floor, and the count is displayed.
- Every calendar day is treated as operable; holidays depress utilisation.
- Repair costs exclude staff time, calibration and repeat-failure risk.
- Replacement, installation, commissioning, training and disposal are not modelled
  beyond the replacement figure itself.
- Unmet demand only captures requests the system saw. Absence of records is not
  evidence of absence of demand.
- Cross-institution sharing and reallocation between organisations are **not**
  implemented; `share` and `reallocate` here mean intra-institution moves.

---

## Data: synthetic demo tenant

The demo tenant is **generated, labelled and disposable**. No real institution's
data is involved and no vendor system is connected.

```bash
# 1. Create a separate, clearly disposable database.
createdb resourceos_demo

# 2. Apply the schema and migrations to it.
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/resourceos_demo \
DATABASE_URL=postgres://resourceos_app:app_dev_password@localhost:5432/resourceos_demo \
  node --env-file=.env.local db/migrate.mjs

# 3. Seed. Both guards must be satisfied.
DEMO_DATABASE_URL=postgres://postgres:postgres@localhost:5432/resourceos_demo \
DEMO_SEED_CONFIRM=yes \
  npm run db:seed-demo

# 4. Point the app at it and run.
DATABASE_URL=postgres://resourceos_app:app_dev_password@localhost:5432/resourceos_demo \
  npm run dev
```

`db/seed-demo.mjs` refuses to run unless:

1. `DEMO_SEED_CONFIRM=yes` is set, **and**
2. the target database name ends in `_demo` or `_test`, **and**
3. it is not `postgres`, `template0` or `template1`, **and**
4. the demo tenant (`demo-university`) does not already exist.

It only ever `INSERT`s. It never truncates, updates, deletes or reseeds. Running it
twice on the same database fails loudly instead of duplicating or overwriting.

What it creates — *Northfield Institute of Technology (demo)*:

| Element | Content |
|---|---|
| Departments | 5 (Mechanical, Materials, Biosciences, Electronics, Design) |
| Facilities | 4 (Central Instrumentation Lab, Fabrication Workshop, Bio Resource Centre, Design Studio) |
| People | 10 — 1 administrator, 2 facility managers, 1 technician, 6 members |
| Assets | 12 instruments in 4 categories, ₹4.55 crore recorded acquisition value |
| Bookings | ~1,340 across 180 days, with cancellations, no-shows and rejections |
| Usage | ~920 check-in/check-out sessions with real durations |
| Maintenance | 37 fault records with cost, downtime and fault category, including one asset currently out of service |
| Unmet demand | 31 events, several from departments other than the owner |

Every record carries `is_demo = true` (organisation and resources) and the UI shows
a violet **Synthetic demo data** banner on every capital page.

The dataset is deliberately varied. These are the figures the demo tenant
actually produces (180-day window, verified against the running code):

| Asset | Profile | Recommendation |
|---|---|---|
| `SEM-01` Scanning electron microscope | 67% utilisation, ₹10.3 lakh repairs, 448 h downtime, past expected life, 5 unmet requests from other departments | **Buy new** (0.80) ahead of repair (0.60) |
| `CONF-01` Confocal microscope | 1.8% utilisation, 6 requests from other departments, condition excellent | **Share** (0.90) |
| `SPECTRO-01` UV-Vis spectrophotometer | 2.1% utilisation, 5 external requests, no maintenance cost | **Share** (1.00) |
| `FURNACE-01` Tube furnace | 2013, 1.7% utilisation, poor condition, 5 repairs | **Retire** (0.85) |
| `AUTOCLAVE-01` Autoclave | 2.9% utilisation, ₹2.9 lakh repairs, 242 h downtime, currently out of service | **Buy new** (0.60) ahead of retire (0.50) |
| `CNC-01`, `HPLC-01`, `XRD-01` | 37–44% utilisation, active use, recurring faults, life remaining | **Repair** |

No single option dominates: the ranking depends on utilisation, remaining life,
downtime and unmet demand, and every page shows the losing options with their
scores and the evidence that did or did not trigger.

Sign in with any demo account; `nandita.rao@northfield.demo` (administrator) and
`ishaan.mehta@northfield.demo` (facility manager) can generate and record
decisions. Password: `demo1234`.

---

## Implementation

| File | Role |
|---|---|
| `db/migrations/0003_capital_decisions.sql` | Lifecycle columns on `resources`, cost/downtime/category on `maintenance_records`, `capital_decisions` table with RLS, status constraints and a delete-blocking trigger |
| `lib/capital/model.ts` | Pure calculation, scoring, recommendation and the published definitions. No I/O, no clock reads beyond the supplied `now` |
| `lib/queries/capital.ts` | Tenant-scoped queries (`withOrg`) feeding the model; one row per session and per booking |
| `lib/actions/decisions.ts` | `generateDecisionAction`, `recordDecisionAction` — role checks, server-side recomputation, audit events |
| `app/(app)/capital/**` | Dashboard, asset evidence workspace and saved record |
| `db/demo-seed.mjs`, `db/seed-demo.mjs` | Guarded synthetic tenant |
| `tests/capital.test.mjs` | Model arithmetic, tenant isolation, persistence, workflow |

Key guarantees:

- The number stored is the number computed **on the server** from database rows.
  The browser supplies only `resource_id` and the window.
- `capital_decisions` is tenant-scoped by RLS and by explicit filters.
- `DELETE` is rejected by a trigger; the record cannot be quietly removed.
- Generating, deciding, and the override flag are all written to `audit_events`.
- The decision requires an administrator or facility manager; members and
  technicians can read evidence but not create records.

---

## Not implemented

- Replacement quotes are not fetched from any procurement or finance system; the
  field is manual and otherwise derived, and is flagged as such.
- No payment, purchase-order or ERP export.
- No scheduled re-assessment; a record is only regenerated when a person does it.
- No cross-institution sharing or partner network.
- No AI. The ranking is deterministic and auditable, which is the point.
