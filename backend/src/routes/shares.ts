import { Router, type Request, type Response } from "express";
import type { BackendConfig } from "../config.js";
import { decryptShareKey, encryptShareKey, type DataKey } from "../crypto.js";
import type { DbClient } from "../db.js";
import { asyncRoute, requireUuidParams } from "../http.js";
import { createRequireAuth } from "../jwt.js";
import type { Mailer } from "../mailer.js";
import { sendShareInviteEmail } from "../mailer.js";
import { createRateLimiter } from "../rateLimit.js";
import { isValidEmail, normalizeEmail } from "../tokens.js";

export interface ShareDeps {
  config: BackendConfig;
  db: DbClient;
  mailer: Mailer;
  /** Loaded from DATA_KEY[/DATA_KEY_OLD]; empty disables key-passing shares. */
  keys: DataKey[];
}

export interface ShareRow {
  id: string;
  device_id: string;
  grantee_email: string;
  permission: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ShareKeyRow {
  share_id: string;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  expires_at: string;
}

export interface ShareView {
  id: string;
  deviceId: string;
  granteeEmail: string;
  permission: string;
  hasTailnetKey: boolean;
  /** Whole days until the attached tailnet key expires; null when no key is attached. */
  keyExpiresInDays: number | null;
  createdAt: string;
}

/** Whole days until expiry (ceil, so "expires tomorrow" reads 1); null without a key. */
export function keyExpiresInDays(expiresAt: string | null, nowMs: number = Date.now()): number | null {
  if (!expiresAt) {
    return null;
  }
  return Math.ceil((new Date(expiresAt).getTime() - nowMs) / 86_400_000);
}

function toView(
  row: ShareRow,
  key: Pick<ShareKeyRow, "expires_at"> | null,
  nowMs: number = Date.now(),
): ShareView {
  return {
    id: row.id,
    deviceId: row.device_id,
    granteeEmail: row.grantee_email,
    permission: row.permission,
    hasTailnetKey: key !== null,
    keyExpiresInDays: key ? keyExpiresInDays(key.expires_at, nowMs) : null,
    createdAt: row.created_at,
  };
}

export async function findLiveShare(
  db: DbClient,
  deviceId: string,
  granteeEmail: string,
): Promise<ShareRow | null> {
  const result = await db.query<ShareRow>(
    "SELECT * FROM shares WHERE device_id = $1 AND grantee_email = $2 AND revoked_at IS NULL",
    [deviceId, granteeEmail],
  );
  return result.rows[0] ?? null;
}

export async function getShareKey(db: DbClient, shareId: string): Promise<ShareKeyRow | null> {
  const result = await db.query<ShareKeyRow>(
    "SELECT key_id, nonce, ciphertext, expires_at FROM share_keys WHERE share_id = $1",
    [shareId],
  );
  const row = result.rows[0];
  return row ? { ...row, share_id: shareId } : null;
}

interface DeviceIdRow {
  id: string;
  owner_id: string;
  label: string;
}

type AuthedRequest = Request & { user?: { sub: string; email: string } };

const DEFAULT_KEY_TTL_MS = 30 * 86_400_000;

function cleanAuthKey(value: unknown): string | null {
  // Opaque to the server: length-checked only, never validated against Tailscale.
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 2000) {
    return null;
  }
  return trimmed;
}

function parseExpiry(value: unknown): { ok: true; at: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, at: new Date(Date.now() + DEFAULT_KEY_TTL_MS).toISOString() };
  }
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) {
    return { ok: false, error: "keyExpiresAt must be an ISO date" };
  }
  if (at.getTime() <= Date.now()) {
    return { ok: false, error: "keyExpiresAt is already in the past. Paste a fresh key." };
  }
  return { ok: true, at: at.toISOString() };
}

export function createSharesRouter(deps: ShareDeps): Router {
  const { config, db, mailer, keys } = deps;
  const router = Router();
  requireUuidParams(router, "id", "shareId");
  const requireAuth = createRequireAuth(config, db);
  router.use(requireAuth);
  // Credential-adjacent surface: secret release + key storage. Generous
  // ceiling (per-test-suite traffic stays far below it).
  router.use(createRateLimiter({ windowMs: 10 * 60_000, max: 300 }));

  async function ownedDevice(ownerId: string, deviceId: string): Promise<DeviceIdRow | null> {
    const result = await db.query<DeviceIdRow>(
      "SELECT id, owner_id, label FROM devices WHERE id = $1 AND owner_id = $2",
      [deviceId, ownerId],
    );
    return result.rows[0] ?? null;
  }

  async function storeShareKey(
    shareId: string,
    deviceId: string,
    tailnetAuthKey: string,
    expiresAt: string,
  ): Promise<void> {
    const newest = keys[keys.length - 1] as DataKey;
    const envelope = encryptShareKey(newest, shareId, deviceId, tailnetAuthKey);
    await db.query(
      `INSERT INTO share_keys (share_id, alg, key_id, nonce, ciphertext, expires_at)
       VALUES ($1, 'aes-256-gcm', $2, $3, $4, $5)
       ON CONFLICT (share_id) DO UPDATE
       SET alg = 'aes-256-gcm', key_id = EXCLUDED.key_id, nonce = EXCLUDED.nonce,
           ciphertext = EXCLUDED.ciphertext, expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
      [
        shareId,
        envelope.keyId,
        Buffer.from(envelope.nonce, "base64"),
        Buffer.from(envelope.ciphertext, "base64"),
        expiresAt,
      ],
    );
  }

  router.post("/:id/shares", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const ownerEmail = normalizeEmail(req.user?.email);
    const device = await ownedDevice(ownerId, req.params.id as string);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const granteeEmail = normalizeEmail(body.email);
    if (!isValidEmail(granteeEmail)) {
      res.status(400).json({ error: "A valid grantee email is required" });
      return;
    }
    if (granteeEmail === ownerEmail) {
      res.status(400).json({ error: "A device cannot be shared with its owner" });
      return;
    }
    const existing = await findLiveShare(db, device.id, granteeEmail);
    if (existing) {
      res.status(409).json({ error: "This device is already shared with that address" });
      return;
    }
    let expiresAt: string | null = null;
    if (body.tailnetAuthKey !== undefined) {
      const tailnetAuthKey = cleanAuthKey(body.tailnetAuthKey);
      if (!tailnetAuthKey) {
        res.status(400).json({ error: "tailnetAuthKey must be a non-empty string" });
        return;
      }
      if (keys.length === 0) {
        res.status(503).json({ error: "Credential storage is not configured on this server" });
        return;
      }
      const parsed = parseExpiry(body.keyExpiresAt);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      expiresAt = parsed.at;
    }
    const created = await db.query<ShareRow>(
      `INSERT INTO shares (device_id, grantee_email, permission, created_by)
       VALUES ($1, $2, 'connect', $3) RETURNING *`,
      [device.id, granteeEmail, ownerId],
    );
    const share = created.rows[0] as ShareRow;
    let keyRow: Pick<ShareKeyRow, "expires_at"> | null = null;
    if (expiresAt && typeof body.tailnetAuthKey === "string") {
      await storeShareKey(share.id, device.id, body.tailnetAuthKey.trim(), expiresAt);
      keyRow = { expires_at: expiresAt };
    }
    const sent = await sendShareInviteEmail(mailer, config, granteeEmail, {
      deviceLabel: device.label,
      ownerEmail: ownerEmail || "The device owner",
    });
    if (!sent.ok) {
      console.warn(`share invite mail failed for ${granteeEmail}: ${sent.error}`);
    }
    res.status(201).json({ share: toView(share, keyRow), inviteSent: sent.ok });
  }));

  router.get("/:id/shares", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const device = await ownedDevice(ownerId, req.params.id as string);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const result = await db.query<ShareRow & { expires_at: string | null }>(
      `SELECT s.*, k.expires_at FROM shares s
       LEFT JOIN share_keys k ON k.share_id = s.id
       WHERE s.device_id = $1 AND s.revoked_at IS NULL ORDER BY s.created_at ASC`,
      [device.id],
    );
    res.json({
      shares: result.rows.map((row) =>
        toView(row, row.expires_at ? { expires_at: row.expires_at } : null),
      ),
    });
  }));

  router.put("/:id/shares/:shareId", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const device = await ownedDevice(ownerId, req.params.id as string);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const found = await db.query<ShareRow>(
      "SELECT * FROM shares WHERE id = $1 AND device_id = $2 AND revoked_at IS NULL",
      [req.params.shareId, device.id],
    );
    const share = found.rows[0];
    if (!share) {
      res.status(404).json({ error: "Share not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (body.tailnetAuthKey === null) {
      // Same-tailnet downgrade: drop the key, keep the grant.
      await db.query("DELETE FROM share_keys WHERE share_id = $1", [share.id]);
      res.json({ share: toView(share, null) });
      return;
    }
    const tailnetAuthKey = cleanAuthKey(body.tailnetAuthKey);
    if (!tailnetAuthKey) {
      res.status(400).json({ error: "tailnetAuthKey must be a non-empty string (or null to remove it)" });
      return;
    }
    if (keys.length === 0) {
      res.status(503).json({ error: "Credential storage is not configured on this server" });
      return;
    }
    const parsed = parseExpiry(body.keyExpiresAt);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await storeShareKey(share.id, device.id, tailnetAuthKey, parsed.at);
    res.json({ share: toView(share, { expires_at: parsed.at }) });
  }));

  router.delete("/:id/shares/:shareId", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const device = await ownedDevice(ownerId, req.params.id as string);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const found = await db.query<ShareRow>(
      "SELECT * FROM shares WHERE id = $1 AND device_id = $2 AND revoked_at IS NULL",
      [req.params.shareId, device.id],
    );
    if (!found.rows[0]) {
      res.status(404).json({ error: "Share not found" });
      return;
    }
    await db.query("UPDATE shares SET revoked_at = now() WHERE id = $1", [req.params.shareId]);
    // Drop the sealed key with the grant: revocation must leave nothing
    // a future bug could release, and a re-share starts from clean state.
    await db.query("DELETE FROM share_keys WHERE share_id = $1", [req.params.shareId]);
    res.sendStatus(204);
  }));

  return router;
}

/** Decrypt a stored share key for release; throws when no key is loaded to open it. */
export function openShareKey(
  keys: DataKey[],
  share: ShareRow,
  keyRow: ShareKeyRow,
): string {
  return decryptShareKey(keys, share.id, share.device_id, {
    keyId: keyRow.key_id,
    nonce: (keyRow.nonce as Buffer).toString("base64"),
    ciphertext: (keyRow.ciphertext as Buffer).toString("base64"),
  });
}
