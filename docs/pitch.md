# ResourceOS — Equipment Decision OS

> **Every lab in India can tell you what equipment it bought. Almost none can tell you whether it is used, what it costs to keep alive, or whether the next ₹1 crore should replace it.**
> ResourceOS is the system of record that answers those three questions — and it refuses to answer them with a guess.

Pitch document for the 500-team round. Written to be read by a judge in four minutes and defended in ten.

---

## 0. The one-page version

| | |
|---|---|
| **Problem** | Shared scientific and technical equipment is the most expensive idle asset class in Indian higher education. Booking runs on WhatsApp, cost records live in a purchase file, and the replacement decision is made by whoever argues hardest in the budget meeting. |
| **Solution** | One tenant-isolated system that runs the booking control loop *and* converts its own operational exhaust into a five-option capital assessment with an immutable decision record. |
| **Who pays** | Director / Dean / Registrar / facility in-charge at a private university, engineering college, research centre or incubator. One facility is enough to buy. No network effect required. |
| **Why now** | Instrument-heavy institutions are being asked to justify capex and utilisation without a system that measures either. I-STEM digitised *public discovery*, not *internal operations*. |
| **Novelty** | The unit of value is not a chart, it is a **decision record**: evidence snapshot + five comparable options + assumptions + named human + rationale + timestamp, append-only at the database level. |
| **Proof** | Running application, 40 automated tests, 3 independent isolation layers (session → explicit tenant scope → PostgreSQL RLS), conflict prevention that is a database constraint rather than application logic. |
| **Business model** | ₹3,500–₹20,000/month by facility and asset count. ACV target ₹60,000. One-city direct sales, facility manager as the entry point, not the CIO. |
| **The honest claim** | We have not connected a real vendor, do not predict failures, and do not claim savings we have not measured. That restraint is the product's credibility. |

---

## 1. Why most of the 500 teams will lose this

Three pitches will dominate the room, and each has a structural weakness a judge can spot in one question.

| Common pitch | The question that breaks it | Our answer |
|---|---|---|
| "AI predicts equipment failure" | *What training data do you have?* — None. A university's maintenance log has 37 rows. | No prediction. We report the downtime and repair burden that already happened, and show the arithmetic. |
| "Marketplace for idle lab equipment" | *Who supplies? Who insures? Who pays?* — Four-sided cold start, liability the institution cannot sign off. | Private, single-tenant operations first. Sharing is an internal reallocation option, not a marketplace. |
| "Dashboard over a CSV" | *What happens when two people click at once?* | The loser of the race is rejected by a PostgreSQL exclusion constraint. There is no read-then-write window to lose. |
| "Blockchain audit trail" | *Why?* | `UPDATE` and `DELETE` on `audit_events` raise. Append-only is a trigger, not a token. |
| "We replaced Excel" | *Show me the Excel import.* | CSV import with per-row validation errors is built and used in onboarding. |

Our differentiator is not that we added AI. It is that we **removed every claim we cannot demonstrate on stage**, and built the parts that survive cross-examination.

---

## 2. Problem

### 2.1 The asset

A central instrumentation facility at an Indian engineering college or university typically holds ₹2–₹20 crore of equipment: SEM, XRD, confocal microscope, HPLC, CNC, autoclave, furnace, GPU server, 3D printers. Each instrument has:

- A five-to-fifteen year useful life and a service contract nobody tracks centrally.
- A queue that exists in a WhatsApp group.
- A training requirement nobody can prove was completed.
- A maintenance bill that appears in a different cost centre from the one that booked it.
- A replacement decision that gets made once, badly, under time pressure.

### 2.2 Three failures that cost real money

**Idle capex.** In our own demo tenant (12 assets, ₹4.55 crore recorded value), one imaging instrument worth ₹1.1 crore ran at **1.8% utilisation** across the 180-day measurement window while six requests for it went unserved. The institution's instinct is to buy a second one. The correct decision is to move the first one.

**Repair spend nobody sees in aggregate.** A ₹9.8 lakh autoclave absorbed **₹2.95 lakh of repairs — 30% of its purchase price** — and sat down for 242 hours, on 17 completed sessions in the same window. No spreadsheet in the institution shows those three facts side by side.

**Phantom utilisation.** Facilities report "booked hours" as utilisation. Booked hours include no-shows (SEM-01: 29 no-shows against 242 completed sessions), maintenance downtime (448 hours), and sessions that ended early. Core-facility measurement literature has warned about exactly this for years: annual usage time does not capture holidays, leave, maintenance or QC downtime.

### 2.3 Why software has not fixed it

I-STEM already digitised the *national discovery* layer for publicly funded R&D facilities — listings, custodians, reservations. Enterprise lab suites (BookitLab, Stratocore, Clustermarket, Toolsquare) do scheduling, billing, training and access control. They are priced and scoped for well-funded core facilities and often assume hardware integration.

That leaves the actual buyer in India — a private college, a university department, an incubator, a maker space — with a system that is too heavy, too expensive and too foreign to their workflow, so they use WhatsApp. **The competitor is not BookitLab. The competitor is a WhatsApp group and a purchase file.**

Our wedge is deliberately narrow: the facility manager's daily pain (who has it, who approved it, who used it, what broke) plus the leadership question the same data can answer (buy, repair, share, move, or retire).

---

## 3. Solution

### 3.1 One loop, two buyers

```
   booking control loop                        capital decision loop
   ─────────────────────                       ─────────────────────
   eligibility → approval → reservation        measurement → five options
        ↓            ↓            ↓                   ↓
   check-in → usage → condition               assumptions + missing data
        ↓            ↓            ↓                   ↓
   incident ← maintenance ← downtime          recommendation (rules, not AI)
        ↓            ↓            ↓                   ↓
        └────── evidence trail ──────┘         human decision + rationale
                                                     ↓
                                            immutable decision record
```

The facility manager gets the first loop. The Dean and the finance office get the second, generated from the first. **The ops tool pays for itself by producing the capital argument.**

### 3.2 The five options, computed not asserted

For any selected asset the system produces a comparable assessment of:

1. **Buy new** — replacement cost, lead time, capability delta, and the residual value of the old unit.
2. **Repair** — recent repair spend, downtime hours, fault recurrence, remaining life.
3. **Share** — unused capacity, demand from other departments, external requests already turned away.
4. **Reallocate** — where the unmet demand sits, and what utilisation the asset would reach if it moved.
5. **Retire** — condition, age versus expected life, and the cost of keeping a dead asset on the books.

Each option carries a score, the arithmetic that produced it, and — critically — **the evidence that is missing**. An asset with no acquisition cost on record does not silently score as "free"; it is flagged as unassessed and the confidence drops. Zero is never assumed for unknown data.

### 3.3 The decision record is the product

A Capital Decision Record contains, in one immutable row:

asset · evidence snapshot (utilisation, downtime, unmet demand, repair spend, lifecycle) · all five option assessments · calculation inputs and formulas · stated assumptions · system recommendation and confidence · **the human's chosen option** · rationale · the named authorised user · created and decided timestamps.

Rules that make it credible:

- Only administrators and facility managers may generate or decide; a member cannot.
- A minimum rationale length is enforced server-side. "Approved" is not a rationale.
- The evidence snapshot is frozen at generation. Re-costing or renaming the asset afterwards does not rewrite history — verified by test.
- Choosing something other than the recommendation is allowed and **explicitly labelled an override**, with the recommended option retained for the record.
- `DELETE` on a decision record is rejected by the database.
- Generation and decision both write audit events.

This is the artefact a judge remembers: not a chart, a signed page.

---

## 4. Features

### 4.1 Implemented and demonstrable today

| Area | What works |
|---|---|
| **Tenancy & auth** | scrypt password hashing (per-user salt, constant-time compare), opaque session tokens stored as sha256 hashes, httpOnly/SameSite cookies, role-based access for administrator / facility manager / technician / member. |
| **Resource catalogue** | categories, specifications, location, capacity, per-resource opening hours, max slot length, approval requirement, required training, lifecycle fields (acquisition date and cost, replacement cost, expected life, condition, warranty, status). |
| **Eligibility engine** | membership, resource status, opening hours, training validity and expiry, per-user active-booking quota, booking horizon, maintenance blackout — checked on every request. |
| **Conflict-proof booking** | `EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at) WITH &&)` over active bookings. Eight simultaneous requests for one window: exactly one wins. |
| **Approvals** | manager approve/reject with a note; rejection becomes unmet-demand evidence. |
| **Usage evidence** | check-in window, check-out with condition note, no-show detection after grace via job runner, overdue session closure. |
| **Maintenance** | blackouts, overlap warnings with explicit override, downtime hours and cost per record, resolution. |
| **Incidents** | severity, status, resolution, resource release. |
| **Reports** | downtime-adjusted utilisation, actual usage, no-show rate, unmet demand by cause, weekly volume, incident summary, CSV export. |
| **Audit** | append-only `audit_events`, database trigger rejects `UPDATE`/`DELETE`, actor + entity + metadata. |
| **Import / export** | CSV resource import with actionable row errors; CSV export of utilisation, bookings, unmet demand, audit. |
| **Integration foundation** | typed connector contract, idempotent ingestion, external-ID mapping, provenance columns, sync runs with checkpoints, bounded retries, failed-record quarantine, AES-256-GCM sealed credentials, revocation. **No vendor connector — deliberately.** |
| **Capital decisions** | evidence dashboard, per-asset five-option assessment, persistent decision record, human override, audit. |
| **Synthetic demo tenant** | reproducible, insert-only, refuses to run outside a `_demo`/`_test` database: 5 departments, 12 assets, 1,341 bookings, 918 usage sessions, 37 maintenance records, 31 unmet-demand events. |

### 4.2 Deliberately not built (and why a judge should respect it)

Payments (nobody pays before the pilot converts), public marketplace (four-sided cold start), email delivery, file uploads for incidents, SSO/MFA, AI of any kind, hardware interlocks, native mobile apps.

Hardware control is refused for a reason worth saying out loud on stage: a failed integration that unlocks a laser cutter is a safety incident, a warranty problem and a lawsuit. Software that can *mis*-authorise physical access is worse than no software.

---

## 5. Tech stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| App | Next.js 16 App Router, React 19, TypeScript, Server Actions | One deployable unit; every mutation is a server action that re-reads the session, so there is no client-side auth to bypass. |
| Styling | Tailwind CSS v4 | Zero runtime cost, no component-library lock-in. |
| Database | PostgreSQL 16 (`btree_gist`, `pgcrypto`) | The product's central guarantees — overlap exclusion, row-level security, append-only triggers — are database features. No ORM hides them; SQL is hand-written. |
| Data access | `pg` + explicit SQL migrations | Migrations are reviewable files, not generated diffs. `withOrg()` opens a transaction, sets `app.current_organization_id`, and queues queries so pooled clients cannot interleave. |
| Auth | scrypt + hashed opaque tokens | No third-party identity dependency in v1; the session lookup happens before a tenant is known, which is why `memberships` is handled in code and documented as such. |
| Jobs | Cron-invoked Node script | At pilot scale a broker is a liability, not a feature. Add Redis only when a job needs >1 worker. |
| Isolation | 3 independent layers | Session/role → explicit `organization_id` filter → RLS policy keyed on the transaction GUC. Verified with the app role: zero rows without tenant context. |
| Deploy | Docker Compose behind Caddy/Nginx; Indian region VPS | Data residency expectation under DPDP; a ₹1,500/month VPS runs a pilot institution. |

**What we intentionally rejected:** microservices, Kubernetes, Kafka, a separate API process, a data warehouse, an ORM, blockchain, and any ML model. Every one of those would be a talking point and an operational bill, not a capability.

### 5.1 The security story in one breath

Three independent controls, each sufficient on its own to stop a cross-tenant read: the session action re-reads role and organisation; every query is scoped by `withOrg`; and PostgreSQL RLS returns nothing if the tenant GUC is absent. The test suite connects as the **non-superuser** application role and asserts zero rows without context — because RLS that is never exercised is decoration.

---

## 6. Novelty

Judges score novelty; be precise about what is actually new, because "AI for labs" is not new and everyone in the room will say it.

**1. The decision record, not the dashboard.**
Every team builds analytics. Almost none builds an artefact that survives a CAG audit: frozen evidence, five alternatives, stated assumptions, named human, rationale, timestamp, immutable. Analytics persuade; a decision record is accountable. That is the innovation, and it is a data-modelling and governance idea, not a UI idea.

**2. Refusal as a feature.**
The system will tell you it cannot recommend: "replacement cost is a derived estimate", "no maintenance records exist for this asset", "this asset has 3 sessions — too little evidence for a lifecycle call". Missing data lowers confidence and is printed on the record. Competitors' charts get prettier with less data; ours get quieter. This is the single most defensible design choice in the product and it is directly testable (`Missing data` test).

**3. Downtime-adjusted utilisation and unmet demand as first-class data.**
We do not report booked hours as utilisation. The measurement window is an explicit parameter (180 days by default) printed on every view, so nobody can quietly move the goalposts by choosing a flattering period. Available hours exclude maintenance; used hours come from check-in/check-out records; no-shows are a separate loss; rejected/unserved requests are recorded as unmet demand with a cause. This turns a vanity metric into a capital-allocation signal — and it is computed from raw rows every time, never stored.

**4. Human authority enforced by code, not policy language.**
The rules engine may only *recommend*. A record cannot reach `decided` without an authorised role, an option from the fixed set, and a substantive rationale. Overrides are permitted and permanently labelled. "Human in the loop" is usually a sentence in a slide; here it is a status CHECK constraint and a server-side guard.

**5. Trust demonstrated by failing operations, on stage.**
The demo includes the things that break: two users racing for one slot (one gets a clear conflict, not a 500), a cross-tenant ID returning 404, a decision record refusing `DELETE`, a member being rejected by an admin-only action. Most demos only show the happy path; ours shows the guard rails, because in an institutional sale the guard rails *are* the product.

**6. Integration-ready without faking an integration.**
A complete connector contract, idempotent ingestion, quarantine and checkpoints exist and are tested against a reference feed — and the docs state plainly that no vendor is connected. That is what enterprise procurement calls "credible roadmap"; a fake SAP logo is what they call a red flag.

---

## 7. Business impact

### 7.1 Impact inside one institution (measured on the demo tenant, not asserted)

| Signal | Observed | Decision it changes |
|---|---|---|
| Imaging instrument at 1.8% utilisation, ₹1.1 Cr recorded value, six unserved requests | 13 completed sessions in the 180-day window | **Reallocate / share** instead of buying a second unit — the largest single number in the demo (avoids a crore-scale purchase). |
| SEM at 67.3% utilisation, ₹10.3 L repairs, 448 h downtime, defined life exhausted | Buy-new scores 0.80 vs repair 0.60 | Replace, with the repair history as justification. |
| Autoclave: ₹2.95 L repairs on a ₹9.8 L asset, 242 h down, 17 sessions | Repair ratio ~30% of capex | **Retire or replace**, and stop paying to keep it. |
| 29 no-shows on one instrument (10.7% of its completed sessions) | ≈232 lost instrument-hours | Tighten quota/policy; the loss is now visible and attributable. |
| 31 unmet-demand events across the portfolio | Demand that exists but no capacity was allocated | Input to the next budget cycle instead of a hallway complaint. |

None of these are "guaranteed savings". They are three facts placed next to each other, which is precisely what no current tool does.

### 7.2 Impact at portfolio level

- **Capex deferral:** one avoided duplicate instrument purchase is worth more than a decade of our subscription. That asymmetry is the sales argument.
- **Repair discipline:** cumulative repair cost as a percentage of acquisition value, per asset, per department — the number that ends "just fix it again".
- **Audit readiness:** who approved access, who used the machine, what condition it was in, why it was replaced. Today this is reconstructed from memory during an inspection.
- **Fair access:** quotas and training validity turn "the professor's student always gets the SEM" into a documented policy.

### 7.3 Business model

| Plan | Price | Scope |
|---|---:|---|
| Paid pilot | ₹10,000–₹25,000 one-time, 60–90 days | One facility, ≤25 resources, onboarding, weekly review |
| Starter | ₹3,500/month or ₹35,000/year | 1 facility, 25 resources, 100 users |
| Campus | ₹9,000/month or ₹90,000/year | 5 facilities, 150 resources, training, reports |
| Institution | from ₹20,000/month | Multi-facility, audit exports, SSO readiness, integrations |

Per-facility packaging, not per-seat: the buyer is an institution, and penalising them for adding students would kill adoption.

**Three-year model** (cash received only; no "avoided purchases" counted as revenue):

| | Conservative | Base | Optimistic |
|---|---:|---:|---:|
| Customers, end Y1 | 5 | 12 | 25 |
| ACV | ₹40,000 | ₹60,000 | ₹90,000 |
| Y1 revenue | ₹1.0–1.5 L | ₹3–4 L | ₹8–12 L |
| Customers, end Y2 | 20 | 45 | 90 |
| Y2 revenue | ₹6–9 L | ₹18–25 L | ₹45–70 L |
| Customers, end Y3 | 45 | 110 | 220 |
| Y3 revenue | ₹18–25 L | ₹55–80 L | ₹1.3–2.0 Cr |
| Break-even | month 24–30 | month 18–24 | month 12–18 |

Cost base is deliberately boring: one VPS per institution (or one shared instance with RLS), no per-seat SaaS dependency, no ML inference bill. Gross margin stays above 85% even at Starter pricing.

**Go to market:** one city — Coimbatore, Pune, Bengaluru or Hyderabad — 30 facility visits, five discovery calls, three real workflows observed, three pilot commitments, then build. Entry point is the facility manager or lab in-charge, never the CIO. Sales message: *"Keep WhatsApp for chat. Use ResourceOS for the record that matters: who booked, who approved, who used it, and what happened."*

---

## 8. Competitive position

| | I-STEM | BookitLab / Stratocore / Clustermarket | Toolsquare | Skedda | Spreadsheet + WhatsApp | **ResourceOS** |
|---|---|---|---|---|---|---|
| Public discovery & booking of national facilities | ●●● | ○ | ○ | ○ | ○ | ✗ (by design) |
| Internal ops: eligibility, training, approvals, usage | ○ | ●●● | ●●● | ●● | ○ | ●●● |
| Capital/lifecycle decision evidence | ○ | ●● | ● | ✗ | ✗ | ●●● |
| Downtime-adjusted utilisation + unmet demand | ○ | ●● | ●● | ✗ | ✗ | ●●● |
| Immutable decision record with human authority | ✗ | ✗ | ✗ | ✗ | ✗ | ●●● |
| Price for a single Indian department | n/a | enterprise | enterprise | $99–349/mo per space | free | ₹3,500/mo |
| Self-hostable / data residency | ✗ | ✗ | ✗ | ✗ | n/a | ●●● |
| Hardware dependency | ✗ | optional | required for access control | ✗ | ✗ | none |

We do not compete on discovery (I-STEM owns it) or on feature breadth (enterprise suites own it). We compete on **the decision layer those systems do not produce, at a price and operational weight an Indian department can actually adopt.**

---

## 9. The 90-second demo

1. **Sign in as the facility manager.** Dashboard: today's bookings, pending approvals, downtime, incidents.
2. **Show a conflict refused.** Two booking submits for the same window — one succeeds, one gets a plain-language conflict. Say the word: *exclusion constraint, not a check.*
3. **Open `/capital`.** Twelve assets, ₹4.55 Cr recorded value, 26.2% portfolio utilisation, ₹26.5 L maintenance, 1,292 downtime hours — every figure labelled as synthetic demo data, with the formula and its limitations printed on the page.
4. **Open SEM-01.** Utilisation 67.3%, 448 hours down, ₹10.3 L repairs, life exhausted, 29 no-shows. Ask the room: buy or repair? Take a vote.
5. **Generate the assessment.** Five options, scores, arithmetic, assumptions, and the missing evidence. Buy-new 0.80, repair 0.60.
6. **Override it.** Choose repair, type a rationale. The record now says *overrides the system recommendation*, keeps both, names the human, timestamps it.
7. **Prove immutability.** Attempt the `DELETE`; the database refuses.
8. **Close on the gap.** Open the imaging instrument at 1.8% utilisation with six unserved requests: *this is the crore we stop them from spending.*

Fallback if the network dies: the test suite is the demo. `npm test` prints 40 passing guarantees, including the eight-way booking race and the cross-tenant read.

---

## 10. Roadmap

| Horizon | Milestone |
|---|---|
| **Hackathon finals** | Current build: booking loop, evidence dashboard, five-option assessment, decision record, 40 tests, synthetic tenant, integration foundation. |
| **Week 1–2 after** | Three pilot agreements in one city; baseline data collection (current booking method, conflicts per month, admin hours). |
| **Month 1–2** | First real provider connector against a documented sandbox API (a CMMS or a finance register); email delivery; incident file evidence via object storage. |
| **Month 2–4** | Pilot operation in 2–3 facilities; measure conflict rate, admin hours, no-show rate, report usage; publish one case study with observed numbers. |
| **Month 4–6** | Subscription billing, onboarding playbook, SSO readiness, scheduled report delivery, retention/deletion tooling for DPDP. |
| **Month 6+** | Cross-institution sharing — only after explicit sharing permissions are implemented and tested, insurance and liability are understood, and retention is proven. |

---

## 11. Risks, and what we say when asked

| Risk | Honest position |
|---|---|
| **"Institutions won't change workflow."** | True for big-bang migrations. We ask for one workflow: every confirmed booking for one facility must originate in the system. Import, run in parallel for 30 days, mandate one rule. |
| **"Procurement is slow."** | Paid pilot at ₹10–25k can be approved by a department head, not a tender committee. That is why the pilot price exists. |
| **"Your demo data is synthetic."** | Correct, and labelled on every screen. The engine is real and tested; the tenant is a fixture that proves the arithmetic. We will not dress a fixture as traction. |
| **"Enterprise suites already do this."** | They do scheduling better than us and always will. They do not produce an immutable capital decision record for a ₹3,500/month Indian department. |
| **"AI would make this better."** | Not yet. Forecasting needs months of clean tenant data we do not have. The rules engine is auditable, and an auditable recommendation is what a Dean will actually sign. |
| **"What if the data is wrong?"** | Then the record says so. Derived costs are flagged, missing fields are listed, confidence drops. Wrong input produces a visibly weak recommendation, not a confident lie. |
| **"Security?"** | Three independent isolation layers, verified with the non-superuser role; append-only audit; sealed credentials; no secrets in client bundles. Known limitation documented: `memberships` is RLS-disabled because login precedes tenant resolution. |
| **"Why won't a bigger player copy you?"** | They can copy the feature. The assets are the institution's own historical data, the switching cost is the audit trail, and the buyer is below their price floor. |

---

## 12. Why this belongs in the top three

| Judging axis | Our position |
|---|---|
| **Problem relevance** | Every institution in the room owns shared equipment and has no system of record for it. The pain is verifiable by asking one judge's own college. |
| **Technical depth** | Database-enforced conflict prevention, RLS verified as a non-superuser, append-only audit, deterministic rules engine, tenant-scoped integration engine with idempotency and quarantine. 40 tests, not 40 screenshots. |
| **Novelty** | The immutable, evidence-frozen capital decision record with enforced human authority and printed missing data. Nobody else in the room is modelling accountability. |
| **Business viability** | Per-facility pricing inside a department head's approval limit; one avoided duplicate instrument pays for a decade of subscription; single-city GTM with named institutions. |
| **Demo quality** | The happy path *and* the guard rails: a lost race, a refused delete, a rejected member, a human override. |
| **Integrity** | We state the four things we have not built, on the same slide as the things we have. In a room of 500 teams, that is the rarest asset. |

**The one sentence to leave in the judge's head:**

> ResourceOS is the only system in this competition that can prove who used a ₹1.1 crore instrument, what it cost to keep alive, and why a named human decided to replace it — and it refuses to sign that page without the evidence.

---

## Appendix A — Verification log (as of this build)

- `npm test` — 40 passing: 7 tenancy/concurrency/audit, 10 integration foundation, 5 integration server-action authorization, 5 partial-sync checkpoints, 13 capital decision.
- `npm run lint` — clean.
- `npm run build` — production build and TypeScript check pass; 19 routes.
- Browser walkthrough on the synthetic tenant: dashboard → asset → evidence → five options → generated record → human override → decided record → audit events. No console or network errors.
- Development database preserved: only additive migrations applied; demo tenant lives in a separate `_demo` database.

## Appendix B — Figures that must be re-verified before submission

- Number of AICTE-approved technical institutions and universities in India (use the current official count, not an estimate).
- Typical central-instrumentation asset value per institution (use a range from two or three real facility visits once pilots begin).
- I-STEM's current scope for internal institutional workflow (confirm it remains discovery/booking, not internal operations).
- Competitor pricing pages (BookitLab, Stratocore, Clustermarket, Toolsquare, Skedda) on the day of the pitch.
