import { Router, type Request, type Response } from "express";
import type { BackendConfig } from "../config.js";
import { decryptCredential, encryptCredential, type DataKey } from "../crypto.js";
import type { DbClient } from "../db.js";
import { asyncRoute, requireUuidParams } from "../http.js";
import { createRequireAuth } from "../jwt.js";
import { createRateLimiter } from "../rateLimit.js";
import { normalizeEmail } from "../tokens.js";
import { findLiveShare, getShareKey, keyExpiresInDays as keyExpiresInDaysFn, openShareKey } from "./shares.js";

export interface DeviceDeps {
  config: BackendConfig;
  db: DbClient;
  /** Loaded from DATA_KEY[/DATA_KEY_OLD]; empty disables credential endpoints. */
  keys: DataKey[];
}

export interface DeviceRow {
  id: string;
  owner_id: string;
  tailscale_stable_id: string;
  dns_name: string | null;
  last_known_ip: string | null;
  vnc_port: number;
  label: string;
  collection_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceView {
  id: string;
  tailscaleStableId: string;
  dnsName?: string;
  lastKnownIp?: string;
  vncPort: number;
  label: string;
  collectionName?: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

function toView(row: DeviceRow, hasCredential: boolean): DeviceView {
  return {
    id: row.id,
    tailscaleStableId: row.tailscale_stable_id,
    dnsName: row.dns_name ?? undefined,
    lastKnownIp: row.last_known_ip ?? undefined,
    vncPort: row.vnc_port,
    label: row.label,
    collectionName: row.collection_name ?? undefined,
    hasCredential,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SharedDeviceView {
  id: string;
  tailscaleStableId: string;
  dnsName?: string;
  lastKnownIp?: string;
  vncPort: number;
  label: string;
  collectionName?: string;
  /** Owner's account email — who granted this. */
  sharedBy: string;
  permission: string;
  /** True when the grant carries a tailnet auth key (key-passing transport). */
  hasTailnetKey: boolean;
  grantedAt: string;
}

type AuthedRequest = Request & { user?: { sub: string; email: string } };

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

export function createDevicesRouter(deps: DeviceDeps): Router {
  const { db, keys } = deps;
  const router = Router();
  requireUuidParams(router, "id");
  const requireAuth = createRequireAuth(deps.config, db);
  router.use(requireAuth);

  async function credentialIds(ownerId: string): Promise<Set<string>> {
    const result = await db.query<{ device_id: string }>(
      `SELECT c.device_id FROM device_credentials c
       JOIN devices d ON d.id = c.device_id WHERE d.owner_id = $1`,
      [ownerId],
    );
    return new Set(result.rows.map((row) => row.device_id));
  }

  async function ownedDevice(ownerId: string, deviceId: string): Promise<DeviceRow | null> {
    const result = await db.query<DeviceRow>("SELECT * FROM devices WHERE id = $1 AND owner_id = $2", [
      deviceId,
      ownerId,
    ]);
    return result.rows[0] ?? null;
  }

  async function anyDevice(deviceId: string): Promise<DeviceRow | null> {
    const result = await db.query<DeviceRow>("SELECT * FROM devices WHERE id = $1", [deviceId]);
    return result.rows[0] ?? null;
  }

  const secretLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 300 });

  router.get("/", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const result = await db.query<DeviceRow>(
      "SELECT * FROM devices WHERE owner_id = $1 ORDER BY label ASC",
      [ownerId],
    );
    const withCredentials = await credentialIds(ownerId);
    res.json({ devices: result.rows.map((row) => toView(row, withCredentials.has(row.id))) });
  }));

  router.put("/", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const body = req.body as Record<string, unknown>;
    const label = cleanString(body.label, 200);
    const stableId = cleanString(body.tailscaleStableId, 200);
    const port = typeof body.vncPort === "number" ? body.vncPort : Number(body.vncPort);
    if (!label || !stableId || !Number.isInteger(port) || port <= 0 || port > 65535) {
      res.status(400).json({ error: "label, tailscaleStableId, and a valid vncPort are required" });
      return;
    }
    const dnsName = cleanString(body.dnsName, 253);
    const lastKnownIp = cleanString(body.lastKnownIp, 64);
    const collectionName = cleanString(body.collectionName, 200);
    const result = await db.query<DeviceRow>(
      `INSERT INTO devices (owner_id, tailscale_stable_id, dns_name, last_known_ip, vnc_port, label, collection_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_id, tailscale_stable_id, vnc_port)
       DO UPDATE SET dns_name = EXCLUDED.dns_name, last_known_ip = EXCLUDED.last_known_ip,
                     label = EXCLUDED.label, collection_name = EXCLUDED.collection_name,
                     updated_at = now()
       RETURNING *`,
      [ownerId, stableId, dnsName, lastKnownIp, port, label, collectionName],
    );
    const row = result.rows[0] as DeviceRow;
    const withCredentials = await credentialIds(ownerId);
    res.json({ device: toView(row, withCredentials.has(row.id)) });
  }));

  router.delete("/:id", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    await db.query("DELETE FROM devices WHERE id = $1 AND owner_id = $2", [req.params.id, ownerId]);
    res.sendStatus(204);
  }));

  router.get("/shared", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const email = normalizeEmail(req.user?.email);
    const result = await db.query<
      DeviceRow & { owner_email: string; permission: string; granted_at: string; has_key: boolean }
    >(
      `SELECT d.*, u.email AS owner_email, s.permission, s.created_at AS granted_at,
              (k.share_id IS NOT NULL) AS has_key
       FROM shares s
       JOIN devices d ON d.id = s.device_id
       JOIN users u ON u.id = d.owner_id
       LEFT JOIN share_keys k ON k.share_id = s.id
       WHERE s.grantee_email = $1 AND s.revoked_at IS NULL ORDER BY d.label ASC`,
      [email],
    );
    const shared: SharedDeviceView[] = result.rows.map((row) => ({
      id: row.id,
      tailscaleStableId: row.tailscale_stable_id,
      dnsName: row.dns_name ?? undefined,
      lastKnownIp: row.last_known_ip ?? undefined,
      vncPort: row.vnc_port,
      label: row.label,
      collectionName: row.collection_name ?? undefined,
      sharedBy: row.owner_email,
      permission: row.permission,
      hasTailnetKey: row.has_key,
      grantedAt: row.granted_at,
    }));
    res.json({ devices: shared });
  }));

  function requireKeys(res: Response): DataKey[] | null {
    if (keys.length === 0) {
      res.status(503).json({ error: "Credential storage is not configured on this server" });
      return null;
    }
    return keys;
  }

  router.put("/:id/credential", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const active = requireKeys(res);
    if (!active) {
      return;
    }
    const ownerId = req.user?.sub as string;
    const device = await ownedDevice(ownerId, req.params.id as string);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const password = (req.body as Record<string, unknown>).password;
    if (typeof password !== "string" || password === "" || password.length > 500) {
      res.status(400).json({ error: "A non-empty password is required" });
      return;
    }
    const newest = active[active.length - 1] as DataKey;
    const envelope = encryptCredential(newest, device.id, ownerId, password);
    await db.query(
      `INSERT INTO device_credentials (device_id, alg, key_id, nonce, ciphertext)
       VALUES ($1, 'aes-256-gcm', $2, $3, $4)
       ON CONFLICT (device_id) DO UPDATE
       SET alg = 'aes-256-gcm', key_id = EXCLUDED.key_id, nonce = EXCLUDED.nonce,
           ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [
        device.id,
        envelope.keyId,
        Buffer.from(envelope.nonce, "base64"),
        Buffer.from(envelope.ciphertext, "base64"),
      ],
    );
    res.json({ ok: true });
  }));

  router.delete("/:id/credential", asyncRoute(async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user?.sub as string;
    const device = await ownedDevice(ownerId, req.params.id as string);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    // No key needed: deletion is cleanup, and must work even when the
    // server's credential storage is unconfigured.
    await db.query("DELETE FROM device_credentials WHERE device_id = $1", [device.id]);
    res.sendStatus(204);
  }));

  router.get("/:id/credential", secretLimiter, asyncRoute(async (req: AuthedRequest, res: Response) => {
    const active = requireKeys(res);
    if (!active) {
      return;
    }
    const ownerId = req.user?.sub as string;
    const deviceId = req.params.id as string;
    const device = await ownedDevice(ownerId, deviceId);
    if (device) {
      const stored = await db.query<{ key_id: string; nonce: Buffer; ciphertext: Buffer }>(
        "SELECT key_id, nonce, ciphertext FROM device_credentials WHERE device_id = $1",
        [device.id],
      );
      const row = stored.rows[0];
      if (!row) {
        res.status(404).json({ error: "No credential stored for this device" });
        return;
      }
      try {
        const password = decryptCredential(active, device.id, ownerId, {
          keyId: row.key_id,
          nonce: (row.nonce as Buffer).toString("base64"),
          ciphertext: (row.ciphertext as Buffer).toString("base64"),
        });
        res.json({ password });
      } catch {
        res.status(500).json({ error: "Stored credential cannot be decrypted" });
      }
      return;
    }
    // Grantee path: release the VNC password (+ tailnet auth key when the
    // grant carries one) only while a live share row exists. Anything else
    // is a 404 so strangers can't probe for device existence.
    const shared = await anyDevice(deviceId);
    if (!shared) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const share = await findLiveShare(db, deviceId, normalizeEmail(req.user?.email));
    if (!share) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const stored = await db.query<{ key_id: string; nonce: Buffer; ciphertext: Buffer }>(
      "SELECT key_id, nonce, ciphertext FROM device_credentials WHERE device_id = $1",
      [shared.id],
    );
    const row = stored.rows[0];
    if (!row) {
      res.status(404).json({ error: "The owner has not stored a password for this device yet" });
      return;
    }
    try {
      const password = decryptCredential(active, shared.id, shared.owner_id, {
        keyId: row.key_id,
        nonce: (row.nonce as Buffer).toString("base64"),
        ciphertext: (row.ciphertext as Buffer).toString("base64"),
      });
      let tailnetAuthKey: string | null = null;
      let keyExpiresInDays: number | null = null;
      const keyRow = await getShareKey(db, share.id);
      if (keyRow) {
        tailnetAuthKey = openShareKey(active, share, keyRow);
        keyExpiresInDays = keyExpiresInDaysFn(keyRow.expires_at);
      }
      res.json({ password, tailnetAuthKey, keyExpiresInDays });
    } catch {
      res.status(500).json({ error: "Stored credential cannot be decrypted" });
    }
  }));

  return router;
}
