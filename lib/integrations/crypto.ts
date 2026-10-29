import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ConnectorCredentials } from "./types";

// Provider credentials never leave the server. They are sealed with AES-256-GCM
// using INTEGRATION_ENCRYPTION_KEY (32 bytes, hex or base64) and stored as
// `v1:<iv>:<authTag>:<ciphertext>`. No UI query selects the ciphertext, and no
// code path logs it.

const PREFIX = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialEncryptionError";
  }
}

export function encryptionKey(raw = process.env.INTEGRATION_ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new CredentialEncryptionError(
      "INTEGRATION_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` before storing provider credentials.",
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new CredentialEncryptionError("INTEGRATION_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).");
  }
  return key;
}

export function encryptCredentials(credentials: ConnectorCredentials, key = encryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptCredentials(sealed: string | null, key = encryptionKey()): ConnectorCredentials | null {
  if (!sealed) return null;
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new CredentialEncryptionError("Stored credentials are not in the expected sealed format.");
  }
  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64");
  const tag = Buffer.from(tagPart, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialEncryptionError("Stored credentials are malformed.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CredentialEncryptionError("Stored credentials are not a key/value object.");
    }
    const result: ConnectorCredentials = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new CredentialEncryptionError("Stored credentials contain a non-string value.");
      }
      result[name] = value;
    }
    return result;
  } catch (error) {
    if (error instanceof CredentialEncryptionError) throw error;
    throw new CredentialEncryptionError("Stored credentials could not be decrypted (wrong key or tampered payload).");
  }
}

/** Shape check for operator-supplied credentials before encryption. */
export function assertCredentialObject(value: unknown): ConnectorCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialEncryptionError("Credentials must be a JSON object of string values.");
  }
  const result: ConnectorCredentials = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new CredentialEncryptionError(`Credential "${name}" must be a string.`);
    }
    result[name] = entry;
  }
  if (Object.keys(result).length === 0) {
    throw new CredentialEncryptionError("Credentials object is empty.");
  }
  return result;
}
