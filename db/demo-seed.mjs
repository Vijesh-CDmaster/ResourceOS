// Synthetic demo tenant for the capital-decision workflow.
//
// This module only INSERTs. It never truncates, updates or deletes anything, and
// it refuses to run if the demo organisation already exists. The CLI wrapper
// (db/seed-demo.mjs) adds the database-name and confirmation guards.
//
// The data is deliberately varied so the dashboard has real evidence to show:
// high-demand assets, under-used assets, recurring faults, machines beyond their
// expected life, and assets with unmet demand from other departments.

import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const DEMO_ORG_SLUG = "demo-university";
export const DEMO_ORG_NAME = "Northfield Institute of Technology (demo)";
export const DEMO_PASSWORD = "demo1234";

const WINDOW_DAYS = 180;

const DEPARTMENTS = [
  "Mechanical Engineering",
  "Materials Science",
  "Biosciences",
  "Electronics",
  "Design & Prototyping",
];

const FACILITIES = [
  { name: "Central Instrumentation Lab", location: "Block C, Level 2" },
  { name: "Fabrication Workshop", location: "Block F, Ground floor" },
  { name: "Bio Resource Centre", location: "Block B, Level 1" },
  { name: "Design Studio", location: "Block D, Level 3" },
];

const PEOPLE = [
  { name: "Nandita Rao", email: "nandita.rao@northfield.demo", role: "admin", dept: "Materials Science" },
  { name: "Ishaan Mehta", email: "ishaan.mehta@northfield.demo", role: "manager", dept: "Mechanical Engineering" },
  { name: "Fatima Sheikh", email: "fatima.sheikh@northfield.demo", role: "manager", dept: "Biosciences" },
  { name: "Gaurav Patil", email: "gaurav.patil@northfield.demo", role: "technician", dept: "Electronics" },
  { name: "Aditi Krishnan", email: "aditi.krishnan@northfield.demo", role: "member", dept: "Mechanical Engineering" },
  { name: "Rahul Bansal", email: "rahul.bansal@northfield.demo", role: "member", dept: "Materials Science" },
  { name: "Sneha Iyer", email: "sneha.iyer@northfield.demo", role: "member", dept: "Biosciences" },
  { name: "Vikram Sethi", email: "vikram.sethi@northfield.demo", role: "member", dept: "Electronics" },
  { name: "Meera Joshi", email: "meera.joshi@northfield.demo", role: "member", dept: "Design & Prototyping" },
  { name: "Arjun Nair", email: "arjun.nair@northfield.demo", role: "member", dept: "Materials Science" },
];

/**
 * demand: booking cadence. >=0.7 books every operating day (long sessions),
 * >=0.4 every second day, otherwise roughly weekly.
 * unmetFromOthers: requests other departments could not satisfy (sharing signal).
 * faults: maintenance events across the window.
 */
const ASSETS = [
  {
    code: "XRD-01",
    name: "X-Ray Diffractometer",
    category: "Materials Analysis",
    dept: "Materials Science",
    facility: "Central Instrumentation Lab",
    cost: 8_200_000,
    replacement: null,
    acquired: "2019-02-14",
    life: 12,
    condition: "fair",
    demand: 0.8,
    faults: 3,
    unmetFromOthers: 2,
    status: "ready",
  },
  {
    code: "SEM-01",
    name: "Scanning Electron Microscope",
    category: "Materials Analysis",
    dept: "Materials Science",
    facility: "Central Instrumentation Lab",
    cost: 14_500_000,
    replacement: 17_800_000,
    acquired: "2017-07-01",
    life: 8,
    condition: "good",
    demand: 0.95,
    faults: 5,
    unmetFromOthers: 5,
    status: "ready",
    // Two long sessions every working day: the capacity-constrained instrument.
    intensive: true,
    // Failures take longer to resolve: parts are imported and lead times are long.
    downtimeScale: 2.5,
  },
  {
    code: "CONF-01",
    name: "Confocal Microscope",
    category: "Imaging",
    dept: "Biosciences",
    facility: "Bio Resource Centre",
    cost: 11_000_000,
    replacement: null,
    acquired: "2020-11-20",
    life: 12,
    condition: "excellent",
    demand: 0.12,
    faults: 1,
    unmetFromOthers: 6,
    status: "ready",
  },
  {
    code: "HPLC-01",
    name: "HPLC System",
    category: "Analytical Chemistry",
    dept: "Biosciences",
    facility: "Bio Resource Centre",
    cost: 1_850_000,
    replacement: null,
    acquired: "2018-03-05",
    life: 10,
    condition: "good",
    demand: 0.7,
    faults: 2,
    unmetFromOthers: 1,
    status: "ready",
  },
  {
    code: "AUTOCLAVE-01",
    name: "Laboratory Autoclave",
    category: "Lab Services",
    dept: "Biosciences",
    facility: "Bio Resource Centre",
    cost: 980_000,
    replacement: 1_350_000,
    acquired: "2015-01-19",
    life: 12,
    condition: "poor",
    demand: 0.1,
    faults: 6,
    unmetFromOthers: 0,
    status: "maintenance",
  },
  {
    code: "CNC-01",
    name: "CNC Milling Machine",
    category: "Machining",
    dept: "Mechanical Engineering",
    facility: "Fabrication Workshop",
    cost: 3_200_000,
    replacement: 4_600_000,
    acquired: "2016-05-30",
    life: 10,
    condition: "fair",
    demand: 0.9,
    faults: 5,
    unmetFromOthers: 3,
    status: "ready",
  },
  {
    code: "LATHE-01",
    name: "Precision Lathe",
    category: "Machining",
    dept: "Mechanical Engineering",
    facility: "Fabrication Workshop",
    cost: 650_000,
    replacement: null,
    acquired: "2014-08-11",
    life: 15,
    condition: "fair",
    demand: 0.35,
    faults: 2,
    unmetFromOthers: 0,
    status: "ready",
  },
  {
    code: "FURNACE-01",
    name: "Tube Furnace",
    category: "Thermal Processing",
    dept: "Materials Science",
    facility: "Central Instrumentation Lab",
    cost: 760_000,
    replacement: 1_050_000,
    acquired: "2013-04-02",
    life: 12,
    condition: "poor",
    demand: 0.14,
    faults: 5,
    unmetFromOthers: 0,
    status: "ready",
  },
  {
    code: "3DP-01",
    name: "FDM 3D Printer",
    category: "Prototyping",
    dept: "Design & Prototyping",
    facility: "Design Studio",
    cost: 420_000,
    replacement: null,
    acquired: "2021-09-16",
    life: 6,
    condition: "good",
    demand: 0.85,
    faults: 2,
    unmetFromOthers: 4,
    status: "ready",
  },
  {
    code: "LASER-01",
    name: "CO2 Laser Cutter",
    category: "Prototyping",
    dept: "Design & Prototyping",
    facility: "Design Studio",
    cost: 1_200_000,
    replacement: 1_480_000,
    acquired: "2019-06-24",
    life: 8,
    condition: "fair",
    demand: 0.75,
    faults: 4,
    unmetFromOthers: 2,
    status: "ready",
  },
  {
    code: "SPECTRO-01",
    name: "UV-Vis Spectrophotometer",
    category: "Analytical Chemistry",
    dept: "Electronics",
    facility: "Central Instrumentation Lab",
    cost: 540_000,
    replacement: null,
    acquired: "2022-02-08",
    life: 10,
    condition: "excellent",
    demand: 0.1,
    faults: 0,
    unmetFromOthers: 5,
    status: "ready",
  },
  {
    code: "GPUSRV-01",
    name: "GPU Compute Server",
    category: "Computing",
    dept: "Electronics",
    facility: "Central Instrumentation Lab",
    cost: 2_200_000,
    replacement: 2_650_000,
    acquired: "2021-03-12",
    life: 5,
    condition: "good",
    demand: 0.9,
    faults: 1,
    unmetFromOthers: 3,
    status: "ready",
  },
];

const FAULT_CATEGORIES = [
  "Vacuum system",
  "Optics alignment",
  "Cooling",
  "Power supply",
  "Mechanical wear",
  "Software/controller",
  "Seals and gaskets",
];

const UNMET_REASONS = ["conflict", "blackout", "no_training", "quota"];

/** Deterministic PRNG so repeated demo builds produce comparable evidence. */
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function istDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function at(isoDate, hour, minute = 0) {
  return new Date(`${isoDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`);
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

export function demoTenantExists(client) {
  return client
    .query("SELECT 1 FROM organizations WHERE slug = $1", [DEMO_ORG_SLUG])
    .then((result) => result.rowCount > 0);
}

/**
 * Inserts the whole synthetic tenant in one transaction.
 * Throws if the demo tenant already exists — it never overwrites.
 */
export async function seedDemoTenant(client, { log = () => {}, now = new Date() } = {}) {
  if (await demoTenantExists(client)) {
    throw new Error(
      `The demo tenant "${DEMO_ORG_SLUG}" already exists in this database. This seeder never overwrites data; use a fresh demo database instead.`,
    );
  }

  const random = mulberry32(20261031);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await client.query("BEGIN");
  try {
    const org = (
      await client.query(
        `INSERT INTO organizations (name, slug, timezone, open_hour, close_hour,
           max_active_bookings, max_horizon_days, no_show_grace_minutes, is_demo)
         VALUES ($1, $2, 'Asia/Kolkata', 8, 18, 3, 30, 20, true)
         RETURNING id`,
        [DEMO_ORG_NAME, DEMO_ORG_SLUG],
      )
    ).rows[0].id;

    const departments = {};
    for (const name of DEPARTMENTS) {
      departments[name] = (
        await client.query("INSERT INTO departments (organization_id, name) VALUES ($1, $2) RETURNING id", [
          org,
          name,
        ])
      ).rows[0].id;
    }

    const facilities = {};
    for (const facility of FACILITIES) {
      facilities[facility.name] = (
        await client.query(
          "INSERT INTO facilities (organization_id, name, location) VALUES ($1, $2, $3) RETURNING id",
          [org, facility.name, facility.location],
        )
      ).rows[0].id;
    }

    const users = {};
    for (const person of PEOPLE) {
      const userId = (
        await client.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [
          person.email,
          person.name,
          passwordHash,
        ])
      ).rows[0].id;
      await client.query(
        "INSERT INTO memberships (organization_id, user_id, role, department_id) VALUES ($1, $2, $3, $4)",
        [org, userId, person.role, departments[person.dept]],
      );
      users[person.email] = { id: userId, ...person };
    }

    const membersByDept = new Map();
    for (const person of Object.values(users)) {
      if (!membersByDept.has(person.dept)) membersByDept.set(person.dept, []);
      membersByDept.get(person.dept).push(person);
    }

    const course = (
      await client.query(
        `INSERT INTO training_courses (organization_id, name, description, validity_months)
         VALUES ($1, 'Instrument safety induction', 'Synthetic demo certification.', 12) RETURNING id`,
        [org],
      )
    ).rows[0].id;

    const resources = [];
    for (const asset of ASSETS) {
      const warranty = asset.acquired
        ? shiftDays(new Date(`${asset.acquired}T00:00:00Z`), 365 * 3).toISOString().slice(0, 10)
        : null;
      const resourceId = (
        await client.query(
          `INSERT INTO resources (organization_id, facility_id, department_id, code, name, category,
             description, location, status, requires_approval, training_course_id, max_hours_per_booking, specs,
             acquired_at, acquisition_cost, replacement_cost, warranty_expires_at, expected_life_years,
             condition, is_demo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, true)
           RETURNING id`,
          [
            org,
            facilities[asset.facility],
            departments[asset.dept],
            asset.code,
            asset.name,
            asset.category,
            `${asset.name} operated by ${asset.dept}. Synthetic demo record for the capital decision workflow.`,
            FACILITIES.find((f) => f.name === asset.facility)?.location ?? "",
            asset.status,
            asset.demand >= 0.7,
            // Only the approval-gated, high-value instruments require training.
            asset.demand >= 0.7 ? course : null,
            asset.category === "Computing" ? 12 : 6,
            JSON.stringify({ Manufacturer: "Synthetic Instruments Ltd.", "Asset class": asset.category }),
            asset.acquired,
            asset.cost,
            asset.replacement,
            warranty,
            asset.life,
            asset.condition,
          ],
        )
      ).rows[0].id;
      resources.push({ id: resourceId, ...asset });
    }

    // Availability: Monday–Saturday, institute opening hours.
    for (const resource of resources) {
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        await client.query(
          `INSERT INTO availability_rules (organization_id, resource_id, weekday, opens_at, closes_at)
           VALUES ($1, $2, $3, '08:00', '18:00')`,
          [org, resource.id, weekday],
        );
      }
    }

    let bookings = 0;
    let sessions = 0;
    let unmet = 0;
    let maintenance = 0;

    for (const resource of resources) {
      const members = [...Object.values(users)].filter((person) => person.role === "member");
      const ownerMembers = membersByDept.get(resource.dept) ?? members;
      const otherMembers = members.filter((person) => person.dept !== resource.dept);

      // Cadence derived from the demand profile: daily for busy assets, about
      // weekly for idle ones. This is what makes utilisation differ per asset.
      const cadenceDays = resource.demand >= 0.7 ? 1 : resource.demand >= 0.4 ? 2 : 8;

      for (let dayOffset = WINDOW_DAYS; dayOffset >= 1; dayOffset -= 1) {
        if (dayOffset % cadenceDays !== 0) continue;
        const date = shiftDays(now, -dayOffset);
        if (date.getUTCDay() === 0) continue; // Sunday closed

        const isoDate = istDateKey(date);
        // Busy instruments run a long daily session; quiet ones get occasional
        // short bookings. The one "intensive" asset runs two sessions a day, so
        // the portfolio contains a genuinely capacity-constrained machine.
        const busy = resource.demand >= 0.7;
        const startHour = busy ? pick(random, [8, 9]) : 8 + Math.floor(random() * 5);
        const durationHours = busy ? pick(random, [7, 8]) : pick(random, [2, 3, 4]);
        if (startHour + durationHours > 18) continue;

        const plan = resource.intensive
          ? [
              { startHour: 8, durationHours: 4 },
              { startHour: 13, durationHours: 5 },
            ]
          : [{ startHour, durationHours }];
        const needsApproval = resource.demand >= 0.7;

        for (const slot of plan) {
          const startsAt = at(isoDate, slot.startHour);
          const endsAt = new Date(startsAt.getTime() + slot.durationHours * 3_600_000);

          const roll = random();
          let status = "completed";
          if (roll > 0.9) status = "cancelled";
          else if (roll > 0.82) status = "no_show";
          else if (roll > 0.79) status = "rejected";

          const booker = pick(random, ownerMembers);

          const bookingId = (
            await client.query(
              `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status,
                 purpose, attendees, decided_by, decided_at, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               RETURNING id`,
              [
                org,
                resource.id,
                booker.id,
                startsAt,
                endsAt,
                status,
                `${resource.category} session`,
                1 + Math.floor(random() * 2),
                needsApproval ? users["ishaan.mehta@northfield.demo"].id : null,
                needsApproval ? new Date(startsAt.getTime() - 86_400_000) : null,
                new Date(startsAt.getTime() - 2 * 86_400_000),
              ],
            )
          ).rows[0].id;
          bookings += 1;

          if (status === "completed" && random() > 0.1) {
            const actualMinutes = Math.round(slot.durationHours * 60 * (0.75 + random() * 0.3));
            await client.query(
              `INSERT INTO usage_sessions (organization_id, booking_id, started_at, ended_at, condition_note)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                org,
                bookingId,
                startsAt,
                new Date(startsAt.getTime() + actualMinutes * 60_000),
                random() > 0.85 ? "Minor wear noted" : "Completed normally",
              ],
            );
            sessions += 1;
          }
        }
      }

      // Upcoming confirmed sessions for busy assets.
      if (resource.demand >= 0.7) {
        for (let index = 1; index <= 2; index += 1) {
          const start = shiftDays(now, index * 3);
          const startsAt = at(istDateKey(start), 10 + index);
          await client.query(
            `INSERT INTO bookings (organization_id, resource_id, user_id, starts_at, ends_at, status, purpose, attendees)
             VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, 1)`,
            [
              org,
              resource.id,
              pick(random, ownerMembers).id,
              startsAt,
              new Date(startsAt.getTime() + 2 * 3_600_000),
              "Planned session",
            ],
          );
          bookings += 1;
        }
      }

      // Unmet demand from other departments, exactly as many as the profile says.
      for (let index = 0; index < resource.unmetFromOthers && otherMembers.length > 0; index += 1) {
        const demander = pick(random, otherMembers);
        const attempted = shiftDays(now, -Math.floor(random() * (WINDOW_DAYS - 3)) - 1);
        const startsAt = at(istDateKey(attempted), 9 + Math.floor(random() * 6));
        await client.query(
          `INSERT INTO unmet_demand_events (organization_id, resource_id, user_id, starts_at, ends_at, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            org,
            resource.id,
            demander.id,
            startsAt,
            new Date(startsAt.getTime() + 2 * 3_600_000),
            pick(random, UNMET_REASONS),
            new Date(startsAt.getTime() - 3_600_000),
          ],
        );
        unmet += 1;
      }

      // --- Maintenance history --------------------------------------------
      for (let index = 0; index < resource.faults; index += 1) {
        const occurred = shiftDays(now, -Math.floor(random() * (WINDOW_DAYS - 5)) - 5);
        const resolved = new Date(occurred.getTime() + 2 * 86_400_000);
        const cost = Math.round((30_000 + random() * (resource.cost * 0.02)) / 500) * 500;
        const downtime = Math.round((4 + random() * 40) * (resource.downtimeScale ?? 1) * 10) / 10;
        const fault = pick(random, FAULT_CATEGORIES);
        await client.query(
          `INSERT INTO maintenance_records (organization_id, resource_id, title, description, status,
             scheduled_start, scheduled_end, resolved_at, cost, downtime_hours, fault_category, created_by)
           VALUES ($1, $2, $3, $4, 'resolved', $5, $6, $7, $8, $9, $10, $11)`,
          [
            org,
            resource.id,
            `${fault} fault`,
            `Synthetic maintenance record. ${fault} investigated and repaired.`,
            occurred,
            resolved,
            resolved,
            cost,
            downtime,
            fault,
            users["gaurav.patil@northfield.demo"].id,
          ],
        );
        maintenance += 1;

        await client.query(
          `INSERT INTO blackout_periods (organization_id, resource_id, starts_at, ends_at, reason, kind)
           VALUES ($1, $2, $3, $4, $5, 'repair')`,
          [org, resource.id, occurred, resolved, `${fault} repair`],
        );
      }

      // One in-progress maintenance for the asset currently out of service.
      if (resource.status === "maintenance") {
        const start = shiftDays(now, -2);
        const end = shiftDays(now, 3);
        const recordId = (
          await client.query(
            `INSERT INTO maintenance_records (organization_id, resource_id, title, description, status,
               scheduled_start, scheduled_end, cost, downtime_hours, fault_category, created_by)
             VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7, $8, $9, $10) RETURNING id`,
            [
              org,
              resource.id,
              "Seal replacement and pressure test",
              "Synthetic in-progress maintenance record.",
              start,
              end,
              45_000,
              72,
              "Seals and gaskets",
              users["gaurav.patil@northfield.demo"].id,
            ],
          )
        ).rows[0].id;
        maintenance += 1;
        await client.query(
          `INSERT INTO blackout_periods (organization_id, resource_id, maintenance_id, starts_at, ends_at, reason, kind)
           VALUES ($1, $2, $3, $4, $5, 'Pressure test', 'maintenance')`,
          [org, resource.id, recordId, start, end],
        );
      }

      // --- Incidents -------------------------------------------------------
      if (resource.condition === "poor" || resource.faults >= 5) {
        await client.query(
          `INSERT INTO incidents (organization_id, resource_id, reported_by, severity, status, title, description, created_at)
           VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)`,
          [
            org,
            resource.id,
            pick(random, Object.values(users)).id,
            random() > 0.5 ? "high" : "medium",
            `Recurring fault reported on ${resource.name}`,
            "Synthetic incident record: the asset failed during a booked session and was reported by the user.",
            shiftDays(now, -Math.floor(random() * 30) - 1),
          ],
        );
      }
    }

    // Everyone in the demo holds a current induction so bookings can complete.
    for (const person of Object.values(users)) {
      await client.query(
        `INSERT INTO training_records (organization_id, user_id, course_id, granted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [org, person.id, course, users["nandita.rao@northfield.demo"].id, shiftDays(now, 180)],
      );
    }

    await client.query("COMMIT");

    const counts = {
      departments: DEPARTMENTS.length,
      facilities: FACILITIES.length,
      users: PEOPLE.length,
      resources: resources.length,
      bookings,
      sessions,
      unmet,
      maintenance,
    };
    log(`Seeded demo tenant "${DEMO_ORG_NAME}" (${org})`);
    log(
      `  ${counts.resources} assets · ${counts.bookings} bookings · ${counts.sessions} usage sessions · ${counts.maintenance} maintenance records · ${counts.unmet} unmet-demand events`,
    );
    return { organizationId: org, counts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
