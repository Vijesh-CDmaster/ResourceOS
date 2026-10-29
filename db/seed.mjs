// Seeds a demo tenant with 90 days of operating history.
// Run with: node --env-file=.env.local db/seed.mjs
import { scrypt as scryptCb, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";

const scrypt = promisify(scryptCb);
const connectionString =
  process.env.ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/resourceos";

const DEMO_PASSWORD = "demo1234";

async function hash(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
}

// Deterministic PRNG so re-seeding produces comparable reports.
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261029);
const pick = (items) => items[Math.floor(random() * items.length)];

function istToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00+05:30`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function at(isoDate, hour, minute = 0) {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`${isoDate}T${hh}:${mm}:00+05:30`);
}

function weekdayOf(isoDate) {
  return new Date(`${isoDate}T12:00:00+05:30`).getUTCDay();
}

const client = new Client({ connectionString });
await client.connect();

try {
  await client.query("BEGIN");
  await client.query(`
    TRUNCATE audit_events, notifications, unmet_demand_events, incidents, usage_sessions,
      bookings, blackout_periods, maintenance_records, availability_rules, resources,
      training_records, training_courses, memberships, facilities, departments, sessions,
      users, organizations RESTART IDENTITY CASCADE
  `);

  const org = (
    await client.query(
      `INSERT INTO organizations (name, slug, timezone, open_hour, close_hour, max_active_bookings, max_horizon_days, no_show_grace_minutes)
       VALUES ($1, $2, $3, 8, 20, 3, 30, 20) RETURNING id`,
      ["Meridian Institute of Technology", "meridian", "Asia/Kolkata"],
    )
  ).rows[0].id;

  const departments = {};
  for (const [name] of [
    ["Mechanical Engineering"],
    ["Electronics & Communication"],
    ["Biotechnology"],
    ["Chemistry"],
    ["Design & Media"],
  ]) {
    const id = (
      await client.query(
        "INSERT INTO departments (organization_id, name) VALUES ($1, $2) RETURNING id",
        [org, name],
      )
    ).rows[0].id;
    departments[name] = id;
  }

  const facilities = {};
  for (const [name, location] of [
    ["Central Fabrication Workshop", "Block C, Ground floor"],
    ["Materials Characterisation Lab", "Block D, Room 212"],
    ["Bio Innovation Lab", "Block E, Room 104"],
    ["Electronics Prototyping Hub", "Block B, Room 118"],
    ["Digital Media Studio", "Block A, Room 006"],
  ]) {
    const id = (
      await client.query(
        "INSERT INTO facilities (organization_id, name, location) VALUES ($1, $2, $3) RETURNING id",
        [org, name, location],
      )
    ).rows[0].id;
    facilities[name] = id;
  }

  const passwordHash = await hash(DEMO_PASSWORD);
  const people = [
    ["Priya Raghavan", "priya@meridian.edu", "admin", "Mechanical Engineering"],
    ["Arun Menon", "arun@meridian.edu", "manager", "Mechanical Engineering"],
    ["Kavya Iyer", "kavya@meridian.edu", "technician", "Electronics & Communication"],
    ["Rohan Sharma", "rohan@meridian.edu", "member", "Mechanical Engineering"],
    ["Meera Nair", "meera@meridian.edu", "member", "Biotechnology"],
    ["Aditya Verma", "aditya@meridian.edu", "member", "Electronics & Communication"],
    ["Sara Khan", "sara@meridian.edu", "member", "Chemistry"],
    ["Vikram Bose", "vikram@meridian.edu", "member", "Design & Media"],
  ];
  const users = {};
  for (const [name, email, role, dept] of people) {
    const id = (
      await client.query(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [email, name, passwordHash],
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO memberships (organization_id, user_id, role, department_id) VALUES ($1, $2, $3, $4)",
      [org, id, role, departments[dept]],
    );
    users[email.split("@")[0]] = id;
  }

  const courses = {};
  for (const [name, months, description] of [
    ["Machine shop safety", 12, "Guarded tool operation, PPE and emergency stop procedure."],
    ["XRD operator certification", 12, "Sample loading, radiation safety and GSAS data export."],
    ["Confocal microscopy", 12, "Laser safety, z-stack acquisition and shutdown."],
    ["Biosafety level 1", 12, "Autoclave handling, spill response and waste segregation."],
    ["Laser cutter safety", 12, "Material restrictions, fire watch and fume extraction."],
  ]) {
    const id = (
      await client.query(
        "INSERT INTO training_courses (organization_id, name, description, validity_months) VALUES ($1, $2, $3, $4) RETURNING id",
        [org, name, description, months],
      )
    ).rows[0].id;
    courses[name] = id;
  }

  // Training grants: most people are certified for the equipment they use.
  const trainingGrants = [
    ["rohan", "Machine shop safety", -280],
    ["meera", "Biosafety level 1", -120],
    ["meera", "Confocal microscopy", -60],
    ["aditya", "Machine shop safety", -200],
    ["aditya", "Laser cutter safety", -30],
    ["sara", "XRD operator certification", -320],
    ["sara", "Confocal microscopy", -10],
    ["vikram", "Laser cutter safety", -150],
    ["kavya", "XRD operator certification", -400],
    // deliberately expired: rohan's laser certification lapsed
    ["rohan", "Laser cutter safety", -400],
  ];
  for (const [slug, course, daysAgo] of trainingGrants) {
    const months = course === "Biosafety level 1" ? 12 : 12;
    const granted = new Date(at(istToday(), 10));
    granted.setUTCDate(granted.getUTCDate() + daysAgo);
    const expires = new Date(granted);
    expires.setUTCMonth(expires.getUTCMonth() + months);
    await client.query(
      `INSERT INTO training_records (organization_id, user_id, course_id, granted_by, granted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [org, users[slug], courses[course], users.kavya, granted, expires],
    );
  }

  const resourceDefs = [
    {
      code: "CNC-01", name: "CNC Milling Machine", category: "Fabrication",
      facility: "Central Fabrication Workshop", dept: "Mechanical Engineering",
      description: "3-axis CNC mill for aluminium, brass and mild steel. CAM file review required before the slot.",
      location: "Block C, Bay 2", capacity: 2, approval: true, training: "Machine shop safety",
      maxHours: 4, specs: { Make: "Haas TM-1P", Envelope: "762 × 406 × 508 mm", Spindle: "7.5 kW, 10,000 rpm" },
    },
    {
      code: "3DP-01", name: "FDM Printer Farm (4 units)", category: "Fabrication",
      facility: "Central Fabrication Workshop", dept: "Mechanical Engineering",
      description: "Four Prusa MK4 printers with PLA, PETG and TPU. Bring your own filament or use lab stock.",
      location: "Block C, Bay 4", capacity: 4, approval: false, training: null,
      maxHours: 8, specs: { Units: "4", Build: "250 × 210 × 220 mm", Materials: "PLA, PETG, TPU" },
    },
    {
      code: "XRD-01", name: "X-Ray Diffractometer", category: "Characterisation",
      facility: "Materials Characterisation Lab", dept: "Chemistry",
      description: "Powder and thin-film XRD. Booking includes a 15-minute alignment window; operator present for first session.",
      location: "Block D, Room 212", capacity: 1, approval: true, training: "XRD operator certification",
      maxHours: 3, specs: { Source: "Cu Kα", Range: "5–120° 2θ", Detector: "1D silicon strip" },
    },
    {
      code: "CLSM-01", name: "Confocal Microscope", category: "Imaging",
      facility: "Bio Innovation Lab", dept: "Biotechnology",
      description: "Laser scanning confocal with 405/488/561/640 nm lines. Fixed and live samples.",
      location: "Block E, Room 106", capacity: 2, approval: true, training: "Confocal microscopy",
      maxHours: 3, specs: { Objectives: "10×–63× oil", Lasers: "405 / 488 / 561 / 640 nm", Incubation: "Yes" },
    },
    {
      code: "HPLC-01", name: "HPLC System", category: "Wet Lab",
      facility: "Bio Innovation Lab", dept: "Chemistry",
      description: "Binary gradient HPLC with UV-Vis and RI detection. Column and solvents provided.",
      location: "Block E, Room 108", capacity: 1, approval: false, training: "Biosafety level 1",
      maxHours: 6, specs: { Pump: "Binary gradient", Detection: "UV-Vis, RI", Autosampler: "120 vials" },
    },
    {
      code: "AUTOCLAVE-01", name: "Autoclave", category: "Wet Lab",
      facility: "Bio Innovation Lab", dept: "Biotechnology",
      description: "121 °C steam sterilisation. Bags must be labelled; sharps are not accepted.",
      location: "Block E, Room 101", capacity: 1, approval: false, training: "Biosafety level 1",
      maxHours: 2, specs: { Chamber: "50 L", Cycle: "121 °C / 20 min", Validation: "Weekly spore test" },
    },
    {
      code: "PCB-01", name: "PCB Reflow Line", category: "Electronics",
      facility: "Electronics Prototyping Hub", dept: "Electronics & Communication",
      description: "Stencil printer, pick-and-place and 7-zone reflow oven. Lead-free process only.",
      location: "Block B, Room 118", capacity: 2, approval: true, training: "Machine shop safety",
      maxHours: 4, specs: { Zones: "7", "Max board": "300 × 300 mm", Process: "Lead-free" },
    },
    {
      code: "LASER-01", name: "CO₂ Laser Cutter", category: "Fabrication",
      facility: "Digital Media Studio", dept: "Design & Media",
      description: "80 W CO₂ cutter for acrylic, plywood and cardboard. No PVC or polycarbonate.",
      location: "Block A, Room 006", capacity: 1, approval: false, training: "Laser cutter safety",
      maxHours: 3, specs: { Power: "80 W", Bed: "900 × 600 mm", Materials: "Acrylic, plywood, card" },
    },
    {
      code: "GPU-01", name: "GPU Compute Node", category: "Computing",
      facility: "Electronics Prototyping Hub", dept: "Electronics & Communication",
      description: "4× A100 node for coursework and research training. Jobs are killed at the end of the slot.",
      location: "Block B, Server room", capacity: 8, approval: false, training: null,
      maxHours: 8, specs: { GPU: "4 × A100 40 GB", CPU: "64 cores", Memory: "512 GB" },
    },
    {
      code: "WIND-01", name: "Subsonic Wind Tunnel", category: "Testing",
      facility: "Central Fabrication Workshop", dept: "Mechanical Engineering",
      description: "Open-circuit tunnel with 600 × 600 mm test section and 6-axis force balance.",
      location: "Block C, Bay 6", capacity: 3, approval: true, training: "Machine shop safety",
      maxHours: 4, specs: { Speed: "2–45 m/s", Section: "600 × 600 mm", Balance: "6-axis" },
    },
  ];

  const resources = {};
  for (const def of resourceDefs) {
    const id = (
      await client.query(
        `INSERT INTO resources (organization_id, facility_id, department_id, code, name, category,
           description, location, capacity, status, requires_approval, training_course_id,
           max_hours_per_booking, specs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12,$13) RETURNING id`,
        [
          org, facilities[def.facility], departments[def.dept], def.code, def.name, def.category,
          def.description, def.location, def.capacity, def.approval,
          def.training ? courses[def.training] : null, def.maxHours, JSON.stringify(def.specs),
        ],
      )
    ).rows[0].id;
    resources[def.code] = { id, name: def.name, approval: def.approval, training: def.training };

    for (let weekday = 0; weekday <= 6; weekday++) {
      if (weekday === 0) continue; // closed Sundays
      await client.query(
        `INSERT INTO availability_rules (organization_id, resource_id, weekday, opens_at, closes_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [org, id, weekday, "09:00", def.code === "GPU-01" ? "21:00" : "18:00"],
      );
    }
  }

  // One resource is under repair, so it should not accept bookings.
  await client.query("UPDATE resources SET status = 'maintenance' WHERE code = 'WIND-01'");

  const today = istToday();
  const eligibleUser = (training) => {
    if (!training) return pick(["rohan", "meera", "aditya", "sara", "vikram"]);
    const map = {
      "Machine shop safety": ["rohan", "aditya"],
      "XRD operator certification": ["sara", "kavya"],
      "Confocal microscopy": ["meera", "sara"],
      "Biosafety level 1": ["meera"],
      "Laser cutter safety": ["aditya", "vikram"], // rohan's grant is expired
    };
    return pick(map[training] ?? ["rohan"]);
  };

  const purposes = [
    "Final-year project prototype",
    "Dissertation sample run",
    "Course assignment — ME402",
    "Sponsored research: composite curing study",
    "Hackathon build",
    "Pilot batch for DST proposal",
    "Student club workshop",
    "Failure analysis for industry consultancy",
  ];

  const bookingIds = [];
  const hourSlots = [9, 10, 11, 12, 14, 15, 16, 17];
  const slotHours = { "CNC-01": 3, "3DP-01": 5, "XRD-01": 2, "CLSM-01": 2, "HPLC-01": 3,
    "AUTOCLAVE-01": 1, "PCB-01": 3, "LASER-01": 2, "GPU-01": 6, "WIND-01": 3 };

  for (let offset = -84; offset <= 16; offset++) {
    const day = addDays(today, offset);
    if (weekdayOf(day) === 0) continue;
    const isPast = offset < 0;

    for (const def of resourceDefs) {
      if (def.code === "WIND-01") continue; // down for repair
      // Keep the forward schedule sparse so members stay inside the 3-booking quota
      // and the approvals queue is a believable size.
      if (offset >= 0 && random() > 0.08) continue;
      const r = resources[def.code];
      const perDay = 1 + Math.floor(random() * 3);
      const usedIntervals = [];

      for (let n = 0; n < perDay; n++) {
        const startHour = pick(hourSlots);
        const duration = slotHours[def.code] ?? 2;
        if (startHour + duration > 18) continue;
        if (usedIntervals.some(([start, end]) => startHour < end && startHour + duration > start)) continue;
        usedIntervals.push([startHour, startHour + duration]);
        // weekends are quiet
        if (weekdayOf(day) === 6 && random() < 0.55) continue;

        const startsAt = at(day, startHour);
        const endsAt = at(day, startHour + duration);
        const slug = eligibleUser(def.training);
        let status;
        if (isPast) {
          const roll = random();
          if (roll < 0.08) status = "no_show";
          else if (roll < 0.14) status = "cancelled";
          else if (roll < 0.2) status = "rejected";
          else status = "completed";
        } else if (def.approval && random() < 0.55) {
          status = "requested";
        } else {
          status = "confirmed";
        }

        const created = new Date(startsAt);
        created.setUTCDate(created.getUTCDate() - (2 + Math.floor(random() * 10)));

        const booking = await client.query(
          `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status,
             purpose, attendees, created_at, decided_by, decided_at, decision_note,
             cancelled_by, cancelled_at, cancel_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [
            org, r.id, users[slug], startsAt, endsAt, status,
            pick(purposes), 1 + Math.floor(random() * 4), created,
            status === "requested" ? null : users.arun,
            status === "requested" ? null : new Date(created.getTime() + 3600_000),
            status === "rejected" ? "Equipment already committed to a sponsored project." : null,
            status === "cancelled" ? users[slug] : null,
            status === "cancelled" ? new Date(created.getTime() + 7200_000) : null,
            status === "cancelled" ? "Schedule changed" : null,
          ],
        );
        const bookingId = booking.rows[0].id;
        bookingIds.push(bookingId);

        if (status === "completed") {
          const checkedIn = new Date(startsAt.getTime() + Math.floor(random() * 8) * 60_000);
          const checkedOut = new Date(endsAt.getTime() - Math.floor(random() * 25) * 60_000);
          await client.query(
            `INSERT INTO usage_sessions (organization_id, booking_id, started_at, ended_at, condition_note, consumables)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [org, bookingId, checkedIn, checkedOut,
              random() < 0.12 ? "Minor wear noted; reported to technician." : "Returned clean and in working order.",
              def.code === "3DP-01" ? "PLA stock used: 120 g" : ""],
          );

          await client.query(
            `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, created_at)
             VALUES ($1,$2,'booking.checked_out','booking',$3,$4,$5)`,
            [org, users[slug], bookingId, `${def.code} session closed by user`, checkedOut],
          );
        }

        await client.query(
          `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, summary, created_at)
           VALUES ($1,$2,$3,'booking',$4,$5,$6)`,
          [org, users[slug], status === "requested" ? "booking.requested" : "booking.created",
            bookingId, `${def.code} ${status}`, created],
        );
      }
    }
  }

  // Maintenance history + a near-future block.
  const maintenance = [
    ["WIND-01", "Fan bearing replacement", "Bearing noise above 30 m/s. Replacement scheduled with OEM.", "in_progress", -3, -1],
    ["CNC-01", "Spindle alignment", "Quarterly alignment and way lubrication.", "resolved", -40, -39],
    ["CLSM-01", "Laser tube service", "488 nm line power dropped 18%. Tube replaced.", "resolved", -25, -24],
    ["XRD-01", "Detector calibration", "Annual calibration against silicon standard.", "scheduled", 7, 8],
  ];
  for (const [code, title, description, status, startOffset, endOffset] of maintenance) {
    const m = await client.query(
      `INSERT INTO maintenance_records (organization_id, resource_id, title, description, status,
         scheduled_start, scheduled_end, resolved_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [org, resources[code].id, title, description, status,
        at(addDays(today, startOffset), 9), at(addDays(today, endOffset), 17),
        status === "resolved" ? at(addDays(today, endOffset), 17) : null, users.kavya],
    );
    await client.query(
      `INSERT INTO blackout_periods (organization_id, resource_id, maintenance_id, starts_at, ends_at, reason, kind, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'maintenance',$7)`,
      [org, resources[code].id, m.rows[0].id,
        at(addDays(today, startOffset), 9), at(addDays(today, endOffset), 17),
        title, users.kavya],
    );
  }
  // Wind tunnel is blocked for the whole repair window.
  await client.query("UPDATE resources SET status = 'maintenance' WHERE code = 'WIND-01'");

  const incidentDefs = [
    ["CNC-01", "rohan", "high", "open", "Coolant leak near control cabinet",
      "Coolant pooling under the machine after the 14:00 slot. Area cordoned off; maintenance notified.", -2],
    ["CLSM-01", "meera", "medium", "resolved", "Stage drift during z-stack",
      "Focus drifted mid-acquisition on a live sample.", -9,
      "Stage recalibrated and acquisition repeated; no charge applied."],
    ["LASER-01", "vikram", "low", "investigating", "Acrylic residue on bed",
      "Previous user cut without protective backing; bed needed cleaning before the next job.", -1],
  ];
  for (const [code, slug, severity, status, title, description, daysAgo, resolution] of incidentDefs) {
    await client.query(
      `INSERT INTO incidents (organization_id, resource_id, reported_by, severity, status, title,
         description, resolution, resolved_by, resolved_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [org, resources[code].id, users[slug], severity, status, title, description,
        resolution ?? null, resolution ? users.arun : null,
        resolution ? at(addDays(today, daysAgo + 1), 11) : null, at(addDays(today, daysAgo), 13)],
    );
  }

  // Unmet demand: rejected requests, conflicts and training gaps.
  const unmetReasons = ["approval_rejected", "conflict", "no_training", "quota", "blackout"];
  for (let i = 0; i < 26; i++) {
    const code = pick(Object.keys(resources).filter((c) => c !== "WIND-01"));
    const day = addDays(today, -Math.floor(random() * 60));
    const hour = pick(hourSlots);
    await client.query(
      `INSERT INTO unmet_demand_events (organization_id, resource_id, user_id, starts_at, ends_at, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [org, resources[code].id, users[pick(["rohan", "meera", "aditya", "sara", "vikram"])],
        at(day, hour), at(day, hour + 2), pick(unmetReasons), at(day, 10)],
    );
  }

  const notifications = [
    ["arun", "3 bookings awaiting approval", "Requests for CNC-01, XRD-01 and CLSM-01 need a decision before tomorrow.", "/approvals"],
    ["rohan", "CNC-01 booking confirmed", "Your slot is confirmed. Bring CAM files on a USB drive.", "/bookings"],
    ["kavya", "Incident assigned: coolant leak", "CNC-01 is cordoned off. Please inspect before releasing the resource.", "/operations"],
    ["aditya", "Laser safety certification expiring", "Your certification expires in 21 days. Book a refresher with the workshop.", "/dashboard"],
  ];
  for (const [slug, title, body, link] of notifications) {
    await client.query(
      `INSERT INTO notifications (organization_id, user_id, title, body, link, created_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours')`,
      [org, users[slug], title, body, link],
    );
  }

  await client.query("COMMIT");
  console.log("Seeded demo tenant: Meridian Institute of Technology");
  console.log(`Users: ${people.map((p) => p[1]).join(", ")}`);
  console.log(`Password for every demo account: ${DEMO_PASSWORD}`);
  console.log(`Resources: ${resourceDefs.length}, bookings: ${bookingIds.length}`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Seed failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
