import {
  ConnectorError,
  type Connector,
  type FieldIssue,
  type MapResult,
  type RawRecord,
  type ResourceStatus,
} from "../types";

// Reference connector.
//
// This is NOT a vendor integration. It reads a deterministic JSON feed stored in
// the connection's non-secret config and exists so a facility can see the full
// pipeline (pull → map → validate → ingest → quarantine) before a real provider
// is implemented. A real connector implements the same interface.

const ENTITY_TYPES = ["resource", "booking"] as const;
const RESOURCE_STATUSES: ResourceStatus[] = ["ready", "maintenance", "suspended", "retired"];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "yes" || value === 1;
}

function toRawRecord(entry: unknown, index: number): RawRecord {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { entityType: "resource", externalId: `invalid-row-${index}`, payload: { value: entry } };
  }
  const record = entry as Record<string, unknown>;
  const entityType = ENTITY_TYPES.includes(record.entityType as (typeof ENTITY_TYPES)[number])
    ? (record.entityType as RawRecord["entityType"])
    : "resource";
  const externalId = text(record.externalId) || `invalid-row-${index}`;
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  return { entityType, externalId, payload };
}

export const referenceConnector: Connector = {
  id: "reference-feed",
  label: "Reference JSON feed",
  description:
    "Deterministic local feed for onboarding and pipeline testing. Holds records in the connection settings; no network calls.",
  entities: ["resource", "booking"],
  configFields: [
    {
      key: "records",
      label: "Records",
      required: true,
      help: 'JSON array of { "entityType": "resource" | "booking", "externalId": "...", "payload": { ... } }',
    },
    { key: "pageSize", label: "Page size", required: false, help: "Defaults to 50, maximum 500." },
  ],
  credentialFields: [
    {
      key: "apiKey",
      label: "API key",
      required: false,
      help: "Stored encrypted with the server key. The reference feed does not send it anywhere.",
    },
  ],

  async authorize(context) {
    const records = Array.isArray(context.config.records) ? context.config.records : [];
    return {
      accountLabel: `Reference feed · ${records.length} record(s)`,
      expiresAt: null,
    };
  },

  async pull(context, cursor) {
    const all = Array.isArray(context.config.records) ? context.config.records : [];
    const pageSize = Math.min(500, Math.max(1, Math.trunc(optionalNumber(context.config.pageSize) ?? 50)));
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new ConnectorError(`Invalid cursor "${cursor}".`, false);
    }
    const slice = all.slice(offset, offset + pageSize);
    const nextOffset = offset + slice.length;
    return {
      records: slice.map((entry, index) => toRawRecord(entry, offset + index)),
      nextCursor: String(nextOffset),
      hasMore: nextOffset < all.length,
    };
  },

  map(record): MapResult {
    const issues: FieldIssue[] = [];

    if (record.entityType === "resource") {
      const code = text(record.payload.code);
      const name = text(record.payload.name);
      const status = text(record.payload.status);
      const capacity = optionalNumber(record.payload.capacity);
      const maxHours = optionalNumber(record.payload.maxHours);

      if (!code) issues.push({ field: "code", message: "is required" });
      if (!name) issues.push({ field: "name", message: "is required" });
      if (status && !RESOURCE_STATUSES.includes(status as ResourceStatus)) {
        issues.push({ field: "status", message: `must be one of ${RESOURCE_STATUSES.join(", ")}` });
      }
      if (record.payload.capacity !== undefined && capacity === undefined) {
        issues.push({ field: "capacity", message: "must be a number" });
      }
      if (record.payload.maxHours !== undefined && maxHours === undefined) {
        issues.push({ field: "maxHours", message: "must be a number" });
      }

      if (issues.length) return { ok: false, entityType: "resource", externalId: record.externalId, issues };

      return {
        ok: true,
        entityType: "resource",
        externalId: record.externalId,
        data: {
          code,
          name,
          category: text(record.payload.category) || undefined,
          description: text(record.payload.description) || undefined,
          location: text(record.payload.location) || undefined,
          capacity,
          maxHours,
          status: (status as ResourceStatus) || undefined,
          requiresApproval: record.payload.requiresApproval === undefined ? undefined : truthy(record.payload.requiresApproval),
        },
      };
    }

    const startsAt = text(record.payload.startsAt);
    const endsAt = text(record.payload.endsAt);
    const userEmail = text(record.payload.userEmail);
    const resourceExternalId = text(record.payload.resourceExternalId);
    const resourceCode = text(record.payload.resourceCode);
    const status = text(record.payload.status) || "confirmed";

    if (!startsAt) issues.push({ field: "startsAt", message: "is required (ISO 8601)" });
    if (!endsAt) issues.push({ field: "endsAt", message: "is required (ISO 8601)" });
    if (!userEmail) issues.push({ field: "userEmail", message: "is required" });
    if (!resourceExternalId && !resourceCode) {
      issues.push({ field: "resourceExternalId", message: "or resourceCode is required" });
    }
    if (status !== "requested" && status !== "confirmed") {
      issues.push({ field: "status", message: "must be requested or confirmed" });
    }
    if (startsAt && Number.isNaN(new Date(startsAt).getTime())) {
      issues.push({ field: "startsAt", message: "is not a valid timestamp" });
    }
    if (endsAt && Number.isNaN(new Date(endsAt).getTime())) {
      issues.push({ field: "endsAt", message: "is not a valid timestamp" });
    }

    if (issues.length) return { ok: false, entityType: "booking", externalId: record.externalId, issues };

    return {
      ok: true,
      entityType: "booking",
      externalId: record.externalId,
      data: {
        resourceExternalId: resourceExternalId || undefined,
        resourceCode: resourceCode || undefined,
        userEmail,
        startsAt,
        endsAt,
        status: status as "requested" | "confirmed",
        purpose: text(record.payload.purpose) || undefined,
        attendees: optionalNumber(record.payload.attendees),
      },
    };
  },
};
