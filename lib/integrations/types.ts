// Connector contract for external booking, LIMS, finance and maintenance systems.
//
// A connector is deliberately small and transport-agnostic: it pulls raw records
// and maps one record to a validated payload. Idempotency, provenance, retries,
// quarantine, checkpoints and audit are handled by lib/integrations/engine.ts so
// every provider behaves identically.

export type IntegrationEntity = "resource" | "booking";

export type ConnectorConfig = Record<string, unknown>;
export type ConnectorCredentials = Record<string, string>;

export type ConnectorContext = {
  organizationId: string;
  connectionId: string;
  /** Non-secret provider settings stored on the connection. */
  config: ConnectorConfig;
  /** Decrypted secrets, or null when the connection stores none. */
  credentials: ConnectorCredentials | null;
};

export type RawRecord = {
  entityType: IntegrationEntity;
  /** Stable identifier in the source system. The idempotency key. */
  externalId: string;
  payload: Record<string, unknown>;
};

export type PullResult = {
  records: RawRecord[];
  /** Opaque cursor for the next page. Persisted after the page is ingested. */
  nextCursor: string | null;
  hasMore: boolean;
};

export type FieldIssue = { field: string; message: string };

export type ResourceStatus = "ready" | "maintenance" | "suspended" | "retired";

export type ResourceInput = {
  code: string;
  name: string;
  category?: string;
  description?: string;
  location?: string;
  capacity?: number;
  status?: ResourceStatus;
  requiresApproval?: boolean;
  maxHours?: number;
};

export type BookingInput = {
  /** Preferred: the external id of the resource already imported by this connection. */
  resourceExternalId?: string;
  /** Fallback: the local resource code. */
  resourceCode?: string;
  userEmail: string;
  startsAt: string;
  endsAt: string;
  status?: "requested" | "confirmed";
  purpose?: string;
  attendees?: number;
};

export type MapResult =
  | { ok: true; entityType: "resource"; externalId: string; data: ResourceInput }
  | { ok: true; entityType: "booking"; externalId: string; data: BookingInput }
  | { ok: false; entityType: IntegrationEntity; externalId: string; issues: FieldIssue[] };

export type ConfigField = {
  key: string;
  label: string;
  required: boolean;
  help?: string;
};

export type AuthorizeResult = {
  accountLabel: string;
  expiresAt?: Date | null;
};

export interface Connector {
  /** Stable provider id stored on integration_connections.provider. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Entities this connector can ingest. */
  readonly entities: IntegrationEntity[];
  /** Non-secret settings the operator must supply, rendered by the UI/docs. */
  readonly configFields: ConfigField[];
  /** Secret settings. Values are encrypted at rest and never sent to the browser. */
  readonly credentialFields: ConfigField[];
  /** Optional credential/endpoint check run when a connection is created. */
  authorize?(context: ConnectorContext): Promise<AuthorizeResult>;
  /** Fetch one page of source records. Throw ConnectorError for retryable failures. */
  pull(context: ConnectorContext, cursor: string | null): Promise<PullResult>;
  /** Map and validate a single record. Never write to the database here. */
  map(record: RawRecord, context: ConnectorContext): MapResult;
}

export class ConnectorError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = retryable;
  }
}
