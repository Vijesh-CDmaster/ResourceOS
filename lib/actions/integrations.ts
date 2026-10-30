"use server";

import { revalidatePath } from "next/cache";
import { withOrg } from "../db";
import { requireUser } from "../auth";
import { canManage } from "../roles";
import { recordAudit } from "../audit";
import { fail, field, ok, optionalField, errorMessage } from "../action-utils";
import { getConnector, hasConnector } from "../integrations/registry";
import { runSync, type TenantRunner } from "../integrations/engine";
import { CredentialEncryptionError, decryptCredentials, encryptCredentials } from "../integrations/crypto";

const PATH = "/integrations";

function parseObject(raw: string, label: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Creates a tenant-scoped connection. Administrator-only because it accepts
 * provider secrets; those are sealed before they touch the database and are
 * never written to config, logs or the browser.
 */
export async function createConnectionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (user.role !== "admin") fail(PATH, "Only administrators can create integrations.");

  const provider = field(formData, "provider");
  const name = field(formData, "name");
  const configRaw = field(formData, "config");
  const credentialsRaw = optionalField(formData, "credentials");

  if (!hasConnector(provider)) fail(PATH, "Choose a registered provider.");
  if (!name || name.length > 80) fail(PATH, "Give the connection a name (max 80 characters).");

  try {
    const connector = getConnector(provider);
    const config = parseObject(configRaw, "Connection settings");

    // A secret pasted into settings would be stored in plaintext: refuse it.
    const secretKeys = new Set(connector.credentialFields.map((entry) => entry.key));
    const leaked = Object.keys(config).filter((key) => secretKeys.has(key));
    if (leaked.length) {
      throw new Error(`${leaked.join(", ")} must go in the credentials field, not the settings.`);
    }

    const credentials = credentialsRaw ? parseObject(credentialsRaw, "Credentials") : null;
    const sealed = credentials
      ? encryptCredentials(
          Object.fromEntries(
            Object.entries(credentials).map(([key, value]) => {
              if (typeof value !== "string") throw new Error(`Credential "${key}" must be a string.`);
              return [key, value];
            }),
          ),
        )
      : null;

    if (connector.credentialFields.some((entry) => entry.required) && !sealed) {
      throw new Error(`${connector.label} requires credentials.`);
    }

    for (const entry of connector.configFields) {
      if (!entry.required) continue;
      const value = config[entry.key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`${entry.label} is required.`);
      }
    }

    await withOrg(user.organizationId, async (db) => {
      const organization = await db.query<{ id: string }>(
        "SELECT id FROM organizations WHERE id = $1",
        [user.organizationId],
      );

      const connection = await db.query<{ id: string }>(
        `INSERT INTO integration_connections
           (organization_id, provider, name, config, credentials_ciphertext, credentials_rotated_at, created_by)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6)
         RETURNING id`,
        [
          user.organizationId,
          provider,
          name,
          JSON.stringify(config),
          sealed,
          user.userId,
        ],
      );
      const connectionId = connection.rows[0].id;

      if (connector.authorize && organization.rows[0]) {
        const result = await connector.authorize({
          organizationId: user.organizationId,
          connectionId,
          config,
          credentials: credentials
            ? Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, String(value)]))
            : null,
        });
        await db.query(
          "UPDATE integration_connections SET config = config || $2::jsonb WHERE id = $1",
          [connectionId, JSON.stringify({ accountLabel: result.accountLabel })],
        );
      }

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "integration.connection_created",
        entityType: "integration_connection",
        entityId: connectionId,
        summary: `${user.name} connected ${connector.label} as "${name}"`,
        metadata: { provider, hasCredentials: Boolean(sealed) },
      });
    });
  } catch (error) {
    if (error instanceof CredentialEncryptionError) {
      fail(PATH, error.message);
    }
    fail(PATH, errorMessage(error, "Could not create the connection."));
  }

  revalidatePath(PATH);
  ok(PATH, `Connection "${name}" created.`);
}

/** Revoking keeps the record, mapping history and audit trail but blocks new syncs. */
export async function revokeConnectionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (user.role !== "admin") fail(PATH, "Only administrators can revoke integrations.");
  const connectionId = field(formData, "connection_id");
  if (!connectionId) fail(PATH, "Choose a connection.");

  try {
    await withOrg(user.organizationId, async (db) => {
      const updated = await db.query<{ name: string; provider: string }>(
        `UPDATE integration_connections
            SET status = 'revoked', revoked_at = now(), revoked_by = $2,
                credentials_ciphertext = NULL, credentials_rotated_at = NULL, checkpoint = NULL
          WHERE id = $1 AND status = 'active'
          RETURNING name, provider`,
        [connectionId, user.userId],
      );
      if (!updated.rows[0]) throw new Error("That connection is not active for this institution.");

      await recordAudit(db, {
        organizationId: user.organizationId,
        actorId: user.userId,
        action: "integration.connection_revoked",
        entityType: "integration_connection",
        entityId: connectionId,
        summary: `${user.name} revoked ${updated.rows[0].provider} connection "${updated.rows[0].name}"`,
        metadata: { provider: updated.rows[0].provider },
      });
    });
  } catch (error) {
    fail(PATH, errorMessage(error, "Could not revoke the connection."));
  }

  revalidatePath(PATH);
  ok(PATH, "Connection revoked. Stored credentials were deleted.");
}

/**
 * Runs one bounded sync page-set. `mode=full` re-reads the feed from the start
 * so quarantined records get a second chance; previously imported records are
 * matched by external id and never duplicated.
 */
export async function syncConnectionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!canManage(user.role)) fail(PATH, "Only administrators and facility managers can run a sync.");
  const connectionId = field(formData, "connection_id");
  const requested = field(formData, "mode");
  const mode = requested === "full" ? "full" : "incremental";
  if (!connectionId) fail(PATH, "Choose a connection.");

  const withTenant: TenantRunner = (fn) =>
    withOrg(user.organizationId, (db) =>
      fn({ query: (text: string, params?: unknown[]) => db.query(text, params) }),
    );

  let summary = "";
  let problem: string | null = null;

  try {
    // Resolution happens inside the tenant context, so a foreign id is simply
    // "not found" rather than an authorization error that confirms existence.
    const provider = await withOrg(user.organizationId, async (db) => {
      const found = await db.query<{ provider: string }>(
        "SELECT provider FROM integration_connections WHERE id = $1",
        [connectionId],
      );
      return found.rows[0]?.provider ?? null;
    });

    if (!provider) {
      problem = "That connection does not exist for this institution.";
    } else if (!hasConnector(provider)) {
      problem = `No connector is installed for "${provider}".`;
    } else {
      const result = await runSync({
        organizationId: user.organizationId,
        connectionId,
        actorId: user.userId,
        connector: getConnector(provider),
        withTenant,
        mode,
        decryptCredentials: (sealed) => {
          try {
            return decryptCredentials(sealed);
          } catch (error) {
            if (error instanceof CredentialEncryptionError) return null;
            throw error;
          }
        },
      });

      const headline =
        result.status === "succeeded"
          ? "Sync complete"
          : result.status === "partial"
            ? "Sync incomplete — page limit reached"
            : "Sync failed";
      summary = `${headline}: ${result.imported} imported, ${result.updated} updated, ${
        result.duplicates
      } duplicate(s), ${result.quarantined} quarantined, ${result.failed} failed.`;
      if (result.status === "partial" && result.note) summary = `${summary} ${result.note}`;
      // A partial run must never be reported to the operator as success.
      if (result.status !== "succeeded") problem = summary;
    }
  } catch (error) {
    problem = errorMessage(error, "The sync could not be started.");
  }

  // Redirects must not be raised inside the try: `redirect()` signals itself by
  // throwing NEXT_REDIRECT, which the catch above would turn into its own text.
  revalidatePath(PATH);
  revalidatePath("/resources");
  revalidatePath("/bookings");
  if (problem) fail(PATH, problem);
  ok(PATH, summary);
}
