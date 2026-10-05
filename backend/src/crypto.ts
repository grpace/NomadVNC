import crypto from "node:crypto";
import type { DbClient } from "./db.js";

/**
 * Server-managed credential envelope (v1, disclosed not E2E).
 * AES-256-GCM per credential: random 96-bit nonce, AAD binding
 * (device, owner, key id) so ciphertext can't be transplanted.
 */

export interface DataKey {
  id: string;
  key: Buffer;
}

export interface CredentialEnvelope {
  keyId: string;
  nonce: string;
  ciphertext: string;
}

/** Accepts 64 hex chars or base64 for 32 bytes; throws otherwise. */
export function parseDataKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (hex.length !== 32) {
    throw new Error("DATA_KEY must decode to 32 bytes (64 hex chars or base64)");
  }
  return hex;
}

export function fingerprintKey(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function aad(deviceId: string, ownerId: string, keyId: string): Buffer {
  return Buffer.from(`v1|device:${deviceId}|owner:${ownerId}|key:${keyId}`, "utf8");
}

function shareAad(shareId: string, deviceId: string, keyId: string): Buffer {
  return Buffer.from(`v1|share:${shareId}|device:${deviceId}|key:${keyId}`, "utf8");
}

export function encryptCredential(
  key: DataKey,
  deviceId: string,
  ownerId: string,
  password: string,
): CredentialEnvelope {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(aad(deviceId, ownerId, key.id));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyId: key.id,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([tag, ciphertext]).toString("base64"),
  };
}

/** Tries the recorded key first, then every other loaded key (rotation). */
export function decryptCredential(
  keys: DataKey[],
  deviceId: string,
  ownerId: string,
  envelope: CredentialEnvelope,
): string {
  const ordered = [
    ...keys.filter((k) => k.id === envelope.keyId),
    ...keys.filter((k) => k.id !== envelope.keyId),
  ];
  const raw = Buffer.from(envelope.ciphertext, "base64");
  const nonce = Buffer.from(envelope.nonce, "base64");
  if (raw.length < 17 || nonce.length !== 12) {
    throw new Error("Malformed credential envelope");
  }
  const tag = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  for (const key of ordered) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key.key, nonce);
      decipher.setAAD(aad(deviceId, ownerId, key.id));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      continue;
    }
  }
  throw new Error("Credential cannot be decrypted with any loaded key");
}

/**
 * Tailnet-auth-key envelope for shares (H3). Same AES-256-GCM construction
 * as device credentials, but the AAD binds (share, device, key) so a sealed
 * key cannot be transplanted onto another grant. The server stores the key
 * opaquely — it never validates it against Tailscale.
 */
export function encryptShareKey(
  key: DataKey,
  shareId: string,
  deviceId: string,
  tailnetAuthKey: string,
): CredentialEnvelope {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(shareAad(shareId, deviceId, key.id));
  const ciphertext = Buffer.concat([cipher.update(tailnetAuthKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyId: key.id,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([tag, ciphertext]).toString("base64"),
  };
}

/** Tries the recorded key first, then every other loaded key (rotation). */
export function decryptShareKey(
  keys: DataKey[],
  shareId: string,
  deviceId: string,
  envelope: CredentialEnvelope,
): string {
  const ordered = [
    ...keys.filter((k) => k.id === envelope.keyId),
    ...keys.filter((k) => k.id !== envelope.keyId),
  ];
  const raw = Buffer.from(envelope.ciphertext, "base64");
  const nonce = Buffer.from(envelope.nonce, "base64");
  if (raw.length < 17 || nonce.length !== 12) {
    throw new Error("Malformed share-key envelope");
  }
  const tag = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  for (const key of ordered) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key.key, nonce);
      decipher.setAAD(shareAad(shareId, deviceId, key.id));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      continue;
    }
  }
  throw new Error("Share key cannot be decrypted with any loaded key");
}

/**
 * Parses the env keys and records their fingerprints in `data_keys`
 * (operator visibility only — key material never touches the database).
 * `rawKeys` order: oldest first, newest (active) last. Re-encrypting rows
 * still sealed under retired keys is `reencryptStaleCredentials`.
 */
export async function ensureDataKeys(db: DbClient, rawKeys: string[]): Promise<DataKey[]> {
  const keys: DataKey[] = rawKeys.map((raw) => {
    const key = parseDataKey(raw);
    return { id: fingerprintKey(key), key };
  });
  // Exactly one active key: retired keys no longer in the env go inactive.
  await db.query("UPDATE data_keys SET active = false WHERE active");
  for (const [index, key] of keys.entries()) {
    await db.query(
      `INSERT INTO data_keys (id, active) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET active = EXCLUDED.active`,
      [key.id, index === keys.length - 1],
    );
  }
  return keys;
}

export async function reencryptStaleCredentials(db: DbClient, keys: DataKey[]): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  const active = keys[keys.length - 1] as DataKey;
  let moved = 0;
  const rows = await db.query<{
    device_id: string;
    owner_id: string;
    key_id: string;
    nonce: Buffer;
    ciphertext: Buffer;
  }>(
    `SELECT d.id AS device_id, d.owner_id, c.key_id AS key_id, c.nonce, c.ciphertext
     FROM device_credentials c JOIN devices d ON d.id = c.device_id
     WHERE c.key_id <> $1`,
    [active.id],
  );
  for (const row of rows.rows) {
    const envelope: CredentialEnvelope = {
      keyId: row.key_id,
      nonce: (row.nonce as Buffer).toString("base64"),
      ciphertext: (row.ciphertext as Buffer).toString("base64"),
    };
    const password = decryptCredential(keys, row.device_id, row.owner_id, envelope);
    const fresh = encryptCredential(active, row.device_id, row.owner_id, password);
    await db.query(
      "UPDATE device_credentials SET key_id = $1, nonce = $2, ciphertext = $3, updated_at = now() WHERE device_id = $4",
      [fresh.keyId, Buffer.from(fresh.nonce, "base64"), Buffer.from(fresh.ciphertext, "base64"), row.device_id],
    );
    moved += 1;
  }
  const shareRows = await db.query<{
    share_id: string;
    device_id: string;
    key_id: string;
    nonce: Buffer;
    ciphertext: Buffer;
  }>(
    `SELECT k.share_id, s.device_id, k.key_id AS key_id, k.nonce, k.ciphertext
     FROM share_keys k JOIN shares s ON s.id = k.share_id
     WHERE k.key_id <> $1`,
    [active.id],
  );
  for (const row of shareRows.rows) {
    const envelope: CredentialEnvelope = {
      keyId: row.key_id,
      nonce: (row.nonce as Buffer).toString("base64"),
      ciphertext: (row.ciphertext as Buffer).toString("base64"),
    };
    const tailnetAuthKey = decryptShareKey(keys, row.share_id, row.device_id, envelope);
    const fresh = encryptShareKey(active, row.share_id, row.device_id, tailnetAuthKey);
    await db.query(
      "UPDATE share_keys SET key_id = $1, nonce = $2, ciphertext = $3, updated_at = now() WHERE share_id = $4",
      [fresh.keyId, Buffer.from(fresh.nonce, "base64"), Buffer.from(fresh.ciphertext, "base64"), row.share_id],
    );
    moved += 1;
  }
  return moved;
}
