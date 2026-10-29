# Integrations

ResourceOS can ingest resources and bookings from systems it does not own — an
external booking portal, a laboratory-management system, a finance/procurement
register or a maintenance/CMMS tool. The foundation is built; **no vendor
connector has been implemented or tested against a real provider yet.**

The design is a small connector contract plus one shared sync engine. Everything
that must behave identically for every provider — idempotency, provenance,
quarantine, checkpoints, retries, audit — lives in the engine, not in the
connector.

```
connection row ──► connector.pull(cursor) ──► connector.map(record)
                                                   │
                                          engine: ingest / quarantine
                                                   │
                        resources · bookings · integration_entity_map
```

## Data model

| Table / column | Purpose |
|---|---|
| `integration_connections` | One row per tenant-owned connection: `provider`, `name`, non-secret `config` (jsonb), sealed `credentials_ciphertext`, opaque `checkpoint`, `status` (`active`/`revoked`). |
| `integration_entity_map` | `(connection_id, entity_type, external_id)` → `internal_id`. The idempotency key: one external record maps to at most one local row. |
| `integration_sync_runs` | One row per run: mode, status, cursor before/after, counts (`imported`, `updated`, `duplicates`, `quarantined`, `failed`), error, actor and timings. |
| `integration_quarantine` | Records that could not be ingested: `validation`, `conflict` or `error`, with message, payload, attempt count and resolution. Unique per `(connection, entity, external id, reason)`, so retries bump `attempts` instead of piling up rows. |
| `resources.source_connection_id` + `source_external_id` | Provenance on imported assets (unique when present). |
| `bookings.source_connection_id` + `source_external_id` | Provenance on imported events (unique when present). |

All four integration tables carry the same `tenant_isolation` RLS policy as the
rest of the schema (`organization_id = app.current_organization_id`), enabled in
[db/migrations/0001_integrations.sql](../db/migrations/0001_integrations.sql).
The policy loop in `db/schema.sql` only covers its own baseline tables, which is
why the migration re-declares it.

## Connector interface

Full types: [lib/integrations/types.ts](../lib/integrations/types.ts).

```ts
export interface Connector {
  readonly id: string;            // stored in integration_connections.provider
  readonly label: string;
  readonly description: string;
  readonly entities: IntegrationEntity[];          // "resource" | "booking"
  readonly configFields: ConfigField[];            // non-secret settings
  readonly credentialFields: ConfigField[];        // secrets, encrypted at rest
  authorize?(ctx: ConnectorContext): Promise<AuthorizeResult>;
  pull(ctx: ConnectorContext, cursor: string | null): Promise<PullResult>;
  map(record: RawRecord, ctx: ConnectorContext): MapResult;
}
```

Contract rules:

- `pull` returns one page of `RawRecord`s plus `nextCursor`/`hasMore`. It must be
  safe to call with `null` (start of feed). Throw `ConnectorError(message,
  retryable)` for transport failures; the engine retries with linear backoff.
- `map` must be pure: validate and normalise, never write. Return
  `{ ok: false, issues }` for anything the operator can fix in the source system.
- `externalId` is the idempotency key. It must be stable across pulls; changing
  it creates a new record.
- `ctx.credentials` is already decrypted on the server. Never log it, never put
  it in `config`, never return it to the browser.

## Registering a provider

```ts
// lib/integrations/connectors/acme.ts
import type { Connector } from "../types";

export const acmeConnector: Connector = {
  id: "acme-booking",
  label: "ACME Booking",
  description: "Pulls bookable instruments from ACME.",
  entities: ["resource"],
  configFields: [{ key: "endpoint", label: "Endpoint", required: true }],
  credentialFields: [{ key: "token", label: "API token", required: true }],
  async pull(ctx, cursor) { /* fetch one page */ },
  map(record) { /* validate + normalise */ },
};
```

```ts
// lib/integrations/registry.ts
import { acmeConnector } from "./connectors/acme";
registerConnector(acmeConnector);
```

That is the whole registration: no schema change, no new table, no engine change.
The connector then appears on `/integrations`.

## Sync semantics

| Situation | Behaviour |
|---|---|
| New `externalId` | Inserted; `integration_entity_map` row created in the same transaction. |
| Resource already mapped | Field refresh in place (`updated`). A local `maintenance`/`suspended` hold is never overwritten by the source. |
| Booking already mapped | Counted as `duplicates` and left untouched — a booking is an event, not a projection. |
| Resource code used by a row not linked to this connection | Quarantined as `conflict`; a code is never silently stolen. |
| Missing/invalid fields | Quarantined as `validation` with field-level messages. |
| Unknown resource or non-member user on an imported booking | Quarantined as `conflict`/`validation`. A booking is never attributed to another institution's user. |
| Overlapping imported booking | The database exclusion constraint still wins; the loser is quarantined as `conflict`. |
| Two runs race on one record | A unique violation is reported as `duplicates`, not an error. |
| `pull` throws | Run marked `failed` with the error and an audit event; imported rows stay intact; retry with `mode=full` or `incremental`. |
| Source corrected | Re-sync closes the matching quarantine rows. |
| Connection revoked | New syncs are rejected (`connection_revoked`); revoking also deletes stored credentials and the checkpoint. Imported records and history remain. |
| Page cap reached with records still unread | Run is recorded as `partial` (never `succeeded`) with a note, and every ingested page is kept. Run it again to continue. |

Checkpoints are written after each page commits, so a crash mid-run resumes from
the last completed page. `maxPages` (default 20) bounds a single invocation.

### Page-capped (partial) runs

`maxPages` exists so one invocation cannot loop forever on a huge or misbehaving
source. When the cap is hit while the source still reports more records, the run
finishes as **`partial`**, not `succeeded`:

- the status column reads `partial`, `note` explains why, and the action surfaces
  it as an error flash (an incomplete import is never presented as success);
- the checkpoint from the last fully ingested page is preserved, so nothing is
  re-read and nothing is skipped;
- running again continues from that checkpoint. For **Re-sync (`mode=full`) this
  is automatic**: if the most recent run for the connection ended `partial`, the
  next full run continues from the checkpoint instead of restarting the feed —
  otherwise a large feed would re-walk the same pages and hit the cap forever;
- once the feed is exhausted the run is `succeeded`, and a later full run starts
  from the beginning again as usual.

Because records are matched by `(connection, entity, externalId)`, repeating
passes never duplicate rows. If repeated runs of the same connection keep ending
`partial`, raise `maxPages` or narrow the feed with the connector's cursor.

## Credentials

`credentials_ciphertext` holds `v1:<iv>:<tag>:<ciphertext>` sealed with
AES-256-GCM under `INTEGRATION_ENCRYPTION_KEY` (32 bytes, hex or base64):

```bash
openssl rand -hex 32
```

- The key is server-side only. No query in `lib/queries/integrations.ts` selects
  the ciphertext; the UI only sees a `hasCredentials` boolean.
- A secret pasted into the connection's non-secret `config` is rejected at the
  action boundary, so a token cannot be stored in plaintext by accident.
- Rotating the key makes existing payloads unreadable: recreate the connections.
- A wrong key or tampered payload raises `CredentialEncryptionError` instead of
  silently syncing without authentication.

## Permissions and audit

| Action | Role |
|---|---|
| Create connection (accepts secrets) | administrator |
| Revoke connection | administrator |
| Run sync / re-sync | administrator, facility manager |

Audit events (append-only, `audit_events`):

- `integration.connection_created`
- `integration.connection_revoked`
- `integration.sync_succeeded`
- `integration.sync_partial`
- `integration.sync_failed`

Credential values never appear in summaries or metadata; only `hasCredentials`,
provider, run id and counts.

## Tenant safety

- Every engine query runs through the injected `withTenant` runner, which is
  `withOrg(organizationId, …)`: `BEGIN` → `set_config('app.current_organization_id', …, true)` → work → `COMMIT`. The setting is transaction-local, so a pooled client cannot inherit the previous tenant.
- A connection id from another institution is simply "not found" (RLS), so the
  action does not confirm its existence.
- Imported resources/bookings are always written with the caller's
  `organization_id`; foreign rows are rejected by `WITH CHECK`.
- Cross-institution sharing is **not implemented**. There is no endpoint, table
  or flag that exposes resources or bookings from one institution to another.
  Do not add one without an explicit sharing grant table, tests for that grant,
  and a review of the liability and audit implications.

## Running a sync

From the UI (`/integrations`): **Sync** = incremental from the checkpoint;
**Re-sync** = from the start of the feed (used after correcting a quarantined
record).

From code:

```ts
import { runSync } from "@/lib/integrations/engine";
import { withOrg } from "@/lib/db";

await runSync({
  organizationId,
  connectionId,
  actorId: user.userId,
  connector,
  withTenant: (fn) => withOrg(organizationId, (db) => fn({ query: (t, p) => db.query(t, p) })),
  mode: "incremental",
  decryptCredentials: (sealed) => decryptCredentials(sealed),
});
```

There is deliberately no cron entry for syncs yet: an operator-triggered sync is
easier to explain to a facility manager than a silent background import, and the
engine is reusable from a worker when scheduled syncs are actually needed.

## Migrations

`db/schema.sql` is the frozen baseline. New work goes in
`db/migrations/NNNN_*.sql` and is recorded in `schema_migrations`:

```bash
npm run db:migrate   # baseline (empty DB only) + pending migrations + grants
```

`db/reset.mjs` now also re-applies migrations, and still refuses to run without
`ALLOW_DB_RESET=yes`. Nothing in this foundation drops or rewrites existing data.

## Demo seeding erases integration state

`npm run db:seed` is **destructive** and is only for a throwaway demo tenant. It
starts with:

```sql
TRUNCATE audit_events, notifications, ..., organizations RESTART IDENTITY CASCADE;
```

`organizations` is truncated `CASCADE`, and `integration_connections` has
`ON DELETE CASCADE` to it, so a reseed removes, for every institution:

- integration connections (and their encrypted credentials and checkpoints),
- external-id mappings (`integration_entity_map`),
- sync history (`integration_sync_runs`) and quarantine (`integration_quarantine`),
- the `source_connection_id` / `source_external_id` provenance on imported
  resources and bookings — those rows themselves are truncated with the demo
  data, so imports cannot be re-attributed afterwards,
- the audit trail, including `integration.*` events.

Consequences worth knowing before running it:

- Imported resources and bookings disappear like any other demo data. Re-running
a sync afterwards re-imports from the feed and starts a fresh mapping table.
- Anything that referenced an imported row by id (bookings, incident records,
saved links) is gone with it.
- The seed is not idempotent with respect to integrations: it does not preserve
  or recreate connections.

**When it is appropriate:** local development, demos, and CI-style fresh
environments, where the database holds nothing but generated data.

**Never run it** against a database that may contain real institutional data, a
pilot tenant, or imported records you still need — including a shared staging
database. There is no undo: the truncate is not reversible and the audit rows
that would document it are removed by the same statement.

How to avoid it:

- Keep `ADMIN_DATABASE_URL` pointed at a disposable database when you might run
  demo scripts, and use a separate database (with its own URL) for any data you
  care about.
- Prefer `npm run db:migrate` for schema work in shared environments. It is
  additive and never truncates.
- If you only need a richer demo, take a backup first (`pg_dump`) and restore it
  afterwards, rather than assuming the seed is harmless.

## Known gaps

- No vendor connector. Implementing one means reading that provider's documented
  API and testing against a real sandbox — do not claim support before that.
- Only `resource` and `booking` entities exist. Invoices, purchase orders and
  maintenance orders would each need a mapping table and a corresponding local
  record type.
- No scheduled sync, no per-record webhook ingestion, no delta-by-updated-since
  helper (connectors implement their own cursor).
- Quarantine resolution is implicit (a successful re-sync closes the row). There
  is no "discard permanently" action, and no bulk edit of held payloads.
- No credential rotation UI; rotate by recreating the connection.
- Page-capped runs must be resumed manually (run again). There is no scheduled
  continuation and no automatic retry loop for `partial` runs.
