/**
 * Builds the CodeHack India 2026 pitch deck for ResourceOS.
 *
 *   npm install --no-save pptxgenjs
 *   node scripts/make-deck.mjs
 *
 * Output: docs/ResourceOS-CodeHack-2026.pptx (16 slides, 16:9, speaker notes)
 *
 * Visual language: deep teal ground, concentric ring motif, serif titles,
 * footer "name · project" and a page number — per the supplied template.
 *
 * Copy rules: no claim appears here that the build does not support. Anything
 * that is plan rather than product is labelled PLAN, P0/P1 or FUTURE.
 */
import pptxgen from "pptxgenjs";

const OUT = "docs/ResourceOS-CodeHack-2026.pptx";

const C = {
  bg: "0C3A3F",
  panel: "0F474D",
  panelDeep: "0A3135",
  line: "1C5A5F",
  ring: "17565B",
  mint: "8FE0D2",
  mintDim: "5FA9A0",
  white: "FFFFFF",
  soft: "CFE2E1",
  muted: "8FB6B8",
  amber: "F2B36B",
};

const SERIF = "Georgia";
const SANS = "Segoe UI";

const W = 13.333;
const H = 7.5;
const M = 0.85;
const CW = W - M * 2; // 11.63

const pptx = new pptxgen();
pptx.defineLayout({ name: "DECK16x9", width: W, height: H });
pptx.layout = "DECK16x9";
pptx.author = "Vijesh S, Nisha M, Sanjay S";
pptx.title = "ResourceOS — Equipment Decision OS";
pptx.subject = "CodeHack India 2026";

let page = 0;

/** Concentric ring motif, drawn before any text so the fill cannot cover it. */
function rings(s, cx, cy, radii) {
  radii.forEach((r) => {
    s.addShape(pptx.ShapeType.ellipse, {
      x: cx - r,
      y: cy - r,
      w: r * 2,
      h: r * 2,
      fill: { color: C.panel },
      line: { color: C.ring, width: 1.1 },
    });
  });
  s.addShape(pptx.ShapeType.ellipse, {
    x: cx - 0.26,
    y: cy - 0.26,
    w: 0.52,
    h: 0.52,
    fill: { color: C.ring },
    line: { color: C.ring, width: 0.5 },
  });
}

function base() {
  const s = pptx.addSlide();
  s.background = { color: C.bg };
  page += 1;

  // Top-right and bottom-left ornaments, kept clear of the text column.
  rings(s, 12.55, 0.5, [3.1, 2.45, 1.85, 1.3, 0.8]);
  rings(s, -0.5, 7.75, [3.3, 2.6, 1.95, 1.35]);

  s.addText("Vijesh S · Nisha M · Sanjay S   ·   ResourceOS", {
    x: M,
    y: 7.02,
    w: 7,
    h: 0.24,
    fontFace: SANS,
    fontSize: 8.5,
    color: C.mintDim,
  });
  s.addText(String(page), {
    x: W - M - 0.6,
    y: 7.02,
    w: 0.6,
    h: 0.24,
    fontFace: SANS,
    fontSize: 8.5,
    color: C.mintDim,
    align: "right",
  });

  return s;
}

function slide({ eyebrow, title, notes, titleW = 10.2, size = 28 }) {
  const s = base();
  s.addText(eyebrow.toUpperCase(), {
    x: M,
    y: 0.52,
    w: 9,
    h: 0.26,
    fontFace: SANS,
    fontSize: 9.5,
    bold: true,
    charSpacing: 1.7,
    color: C.mint,
  });
  s.addText(title, {
    x: M,
    y: 0.82,
    w: titleW,
    h: 1.05,
    fontFace: SERIF,
    fontSize: size,
    bold: true,
    color: C.white,
    valign: "top",
    lineSpacingMultiple: 0.95,
  });
  if (notes) s.addNotes(notes);
  return s;
}

function card(s, { x, y, w, h, fill = C.panel, line = C.line }) {
  s.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    fill: { color: fill },
    line: { color: line, width: 1 },
    rectRadius: 0.04,
  });
}

function bullets(s, { x, y, w, h, items, size = 11, color = C.soft, gap = 8 }) {
  s.addText(
    items.map((item) => ({
      text: item,
      options: { bullet: { code: "2022" }, breakLine: true },
    })),
    {
      x,
      y,
      w,
      h,
      fontFace: SANS,
      fontSize: size,
      color,
      valign: "top",
      paraSpaceAfter: gap,
      lineSpacingMultiple: 1.1,
    },
  );
}

/* ============================================================ 1 · title */
{
  const s = base();

  s.addText("CODEHACK INDIA 2026   ·   LIVE PROTOTYPE", {
    x: M,
    y: 1.0,
    w: 9,
    h: 0.28,
    fontFace: SANS,
    fontSize: 10,
    bold: true,
    charSpacing: 1.9,
    color: C.mint,
  });

  s.addText("ResourceOS", {
    x: M,
    y: 1.34,
    w: 9.5,
    h: 1.05,
    fontFace: SERIF,
    fontSize: 54,
    bold: true,
    color: C.white,
  });

  s.addText("Equipment decision OS for shared labs, instruments and maker spaces", {
    x: M,
    y: 2.42,
    w: 9.4,
    h: 0.42,
    fontFace: SANS,
    fontSize: 17,
    color: C.mint,
  });

  s.addText(
    "Who booked it, who approved it, who used it, what it cost to keep alive — and the evidence behind the next ₹1 crore decision.",
    {
      x: M,
      y: 2.9,
      w: 8.6,
      h: 0.8,
      fontFace: SANS,
      fontSize: 12.5,
      color: C.soft,
      lineSpacingMultiple: 1.15,
    },
  );

  const team = [
    ["Vijesh S", "Backend & data", "Schema, row-level security, booking engine, sync engine, test suite"],
    ["Nisha M", "Product & research", "Problem discovery, five-option capital model, pricing, docs"],
    ["Sanjay S", "Frontend & demo", "UI, synthetic tenant, browser verification, deck"],
  ];
  const tw = (CW - 0.4) / 3;
  team.forEach(([name, role, detail], index) => {
    const x = M + index * (tw + 0.2);
    card(s, { x, y: 4.6, w: tw, h: 1.42, fill: C.panelDeep });
    s.addText(name, {
      x: x + 0.24,
      y: 4.74,
      w: tw - 0.48,
      h: 0.28,
      fontFace: SANS,
      fontSize: 12.5,
      bold: true,
      color: C.white,
    });
    s.addText(role.toUpperCase(), {
      x: x + 0.24,
      y: 5.03,
      w: tw - 0.48,
      h: 0.24,
      fontFace: SANS,
      fontSize: 8.5,
      bold: true,
      charSpacing: 1.2,
      color: C.mint,
    });
    s.addText(detail, {
      x: x + 0.24,
      y: 5.3,
      w: tw - 0.48,
      h: 0.62,
      fontFace: SANS,
      fontSize: 8.5,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.06,
    });
  });

  s.addNotes(
    "Open with the hook, not the category: an institution can prove what it bought and cannot prove how it was used.\n\n" +
      "Introduce the three of you by what you built, in one clause each. Judges scoring 'team' are really asking whether one person did everything.\n\n" +
      "Say the data caveat once, early: the tenant on screen is synthetic and labelled. Getting ahead of it costs nothing; being caught costs the pitch.",
  );
}

/* ================================================== 2 · problem statement */
{
  const s = slide({
    eyebrow: "Problem statement",
    title: "Shared equipment is expensive — and nobody can prove how it is used",
    titleW: 10.6,
    size: 26,
    notes:
      "Keep this to thirty seconds: the failure is not that facilities lack a calendar, it is that nobody can answer a capital question with evidence.\n\n" +
      "The four needs on the right are the real design constraint. The facility manager carries the admin burden, the researcher wants access, the technician absorbs the consequences of a booking nobody checked, and leadership signs the cheque without data.\n\n" +
      "That is why the product must make the facility manager's day easier first — otherwise nothing else gets adopted.",
  });

  s.addText(
    "Booking runs on WhatsApp, approvals on email, usage on paper and cost on a purchase file. The result is a facility that cannot say which instrument is busy, which is dead, or which should never have been bought.",
    {
      x: M,
      y: 1.98,
      w: 6.55,
      h: 1.1,
      fontFace: SANS,
      fontSize: 12,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.18,
    },
  );

  bullets(s, {
    x: M,
    y: 3.18,
    w: 6.55,
    h: 3.1,
    size: 11,
    items: [
      "Double bookings, because nothing prevents two people confirming the same slot.",
      "Approvals lost in threads, so access depends on who is persuasive.",
      "No-shows and overruns that nobody records, so the loss is invisible.",
      "Damage disputes settled by memory, because condition is never captured.",
      "Unmet demand never counted, so the same instrument is bought twice.",
      "Calibration, warranty and stock status that no booking view knows about.",
    ],
  });

  card(s, { x: 7.75, y: 1.95, w: 4.73, h: 4.3, fill: C.panelDeep });
  s.addText("Four people need four different things", {
    x: 8.0,
    y: 2.12,
    w: 4.25,
    h: 0.3,
    fontFace: SANS,
    fontSize: 10.5,
    bold: true,
    color: C.mint,
  });

  const needs = [
    ["Facility manager", "Less chasing, one record, no spreadsheet reconciliation."],
    ["Researcher / student", "Fast, fair access without a WhatsApp negotiation."],
    ["Technician", "No surprise bookings on an instrument that is down."],
    ["Leadership & finance", "Evidence before buying, repairing, sharing or retiring."],
  ];
  needs.forEach(([who, what], index) => {
    const y = 2.52 + index * 0.9;
    s.addText(who, {
      x: 8.0,
      y,
      w: 4.2,
      h: 0.24,
      fontFace: SANS,
      fontSize: 9,
      bold: true,
      charSpacing: 0.8,
      color: C.white,
    });
    s.addText(what, {
      x: 8.0,
      y: y + 0.24,
      w: 4.2,
      h: 0.62,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.08,
    });
  });
}

/* ================================================= 3 · proposed solution */
{
  const s = slide({
    eyebrow: "Proposed solution",
    title: "Not just booking time — proving the resource was safe, ready and used",
    titleW: 10.8,
    size: 26,
    notes:
      "This is the one-line pitch. Say it once, slowly, then let the three layers below carry the detail.\n\n" +
      "The strategic trick is in the third layer: the operations data is not only for the facility manager, it is the raw material for a capital decision the Dean can sign. The ops tool pays for itself by producing the capital argument.\n\n" +
      "Do not oversell: 'safe, calibrated, maintained and properly stocked' is the direction of travel. Today three of those six checks are enforced; the rest are on the roadmap slide.",
  });

  s.addText(
    "“ResourceOS helps an institution manage shared equipment not by booking time, but by ensuring the right trained user can actually use a safe, calibrated, maintained and properly stocked resource.”",
    {
      x: M,
      y: 1.95,
      w: 10.6,
      h: 1.0,
      fontFace: SERIF,
      fontSize: 15,
      italic: true,
      color: C.white,
      valign: "top",
      lineSpacingMultiple: 1.16,
    },
  );

  const layers = [
    [
      "01 · BOOKING CONTROL",
      "The loop that runs daily",
      "Training-aware eligibility, approvals, conflict-proof reservation, check-in and check-out, incidents, maintenance blackouts. Database-enforced, not policy-enforced.",
    ],
    [
      "02 · EVIDENCE LEDGER",
      "Every session becomes a record",
      "Actual hours, downtime, no-shows, repair spend, unmet demand with a cause. Each figure computed from raw rows and printed with its formula.",
    ],
    [
      "03 · CAPITAL DECISION",
      "The reason the Dean signs",
      "Five options scored on that evidence — buy, repair, share, reallocate, retire — with the missing data named and a human decision recorded immutably.",
    ],
  ];
  const lw = (CW - 0.36) / 3;
  layers.forEach(([tag, title, body], index) => {
    const x = M + index * (lw + 0.18);
    card(s, { x, y: 3.15, w: lw, h: 2.1 });
    s.addText(tag, {
      x: x + 0.22,
      y: 3.3,
      w: lw - 0.44,
      h: 0.24,
      fontFace: SANS,
      fontSize: 8.5,
      bold: true,
      charSpacing: 1.2,
      color: C.mint,
    });
    s.addText(title, {
      x: x + 0.22,
      y: 3.58,
      w: lw - 0.44,
      h: 0.32,
      fontFace: SANS,
      fontSize: 12.5,
      bold: true,
      color: C.white,
    });
    s.addText(body, {
      x: x + 0.22,
      y: 3.95,
      w: lw - 0.44,
      h: 1.4,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.12,
    });
  });

  s.addText(
    "Existing tools manage calendars. ResourceOS manages operations — and turns them into the evidence behind a capital decision.",
    {
      x: M,
      y: 5.72,
      w: CW,
      h: 0.5,
      fontFace: SANS,
      fontSize: 11,
      bold: true,
      color: C.mint,
      lineSpacingMultiple: 1.1,
    },
  );
}

/* ========================================================== 4 · workflow */
{
  const s = slide({
    eyebrow: "Workflow",
    title: "Request → approval → usage → incident → evidence",
    notes:
      "Do not read all ten steps. Point at the two that differentiate: eligibility is checked against the scheduled start time, not the request date; and the last two steps are generated from the first eight with no separate reporting data to maintain.\n\n" +
      "If asked what happens when something breaks mid-flight: maintenance blocks availability and notifies affected users, incidents keep the asset 'under review', and every override carries a written reason into an append-only log.",
  });

  const steps = [
    ["01", "Resource setup", "Specs, location, lifecycle, required training, approval rule."],
    ["02", "Request", "Availability, quota, horizon checked at submit."],
    ["03", "Eligibility", "Training and expiry valid at the slot start."],
    ["04", "Approval", "Manager decides with a reason; rejection is evidence."],
    ["05", "Check-in", "Window opens before the slot; late means no-show."],
    ["06", "Usage & check-out", "Actual hours plus a condition note."],
    ["07", "Incident", "Severity, status, resolution, resource release."],
    ["08", "Maintenance", "Blackout, downtime hours, repair cost."],
    ["09", "Evidence", "Utilisation, no-shows, unmet demand, exports."],
    ["10", "Capital decision", "Five options, human choice, frozen record."],
  ];

  const cw = (CW - 4 * 0.14) / 5;
  steps.forEach(([index, label, sub], i) => {
    const row = Math.floor(i / 5);
    const col = i % 5;
    const x = M + col * (cw + 0.14);
    const y = 1.95 + row * 1.62;
    card(s, {
      x,
      y,
      w: cw,
      h: 1.48,
      fill: i >= 8 ? C.panelDeep : C.panel,
      line: i >= 8 ? C.mintDim : C.line,
    });
    s.addText(index, {
      x: x + 0.18,
      y: y + 0.14,
      w: 0.8,
      h: 0.22,
      fontFace: SANS,
      fontSize: 9,
      bold: true,
      color: C.mint,
    });
    s.addText(label, {
      x: x + 0.18,
      y: y + 0.38,
      w: cw - 0.36,
      h: 0.44,
      fontFace: SANS,
      fontSize: 11,
      bold: true,
      color: C.white,
      valign: "top",
    });
    s.addText(sub, {
      x: x + 0.18,
      y: y + 0.84,
      w: cw - 0.36,
      h: 0.56,
      fontFace: SANS,
      fontSize: 8.5,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.06,
    });
  });

  s.addText(
    "Every step writes who acted, when and why. Nothing is reconstructed from memory during an inspection.",
    {
      x: M,
      y: 5.5,
      w: CW,
      h: 0.4,
      fontFace: SANS,
      fontSize: 11,
      color: C.soft,
    },
  );
}

/* ====================================================== 5 · live features */
{
  const s = slide({
    eyebrow: "Features · built",
    title: "What exists in the prototype today",
    notes:
      "Click through two or three of these rather than listing them. The report page and the capital page are the two that prove depth.\n\n" +
      "The claim that matters: every item here is enforced server-side and covered by a test or a browser walkthrough. Nothing on this slide is a mock.",
  });

  const left = [
    "Tenant-scoped accounts with four roles",
    "Resource catalogue with lifecycle fields",
    "Availability, opening hours, blackouts",
    "Conflict-proof booking via exclusion constraint",
    "Training-aware eligibility",
    "Approvals with a recorded reason",
  ];
  const right = [
    "Check-in, check-out and condition note",
    "Incidents and maintenance with downtime cost",
    "Downtime-adjusted utilisation and no-show rate",
    "Unmet demand by cause, plus four CSV exports",
    "Append-only audit trail",
    "Capital decision records with human sign-off",
  ];

  bullets(s, { x: M, y: 2.0, w: 5.5, h: 3.4, items: left, size: 11.5, gap: 11 });
  bullets(s, { x: 6.75, y: 2.0, w: 5.5, h: 3.4, items: right, size: 11.5, gap: 11 });

  card(s, { x: M, y: 5.35, w: CW, h: 1.15, fill: C.panelDeep });
  s.addText("40 automated tests", {
    x: M + 0.28,
    y: 5.5,
    w: 3.2,
    h: 0.3,
    fontFace: SANS,
    fontSize: 11,
    bold: true,
    color: C.mint,
  });
  s.addText(
    "Eight-way race for one booking window (one wins) · cross-tenant read returns nothing · audit rows reject UPDATE and DELETE · decision records survive re-costing the asset.",
    {
      x: M + 3.55,
      y: 5.48,
      w: CW - 3.85,
      h: 0.9,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.12,
    },
  );
}

/* ================================================ 6 · operationally complete */
{
  const s = slide({
    eyebrow: "Features · missing today",
    title: "What makes it operationally complete",
    notes:
      "This slide exists because a judge who has run a lab will ask 'what about calibration? what about filament?' before you finish the demo.\n\n" +
      "Do not defend the gaps. Name them, give the priority, and explain the principle: a resource is not available because its calendar is free. That principle is the wedge on the next slide.\n\n" +
      "If time is short, say the four bucket headings and move on — the detail is in the repo docs.",
  });

  const buckets = [
    [
      "READINESS GATES",
      "P0 for labs",
      [
        "Calibration and compliance records with expiry; overdue blocks booking and check-in.",
        "Consumables linked to each resource, with quantity per session and minimum-stock alerts.",
        "AMC, warranty and vendor records with renewal reminders and coverage status.",
        "Resource dependencies: technician, room, tool kit, plus setup and cleanup buffers.",
      ],
    ],
    [
      "WORK RECORDS",
      "P1",
      [
        "Sample and job tracking: submitted → accepted → preparing → testing → completed → collected.",
        "Service requests and work orders from incidents, with parts, labour, cost and verification.",
        "SOP versioning with acknowledgement before check-in, and the active version stamped on each session.",
        "Emergency override with a mandatory reason, affected-user notification and audit trail.",
      ],
    ],
    [
      "FAIRNESS & MONEY",
      "P1 / P2",
      [
        "Waitlist with promotion rules, priority by group or deadline, and a stated reason for not promoting.",
        "Cooldown after a no-show, weekly and monthly caps, unused-quota release window.",
        "Guest and visiting-researcher access with expiry and automatic revocation (P2).",
        "Cost allocation to department, project or grant, with monthly chargeback exports.",
      ],
    ],
    [
      "REACH & ADOPTION",
      "P0 / P1",
      [
        "Self-serve onboarding: guided checklist, templates by category, import with row-level error fixing.",
        "Calendar invitations (.ics), email reminders before the slot, and staff calendar sync.",
        "Offline and low-connectivity mode: staff check-in on behalf, queued actions, clear offline status.",
        "Accessibility basics now; Tamil or Hindi interface later (P2).",
      ],
    ],
  ];

  const bw = (CW - 0.18) / 2;
  buckets.forEach(([title, tag, items], index) => {
    const x = M + (index % 2) * (bw + 0.18);
    const y = 1.92 + Math.floor(index / 2) * 2.34;
    card(s, { x, y, w: bw, h: 2.2, fill: C.panelDeep });
    s.addText(title, {
      x: x + 0.22,
      y: y + 0.13,
      w: 3.6,
      h: 0.24,
      fontFace: SANS,
      fontSize: 9,
      bold: true,
      charSpacing: 1.3,
      color: C.mint,
    });
    s.addText(tag, {
      x: x + bw - 1.75,
      y: y + 0.13,
      w: 1.5,
      h: 0.24,
      fontFace: SANS,
      fontSize: 8.5,
      bold: true,
      color: C.amber,
      align: "right",
    });
    s.addText(
      items.map((item) => ({
        text: item,
        options: { bullet: { code: "2022" }, breakLine: true },
      })),
      {
        x: x + 0.22,
        y: y + 0.44,
        w: bw - 0.44,
        h: 1.66,
        fontFace: SANS,
        fontSize: 8.8,
        color: C.soft,
        valign: "top",
        paraSpaceAfter: 4,
        lineSpacingMultiple: 1.04,
      },
    );
  });
}

/* ====================================================== 7 · priority matrix */
{
  const s = slide({
    eyebrow: "Prioritisation",
    title: "What we build next, and what we refuse",
    notes:
      "Judges reward sequencing more than ambition. Everything here is ordered by what blocks a real facility from switching off Excel, not by what demos well.\n\n" +
      "The rejects matter as much as the priorities: hardware power control, a public marketplace and AI penalties are all things a competitor will proudly announce. Explain why they are wrong for this buyer — safety liability, four-sided cold start, and irreversible decisions made by software.",
  });

  const rows = [
    ["Calibration and compliance blocking", "Unsafe or invalid use, no matter how free the slot", "P0 · labs"],
    ["Emergency override and downtime comms", "Every real facility needs an exception path", "P0"],
    ["Self-serve onboarding and import", "Otherwise this becomes a consulting business", "P0/P1"],
    ["Consumables and stock linkage", "Stops “booked but unusable” sessions", "P1"],
    ["Waitlist fairness and quotas", "Trust in high-demand instruments", "P1"],
    ["AMC, warranty and vendor records", "Ends blind repair spending", "P1"],
    ["Sample and job tracking", "The real unit of work in research labs", "P1"],
    ["Work orders from incidents", "Incidents need closure, not just reporting", "P1"],
    ["SOP versioning and acknowledgement", "Safety evidence for each session", "P1"],
    ["Cost allocation and chargeback", "The finance team signs the renewal", "P1"],
  ];

  const y0 = 1.95;
  s.addText("FEATURE", { x: M, y: y0, w: 4.4, h: 0.24, fontFace: SANS, fontSize: 8, bold: true, charSpacing: 1.2, color: C.mintDim });
  s.addText("WHY IT MATTERS", { x: M + 4.5, y: y0, w: 4.6, h: 0.24, fontFace: SANS, fontSize: 8, bold: true, charSpacing: 1.2, color: C.mintDim });
  s.addText("PRIORITY", { x: M + 9.7, y: y0, w: 1.9, h: 0.24, fontFace: SANS, fontSize: 8, bold: true, charSpacing: 1.2, color: C.mintDim, align: "right" });

  rows.forEach(([feature, why, priority], index) => {
    const y = y0 + 0.4 + index * 0.42;
    s.addShape(pptx.ShapeType.line, {
      x: M,
      y: y - 0.06,
      w: CW,
      h: 0,
      line: { color: C.line, width: 0.75 },
    });
    s.addText(feature, {
      x: M,
      y,
      w: 4.4,
      h: 0.26,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.white,
    });
    s.addText(why, {
      x: M + 4.5,
      y,
      w: 4.9,
      h: 0.26,
      fontFace: SANS,
      fontSize: 9,
      color: C.muted,
    });
    s.addText(priority, {
      x: M + 9.7,
      y,
      w: 1.9,
      h: 0.26,
      fontFace: SANS,
      fontSize: 9,
      bold: true,
      color: priority.startsWith("P0") ? C.amber : C.mint,
      align: "right",
    });
  });

  card(s, { x: M, y: 6.42, w: CW, h: 0.48, fill: C.panelDeep });
  s.addText(
    "Rejected on purpose: hardware power and interlocks · public marketplace · AI penalties or access decisions",
    {
      x: M + 0.2,
      y: 6.53,
      w: CW - 0.4,
      h: 0.28,
      fontFace: SANS,
      fontSize: 8.8,
      color: C.muted,
    },
  );
}

/* ======================================================= 8 · the wedge */
{
  const s = slide({
    eyebrow: "The wedge",
    title: "“Available” is not the same as “usable”",
    notes:
      "This is the strongest single idea in the deck, so land it clearly: a free calendar is not permission to use an instrument.\n\n" +
      "Read the six gates slowly. Three are enforced today (maintenance, training, open incidents). Calibration, stock and staff support are the next build — the roadmap slide says so, and saying so is what makes the claim credible.\n\n" +
      "The example on the right is the line that stays with a judge: the 3D printer is free, but there is no filament, so the booking is blocked with a reason instead of failing in the lab.",
  });

  s.addText("A resource is bookable only when all six hold", {
    x: M,
    y: 1.95,
    w: 7.4,
    h: 0.32,
    fontFace: SANS,
    fontSize: 11,
    bold: true,
    color: C.mint,
  });

  const gates = [
    ["Maintenance", "No blackout, no unresolved fault — enforced today.", true],
    ["Calibration", "Certificate valid for the slot date — next build.", false],
    ["Consumables", "Required stock at or above the session minimum — next build.", false],
    ["Support", "Required technician or supervisor available — next build.", false],
    ["Safety", "No open incident holding the asset under review — enforced today.", true],
    ["Eligibility", "User trained, quota free, inside the horizon — enforced today.", true],
  ];
  gates.forEach(([label, detail, enforced], index) => {
    const y = 2.4 + index * 0.6;
    s.addShape(pptx.ShapeType.ellipse, {
      x: M,
      y: y + 0.07,
      w: 0.16,
      h: 0.16,
      fill: { color: enforced ? C.mint : C.amber },
      line: { color: C.bg, width: 0.5 },
    });
    s.addText(label, {
      x: M + 0.32,
      y,
      w: 1.85,
      h: 0.28,
      fontFace: SANS,
      fontSize: 10.5,
      bold: true,
      color: C.white,
    });
    s.addText(detail, {
      x: M + 2.22,
      y: y + 0.03,
      w: 4.9,
      h: 0.34,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.muted,
      valign: "top",
    });
  });

  card(s, { x: 8.05, y: 1.95, w: 4.43, h: 3.55, fill: C.panelDeep, line: C.mintDim });
  s.addText("EXAMPLE", {
    x: 8.3,
    y: 2.12,
    w: 3.9,
    h: 0.24,
    fontFace: SANS,
    fontSize: 8.5,
    bold: true,
    charSpacing: 1.3,
    color: C.mint,
  });
  s.addText("“3D printer is free at 14:00 — but the required filament is out of stock.”", {
    x: 8.3,
    y: 2.44,
    w: 3.9,
    h: 1.05,
    fontFace: SERIF,
    fontSize: 12.5,
    italic: true,
    color: C.white,
    valign: "top",
    lineSpacingMultiple: 1.14,
  });
  s.addText(
    "The booking is refused with a reason, and the reorder log is one click away — instead of the student discovering it in the lab.",
    {
      x: 8.3,
      y: 3.6,
      w: 3.9,
      h: 1.1,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.14,
    },
  );
  s.addText("Booked but unusable is the failure this prevents.", {
    x: 8.3,
    y: 4.95,
    w: 3.9,
    h: 0.4,
    fontFace: SANS,
    fontSize: 9.5,
    bold: true,
    color: C.mint,
  });

  s.addText(
    "That single change turns a booking calendar into a facility operations system.",
    {
      x: M,
      y: 6.02,
      w: 7.4,
      h: 0.55,
      fontFace: SANS,
      fontSize: 10.5,
      italic: true,
      color: C.soft,
      lineSpacingMultiple: 1.12,
    },
  );
}

/* ========================================================== 9 · novelty */
{
  const s = slide({
    eyebrow: "Novelty",
    title: "What nobody else in this room is building",
    notes:
      "Be precise, because 'AI for labs' is not novel and half the room will claim it.\n\n" +
      "The strongest claim is the decision record: frozen evidence, five options, stated assumptions, a named human, and a database that refuses deletion. Analytics persuade; a record is accountable.\n\n" +
      "Second strongest is refusal as a feature: the system prints what it does not know and lowers its own confidence. Test it live if asked — the capital page lists the missing evidence per asset.",
  });

  const items = [
    [
      "01",
      "The decision record",
      "Not a dashboard. A frozen snapshot, five scored options, the assumptions, the missing data, a named human, a rationale — and DELETE refused by the database.",
    ],
    [
      "02",
      "Refusal as a feature",
      "No cost on record, three sessions of history, a derived replacement figure: each one is printed and lowers confidence. Competitors' charts get prettier with less data; ours get quieter.",
    ],
    [
      "03",
      "Downtime-adjusted utilisation",
      "Available hours exclude maintenance, used hours come from check-in and check-out, no-shows are a separate loss, and unserved requests are recorded with a cause.",
    ],
    [
      "04",
      "Human authority in code",
      "The engine may only recommend. A record cannot reach decided without an authorised role, one of five options and a written rationale. Overrides are allowed and permanently labelled.",
    ],
    [
      "05",
      "Guard rails as the demo",
      "A lost booking race, a cross-tenant 404, a refused delete, a rejected member. Most demos show the happy path; in an institutional sale the guard rails are the product.",
    ],
  ];

  items.forEach(([index, title, body], i) => {
    const y = 1.95 + i * 0.92;
    s.addText(index, {
      x: M,
      y,
      w: 0.6,
      h: 0.34,
      fontFace: SERIF,
      fontSize: 18,
      bold: true,
      color: C.mintDim,
    });
    s.addText(title, {
      x: M + 0.62,
      y: y + 0.04,
      w: 2.6,
      h: 0.5,
      fontFace: SANS,
      fontSize: 11.5,
      bold: true,
      color: C.white,
      valign: "top",
    });
    s.addText(body, {
      x: M + 3.4,
      y: y + 0.02,
      w: 8.1,
      h: 0.78,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.12,
    });
  });
}

/* ========================================================= 10 · evidence */
{
  const s = slide({
    eyebrow: "Evidence",
    title: "Measured records change the capital decision",
    notes:
      "Start with the imaging instrument, not the portfolio total. One crore of avoided duplicate purchase is the story; 26% is the context.\n\n" +
      "Say the caveat in the same breath: synthetic tenant, workflow evidence, not guaranteed savings. Then the credible part — the page prints the formula and lists the data it is missing.\n\n" +
      "These numbers are read off /capital in the running app, so if challenged, show the screen instead of the slide.",
  });

  const stats = [
    ["12", "assets in the demo tenant"],
    ["₹4.55 Cr", "recorded acquisition value"],
    ["26.2%", "portfolio utilisation, 180 days"],
    ["₹26.5 L", "maintenance recorded"],
    ["1,292 h", "downtime recorded"],
  ];
  const sw = (CW - 0.5) / 5;
  stats.forEach(([value, label], index) => {
    const x = M + index * (sw + 0.125);
    card(s, { x, y: 1.95, w: sw, h: 1.15, fill: C.panelDeep });
    s.addText(value, {
      x: x + 0.2,
      y: 2.05,
      w: sw - 0.4,
      h: 0.46,
      fontFace: SERIF,
      fontSize: 20,
      bold: true,
      color: C.mint,
    });
    s.addText(label, {
      x: x + 0.2,
      y: 2.54,
      w: sw - 0.4,
      h: 0.5,
      fontFace: SANS,
      fontSize: 8.5,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.05,
    });
  });

  const rows = [
    ["Imaging instrument", "1.8% utilisation · 13 sessions · six unserved requests", "REALLOCATE", "before buying a second crore-scale unit"],
    ["SEM-01", "67.3% utilisation · ₹10.3 L repairs · 448 h down · life exhausted", "BUY NEW 0.80", "over repair 0.60"],
    ["AUTOCLAVE-01", "₹2.95 L repairs on a ₹9.8 L asset · 242 h down · 17 sessions", "RETIRE", "stop paying to keep it"],
  ];
  rows.forEach(([code, evidence, verdict, note], index) => {
    const y = 3.35 + index * 0.92;
    card(s, { x: M, y, w: CW, h: 0.8 });
    s.addText(code, {
      x: M + 0.24,
      y: y + 0.12,
      w: 2.05,
      h: 0.28,
      fontFace: SANS,
      fontSize: 10.5,
      bold: true,
      color: C.white,
    });
    s.addText(evidence, {
      x: M + 2.35,
      y: y + 0.11,
      w: 5.4,
      h: 0.56,
      fontFace: SANS,
      fontSize: 9,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.05,
    });
    s.addText(verdict, {
      x: M + 7.9,
      y: y + 0.12,
      w: 1.8,
      h: 0.28,
      fontFace: SANS,
      fontSize: 10,
      bold: true,
      color: C.mint,
      align: "right",
    });
    s.addText(note, {
      x: M + 9.85,
      y: y + 0.1,
      w: 1.75,
      h: 0.56,
      fontFace: SANS,
      fontSize: 8.5,
      italic: true,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.04,
    });
  });

  s.addText(
    "Synthetic demo tenant, 180-day window. Every figure is computed from the records on screen; each view prints its formula and the data it does not have. Evidence of the workflow — not guaranteed savings.",
    {
      x: M,
      y: 6.24,
      w: CW,
      h: 0.55,
      fontFace: SANS,
      fontSize: 8.8,
      italic: true,
      color: C.muted,
      lineSpacingMultiple: 1.08,
    },
  );
}

/* ============================================================ 11 · stack */
{
  const s = slide({
    eyebrow: "Stack",
    title: "The reliability claims are enforced, not promised",
    notes:
      "Do not read the stack aloud; judges can. Make three points.\n\n" +
      "1) The conflict guarantee is a database exclusion constraint: eight simultaneous requests, exactly one wins, no read-then-write window.\n" +
      "2) Isolation is three independent layers, and the suite connects as the non-superuser role — RLS that is never exercised is decoration.\n" +
      "3) The exclusions are design decisions: no IoT control, no marketplace, no payments, no autonomous decisions.",
  });

  s.addText("Stack", {
    x: M,
    y: 1.92,
    w: 4,
    h: 0.28,
    fontFace: SANS,
    fontSize: 10,
    bold: true,
    charSpacing: 1.3,
    color: C.mint,
  });

  const stack = [
    ["App", "Next.js 16 App Router · React 19 · TypeScript · Tailwind v4"],
    ["Database", "PostgreSQL 16 — btree_gist, pgcrypto, row-level security"],
    ["Data access", "pg with hand-written SQL and reviewable .sql migrations"],
    ["Jobs", "Cron-invoked Node worker: no-shows, overdue sessions"],
    ["Deploy", "Docker Compose behind Caddy · Indian region · self-hostable"],
  ];
  stack.forEach(([label, detail], index) => {
    const y = 2.35 + index * 0.66;
    s.addText(label, {
      x: M,
      y,
      w: 1.4,
      h: 0.28,
      fontFace: SANS,
      fontSize: 9,
      bold: true,
      color: C.mintDim,
    });
    s.addText(detail, {
      x: M + 1.5,
      y,
      w: 4.4,
      h: 0.58,
      fontFace: SANS,
      fontSize: 9.5,
      color: C.soft,
      valign: "top",
      lineSpacingMultiple: 1.08,
    });
  });

  const layers = [
    ["1 · Session and role", "Every server action and route re-reads the session. Hiding a button is never the control."],
    ["2 · Explicit tenant scope", "All queries run inside withOrg(), which sets the tenant for the transaction."],
    ["3 · Row-level security", "Policies compare organization_id to the transaction variable. No context returns nothing."],
  ];
  layers.forEach(([title, detail], index) => {
    const y = 1.92 + index * 1.24;
    card(s, { x: 6.5, y, w: 5.98, h: 1.12, fill: C.panelDeep });
    s.addText(title, {
      x: 6.75,
      y: y + 0.14,
      w: 5.5,
      h: 0.28,
      fontFace: SANS,
      fontSize: 10.5,
      bold: true,
      color: C.white,
    });
    s.addText(detail, {
      x: 6.75,
      y: y + 0.44,
      w: 5.5,
      h: 0.58,
      fontFace: SANS,
      fontSize: 9.2,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.08,
    });
  });

  s.addText(
    "Deliberately excluded in v1: IoT hardware control · public marketplace · payments · autonomous AI decisions · microservices.",
    {
      x: M,
      y: 5.95,
      w: CW,
      h: 0.4,
      fontFace: SANS,
      fontSize: 9.5,
      italic: true,
      color: C.muted,
    },
  );
  s.addText("40 tests · conflict race · cross-tenant read · append-only audit · credential sealing", {
    x: M,
    y: 6.38,
    w: CW,
    h: 0.3,
    fontFace: SANS,
    fontSize: 10,
    bold: true,
    color: C.mint,
  });
}

/* ================================================== 12 · business impact */
{
  const s = slide({
    eyebrow: "Business impact",
    title: "The buyer saves a crore; we charge ₹3,500 a month",
    titleW: 10.6,
    size: 27,
    notes:
      "Lead with the asymmetry, not the price list: one avoided duplicate instrument pays for about a decade of subscription. That is the whole commercial argument.\n\n" +
      "Be explicit that these are modelled figures with a hypothesis price, and that cash is the only thing counted — avoided capex is never booked as revenue.\n\n" +
      "Gross margin stays above 85% because there is no per-seat dependency and no inference bill: one small VPS per institution.",
  });

  const plans = [
    ["Paid pilot", "₹10–25k", "one-off · 60–90 days · one facility"],
    ["Starter", "₹3,500 / month", "1 facility · 25 resources · 100 users"],
    ["Campus", "₹9,000 / month", "5 facilities · 150 resources"],
    ["Institution", "from ₹20,000", "multi-facility · audit exports · SSO"],
  ];
  plans.forEach(([name, price, scope], index) => {
    const y = 1.95 + index * 0.82;
    card(s, { x: M, y, w: 5.2, h: 0.7, fill: C.panelDeep });
    s.addText(name, {
      x: M + 0.2,
      y: y + 0.08,
      w: 1.9,
      h: 0.26,
      fontFace: SANS,
      fontSize: 9.5,
      bold: true,
      color: C.white,
    });
    s.addText(price, {
      x: M + 0.2,
      y: y + 0.34,
      w: 2.0,
      h: 0.26,
      fontFace: SANS,
      fontSize: 10,
      bold: true,
      color: C.mint,
    });
    s.addText(scope, {
      x: M + 2.25,
      y: y + 0.22,
      w: 2.8,
      h: 0.4,
      fontFace: SANS,
      fontSize: 8.2,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.02,
    });
  });

  s.addText("Pricing is a validation-stage hypothesis, not proven market pricing.", {
    x: M,
    y: 5.3,
    w: 5.2,
    h: 0.4,
    fontFace: SANS,
    fontSize: 8.5,
    italic: true,
    color: C.muted,
    lineSpacingMultiple: 1.08,
  });

  card(s, { x: M, y: 5.85, w: 5.2, h: 0.82, fill: C.panel, line: C.mintDim });
  s.addText("One avoided duplicate instrument ≈ a decade of subscription.", {
    x: M + 0.2,
    y: 5.99,
    w: 4.8,
    h: 0.6,
    fontFace: SANS,
    fontSize: 10.5,
    bold: true,
    color: C.white,
    valign: "top",
    lineSpacingMultiple: 1.1,
  });

  // Right: unit economics + three-year cash model.
  s.addText("UNIT ECONOMICS", {
    x: 6.4,
    y: 1.92,
    w: 4,
    h: 0.26,
    fontFace: SANS,
    fontSize: 8.5,
    bold: true,
    charSpacing: 1.3,
    color: C.mint,
  });

  const econ = [
    ["₹60,000", "base annual contract value"],
    [">85%", "gross margin — no per-seat cost, no inference bill"],
    ["Month 18–24", "break-even in the base case"],
    ["₹0", "counted for avoided capex; only cash is revenue"],
  ];
  econ.forEach(([value, label], index) => {
    const y = 2.24 + index * 0.6;
    s.addText(value, {
      x: 6.4,
      y,
      w: 1.9,
      h: 0.3,
      fontFace: SANS,
      fontSize: 12,
      bold: true,
      color: C.mint,
    });
    s.addText(label, {
      x: 8.4,
      y: y + 0.04,
      w: 4.05,
      h: 0.4,
      fontFace: SANS,
      fontSize: 9,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.05,
    });
  });

  s.addText("REVENUE, CASH ONLY (₹ Lakh)", {
    x: 6.4,
    y: 4.75,
    w: 4.5,
    h: 0.26,
    fontFace: SANS,
    fontSize: 8.5,
    bold: true,
    charSpacing: 1.3,
    color: C.mint,
  });

  const table = [
    ["", "Conservative", "Base", "Optimistic"],
    ["Year 1", "1.0–1.5", "3–4", "8–12"],
    ["Year 2", "6–9", "18–25", "45–70"],
    ["Year 3", "18–25", "55–80", "130–200"],
  ];
  table.forEach((row, r) => {
    const y = 5.06 + r * 0.4;
    row.forEach((cell, c) => {
      s.addText(cell, {
        x: 6.4 + c * 1.6,
        y,
        w: 1.55,
        h: 0.28,
        fontFace: SANS,
        fontSize: r === 0 ? 8 : 9.5,
        bold: r === 0 || c === 0,
        color: r === 0 ? C.mintDim : c === 0 ? C.white : C.soft,
        align: c === 0 ? "left" : "right",
      });
    });
    s.addShape(pptx.ShapeType.line, {
      x: 6.4,
      y: y + 0.32,
      w: 6.2,
      h: 0,
      line: { color: C.line, width: 0.75 },
    });
  });
}

/* ======================================================== 13 · position */
{
  const s = slide({
    eyebrow: "Position",
    title: "Where we sit among the tools a Dean will name",
    notes:
      "Answer the competitor question before it is asked. I-STEM owns national discovery; enterprise suites own the calendar for funded core facilities; Skedda owns generic room booking at $99–349 per space per month.\n\n" +
      "None produces a capital decision record, and none is priced or scoped for a single Indian department. Say the last row slowly — it is the only row that is us.",
  });

  const rows = [
    ["I-STEM", "National discovery and booking of publicly funded research facilities.", "Public discovery, not internal operations"],
    ["BookitLab · Stratocore · Clustermarket", "Scheduling, billing, training, access control for funded core facilities.", "Enterprise price and scope"],
    ["Skedda", "Generic space booking at $99–349 per space per month.", "No lab entities, no capex evidence"],
    ["Spreadsheet + WhatsApp", "Free, familiar, zero training.", "No conflict prevention, no record"],
    ["ResourceOS", "Booking loop + evidence + capital decision record, self-hostable, per facility.", "₹3,500/month upward"],
  ];

  rows.forEach(([who, what, verdict], index) => {
    const y = 1.92 + index * 0.86;
    const us = index === rows.length - 1;
    card(s, {
      x: M,
      y,
      w: CW,
      h: 0.74,
      fill: us ? C.panel : C.panelDeep,
      line: us ? C.mintDim : C.line,
    });
    s.addText(who, {
      x: M + 0.24,
      y: y + 0.12,
      w: 3.5,
      h: 0.3,
      fontFace: SANS,
      fontSize: us ? 10.5 : 9.5,
      bold: true,
      color: us ? C.mint : C.white,
      valign: "top",
    });
    s.addText(what, {
      x: M + 3.85,
      y: y + 0.1,
      w: 4.9,
      h: 0.6,
      fontFace: SANS,
      fontSize: 9,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.05,
    });
    s.addText(verdict, {
      x: M + 8.9,
      y: y + 0.12,
      w: 2.5,
      h: 0.55,
      fontFace: SANS,
      fontSize: 9,
      bold: us,
      italic: !us,
      color: us ? C.white : C.mintDim,
      valign: "top",
      align: "right",
      lineSpacingMultiple: 1.05,
    });
  });

  s.addText(
    "The real competitor is a WhatsApp group and a purchase file — and neither produces a record a Dean can sign.",
    {
      x: M,
      y: 6.3,
      w: CW,
      h: 0.35,
      fontFace: SANS,
      fontSize: 9.5,
      italic: true,
      color: C.muted,
    },
  );
}

/* ========================================================== 14 · roadmap */
{
  const s = slide({
    eyebrow: "Roadmap",
    title: "Validate in one city, then scale the evidence",
    notes:
      "Fifteen seconds: the next spend is on validation, not features. The success criteria are written down and measurable, and if they fail the answer is no.\n\n" +
      "That willingness to stop is unusual in a hackathon final and it is what makes the plan believable.",
  });

  const phases = [
    ["01 · VALIDATE", "25–30 interviews", "Facility managers, technicians, users and budget owners in one city. Baseline conflicts, admin hours, no-shows."],
    ["02 · PILOT", "2–3 facilities", "One workflow mandated: every confirmed booking starts in ResourceOS. Weekly review for 90 days."],
    ["03 · PAID", "Convert or stop", "Continue only if 3+ staff use it weekly, 50+ real bookings, near-zero system conflicts, a report leadership uses."],
    ["04 · EXPAND", "Billing, SSO, connectors", "Subscription billing, onboarding playbook, CMMS and finance connectors against documented APIs, cost allocation."],
  ];
  const pw = (CW - 0.54) / 4;
  phases.forEach(([tag, title, body], index) => {
    const x = M + index * (pw + 0.18);
    card(s, { x, y: 1.95, w: pw, h: 2.05, fill: C.panelDeep });
    s.addShape(pptx.ShapeType.rect, {
      x,
      y: 1.95,
      w: pw,
      h: 0.05,
      fill: { color: index === 0 ? C.mint : C.mintDim },
    });
    s.addText(tag, {
      x: x + 0.22,
      y: 2.14,
      w: pw - 0.44,
      h: 0.24,
      fontFace: SANS,
      fontSize: 8.5,
      bold: true,
      charSpacing: 1.2,
      color: C.mint,
    });
    s.addText(title, {
      x: x + 0.22,
      y: 2.44,
      w: pw - 0.44,
      h: 0.5,
      fontFace: SANS,
      fontSize: 11.5,
      bold: true,
      color: C.white,
      valign: "top",
      lineSpacingMultiple: 1.04,
    });
    s.addText(body, {
      x: x + 0.22,
      y: 2.98,
      w: pw - 0.44,
      h: 1.3,
      fontFace: SANS,
      fontSize: 8.8,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.1,
    });
  });

  s.addText("STOP CONDITIONS", {
    x: M,
    y: 4.35,
    w: 4,
    h: 0.26,
    fontFace: SANS,
    fontSize: 8.5,
    bold: true,
    charSpacing: 1.3,
    color: C.amber,
  });
  bullets(s, {
    x: M,
    y: 4.68,
    w: CW,
    h: 1.4,
    size: 9.5,
    gap: 4,
    items: [
      "Fewer than 3 of 10 facility managers rank this in their top operational problems.",
      "No facility grants access to its real workflow, or users return to WhatsApp after the pilot.",
      "Pilots will not convert to a paid annual contract by the agreed decision date.",
    ],
  });
}

/* ==================================================== 15 · future scope */
{
  const s = slide({
    eyebrow: "Future scope",
    title: "Where this goes — gated by evidence, not enthusiasm",
    titleW: 10.8,
    size: 27,
    notes:
      "This is the slide that separates a roadmap from a wish list. Every step is gated on the previous one, and the gate is stated.\n\n" +
      "The 2028 telemetry item is worth a sentence: read-only by design, because a system that can unlock a machine is a safety and warranty problem, not a feature.\n\n" +
      "Forecasting is deliberately late: it needs twelve months of clean tenant data. Predictions on synthetic data are the fastest way to lose a technical judge.",
  });

  const future = [
    ["2026–27", "Real connectors", "A CMMS or finance register against its documented sandbox API, email delivery, incident photo evidence in object storage, cost allocation exports."],
    ["2027", "Forecasting, with data", "Demand and no-show forecasting once a tenant has 12+ months of clean history. Classical models first; no deep learning, no decisions taken by the model."],
    ["2028", "Read-only telemetry", "Instrument run-hours and error codes ingested for evidence. Read-only by design — never power, locks or interlocks."],
    ["2028–29", "Multi-campus sharing", "Explicit sharing permissions, insurer and liability model, then cross-institution booking within a city network."],
    ["2029–30", "Institutional infrastructure", "Grant-utilisation and audit packs, DPDP retention tooling, public API for integrators, Tamil and Hindi interfaces."],
  ];

  future.forEach(([when, what, body], index) => {
    const y = 1.95 + index * 0.94;
    s.addText(when, {
      x: M,
      y: y + 0.02,
      w: 1.35,
      h: 0.28,
      fontFace: SANS,
      fontSize: 9.5,
      bold: true,
      color: C.mint,
    });
    s.addText(what, {
      x: M + 1.45,
      y: y + 0.02,
      w: 2.9,
      h: 0.28,
      fontFace: SANS,
      fontSize: 10,
      bold: true,
      color: C.white,
    });
    s.addText(body, {
      x: M + 4.45,
      y,
      w: 7.15,
      h: 0.78,
      fontFace: SANS,
      fontSize: 9,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.1,
    });
  });

  s.addText(
    "Each step is gated by the previous one — and every gate is a measurement, not a date.",
    {
      x: M,
      y: 6.6,
      w: CW,
      h: 0.32,
      fontFace: SANS,
      fontSize: 9.5,
      italic: true,
      color: C.soft,
    },
  );
}

/* ============================================================ 16 · close */
{
  const s = base();

  s.addText("THE LINE TO REMEMBER", {
    x: M,
    y: 1.15,
    w: 9,
    h: 0.28,
    fontFace: SANS,
    fontSize: 9.5,
    bold: true,
    charSpacing: 1.8,
    color: C.mint,
  });

  s.addText(
    "ResourceOS can prove who used a ₹1.1 crore instrument, what it cost to keep alive, and why a named human decided to replace it — and it refuses to sign that page without the evidence.",
    {
      x: M,
      y: 1.55,
      w: 8.7,
      h: 2.3,
      fontFace: SERIF,
      fontSize: 23,
      bold: true,
      color: C.white,
      valign: "top",
      lineSpacingMultiple: 1.06,
    },
  );

  const chips = [
    ["No vendor connector is claimed", "A tested foundation exists; no provider is connected."],
    ["No failure prediction", "We report downtime that happened, not failures we guess."],
    ["Synthetic demo tenant", "Labelled on every screen. Evidence of workflow, not savings."],
  ];
  const chipW = (10.4 - 0.4) / 3;
  chips.forEach(([title, body], index) => {
    const x = M + index * (chipW + 0.2);
    card(s, { x, y: 3.95, w: chipW, h: 1.2, fill: C.panelDeep, line: C.mintDim });
    s.addText(title, {
      x: x + 0.22,
      y: 4.1,
      w: chipW - 0.44,
      h: 0.28,
      fontFace: SANS,
      fontSize: 10,
      bold: true,
      color: C.white,
      valign: "top",
    });
    s.addText(body, {
      x: x + 0.22,
      y: 4.4,
      w: chipW - 0.44,
      h: 0.75,
      fontFace: SANS,
      fontSize: 8.5,
      color: C.muted,
      valign: "top",
      lineSpacingMultiple: 1.1,
    });
  });

  s.addText("What we need: three pilot facilities in one city, and 90 days of real workflow data.", {
    x: M,
    y: 5.55,
    w: 10.4,
    h: 0.35,
    fontFace: SANS,
    fontSize: 11,
    bold: true,
    color: C.mint,
  });

  s.addText("Vijesh S · Nisha M · Sanjay S        CodeHack India 2026", {
    x: M,
    y: 6.35,
    w: 10,
    h: 0.3,
    fontFace: SANS,
    fontSize: 10.5,
    bold: true,
    color: C.soft,
  });

  s.addNotes(
    "End on the sentence, not on 'thank you'. Then stop and let questions start — the three honesty chips exist so the first question is not 'what is not real?'.\n\n" +
      "The ask is deliberately small and concrete: three facilities, 90 days. It is the only thing a judge could actually give you.",
  );
}

await pptx.writeFile({ fileName: OUT });
console.log(`wrote ${OUT} (${page} slides)`);
