import crypto from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { BackendConfig } from "../src/config.js";
import { fingerprintKey, type DataKey } from "../src/crypto.js";
import type { DbClient } from "../src/db.js";
import { signToken } from "../src/jwt.js";
import type { Mailer } from "../src/mailer.js";
import { createApp } from "../src/server.js";

interface DeviceRow {
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

interface ShareRow {
  id: string;
  device_id: string;
  grantee_email: string;
  permission: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

interface ShareKeyRow {
  share_id: string;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  expires_at: string;
}

const NOW = "2026-09-10T12:00:00.000Z";

/** Fake covering device + share + share-key queries (auth faked by static JWTs). */
class FakeShareDb implements DbClient {
  devices: DeviceRow[] = [];
  credentials: Array<{ device_id: string; key_id: string; nonce: Buffer; ciphertext: Buffer }> = [];
  shares: ShareRow[] = [];
  shareKeys: ShareKeyRow[] = [];
  users = [
    { id: "owner-1", email: "alice@example.test", credential_version: 1 },
    { id: "user-bob", email: "bob@example.test", credential_version: 1 },
    { id: "user-carol", email: "carol@example.test", credential_version: 1 },
  ];
  sent: Array<{ to: string; subject: string; html: string; text: string; tag: string }> = [];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT credential_version FROM users WHERE id")) {
      const user = this.users.find((u) => u.id === params[0]);
      return { rows: (user ? [{ credential_version: user.credential_version }] : []) as T[] };
    }
    if (sql.startsWith("SELECT * FROM devices WHERE owner_id")) {
      return {
        rows: this.devices
          .filter((d) => d.owner_id === params[0])
          .sort((a, b) => a.label.localeCompare(b.label)) as T[],
      };
    }
    if (sql === "SELECT * FROM devices WHERE id = $1") {
      return { rows: this.devices.filter((d) => d.id === params[0]) as T[] };
    }
    if (sql.startsWith("SELECT * FROM devices WHERE id")) {
      return {
        rows: this.devices.filter((d) => d.id === params[0] && d.owner_id === params[1]) as T[],
      };
    }
    if (sql.startsWith("SELECT id, owner_id, label FROM devices WHERE id")) {
      return {
        rows: this.devices
          .filter((d) => d.id === params[0] && d.owner_id === params[1])
          .map((d) => ({ id: d.id, owner_id: d.owner_id, label: d.label })) as T[],
      };
    }
    if (sql.startsWith("INSERT INTO devices")) {
      const [owner_id, tailscale_stable_id, dns_name, last_known_ip, vnc_port, label, collection_name] = params as [
        string, string, string | null, string | null, number, string, string | null,
      ];
      let device = this.devices.find(
        (d) => d.owner_id === owner_id && d.tailscale_stable_id === tailscale_stable_id && d.vnc_port === vnc_port,
      );
      if (device) {
        Object.assign(device, { dns_name, last_known_ip, label, collection_name, updated_at: NOW });
      } else {
        device = {
          id: crypto.randomUUID(), owner_id, tailscale_stable_id, dns_name, last_known_ip,
          vnc_port, label, collection_name, created_at: NOW, updated_at: NOW,
        };
        this.devices.push(device);
      }
      return { rows: [device] as T[] };
    }
    if (sql.startsWith("SELECT c.device_id FROM device_credentials")) {
      const ids = new Set(
        this.credentials
          .filter((c) => this.devices.some((d) => d.id === c.device_id && d.owner_id === params[0]))
          .map((c) => c.device_id),
      );
      return { rows: [...ids].map((device_id) => ({ device_id })) as T[] };
    }
    if (sql.startsWith("INSERT INTO device_credentials")) {
      const [device_id, key_id, nonce, ciphertext] = params as [string, string, Buffer, Buffer];
      this.credentials = this.credentials.filter((c) => c.device_id !== device_id);
      this.credentials.push({ device_id, key_id, nonce, ciphertext });
      return { rows: [] as T[] };
    }
    if (sql.startsWith("SELECT key_id, nonce, ciphertext FROM device_credentials")) {
      return { rows: this.credentials.filter((c) => c.device_id === params[0]) as T[] };
    }
    if (sql.startsWith("SELECT * FROM shares WHERE device_id")) {
      return {
        rows: this.shares.filter(
          (s) => s.device_id === params[0] && s.grantee_email === params[1] && s.revoked_at === null,
        ) as T[],
      };
    }
    if (sql.startsWith("SELECT * FROM shares WHERE id")) {
      return {
        rows: this.shares.filter(
          (s) => s.id === params[0] && s.device_id === params[1] && s.revoked_at === null,
        ) as T[],
      };
    }
    if (sql.startsWith("INSERT INTO shares")) {
      const [device_id, grantee_email, created_by] = params as [string, string, string];
      const share: ShareRow = {
        id: crypto.randomUUID(), device_id, grantee_email, permission: "connect",
        created_by, created_at: NOW, revoked_at: null,
      };
      this.shares.push(share);
      return { rows: [share] as T[] };
    }
    if (sql.startsWith("INSERT INTO share_keys")) {
      const [share_id, key_id, nonce, ciphertext, expires_at] = params as [
        string, string, Buffer, Buffer, string,
      ];
      this.shareKeys = this.shareKeys.filter((k) => k.share_id !== share_id);
      this.shareKeys.push({ share_id, key_id, nonce, ciphertext, expires_at });
      return { rows: [] as T[] };
    }
    if (sql.startsWith("SELECT s.*, k.expires_at FROM shares s")) {
      return {
        rows: this.shares
          .filter((s) => s.device_id === params[0] && s.revoked_at === null)
          .map((s) => ({
            ...s,
            expires_at: this.shareKeys.find((k) => k.share_id === s.id)?.expires_at ?? null,
          })) as T[],
      };
    }
    if (sql.startsWith("DELETE FROM share_keys WHERE share_id")) {
      this.shareKeys = this.shareKeys.filter((k) => k.share_id !== params[0]);
      return { rows: [] as T[] };
    }
    if (sql.startsWith("UPDATE shares SET revoked_at")) {
      const share = this.shares.find((s) => s.id === params[0]);
      if (share) {
        share.revoked_at = NOW;
      }
      return { rows: [] as T[] };
    }
    if (sql.startsWith("SELECT key_id, nonce, ciphertext, expires_at FROM share_keys")) {
      return { rows: this.shareKeys.filter((k) => k.share_id === params[0]) as T[] };
    }
    if (sql.startsWith("SELECT d.*, u.email AS owner_email")) {
      return {
        rows: this.shares
          .filter((s) => s.grantee_email === params[0] && s.revoked_at === null)
          .map((s) => {
            const device = this.devices.find((d) => d.id === s.device_id);
            const owner = this.users.find((u) => u.id === device?.owner_id);
            return {
              ...device,
              owner_email: owner?.email,
              permission: s.permission,
              granted_at: s.created_at,
              has_key: this.shareKeys.some((k) => k.share_id === s.id),
            };
          }) as T[],
      };
    }
    throw new Error(`FakeShareDb: unexpected query: ${sql}`);
  }
}

const config: BackendConfig = {
  port: 3200,
  databaseUrl: "postgres://fake",
  jwtSecret: "test-secret-at-least-32-bytes-long!",
  jwtExpiresIn: "24h",
  publicAppUrl: "https://app.example.test",
  corsOrigin: "",
  postalApiUrl: "https://postal.example.test",
  postalApiKey: "test-key",
  mailFrom: "NomadVNC <test@example.test>",
  mailReplyTo: "",
  magicLinkTtlMinutes: 15,
  dataKeys: [],
};

function testKeys(): DataKey[] {
  const key = crypto.createHash("sha256").update("test-data-key").digest();
  return [{ id: fingerprintKey(key), key }];
}

describe("device sharing", () => {
  let db: FakeShareDb;
  let app: ReturnType<typeof createApp>;
  let alice: string;
  let bob: string;
  let carol: string;
  let mailer: Mailer;

  beforeEach(() => {
    db = new FakeShareDb();
    mailer = {
      sendMail: async (input) => {
        db.sent.push(input);
        return { ok: true as const };
      },
    };
    app = createApp({ config, db, mailer, keys: testKeys() });
    alice = signToken(config, { id: "owner-1", email: "alice@example.test", credential_version: 1 });
    bob = signToken(config, { id: "user-bob", email: "Bob@Example.Test", credential_version: 1 });
    carol = signToken(config, { id: "user-carol", email: "carol@example.test", credential_version: 1 });
  });

  const auth = (token: string) => (req: { set(h: string, v: string): unknown }) =>
    req.set("Authorization", `Bearer ${token}`);

  async function makeDevice(): Promise<string> {
    const created = await auth(alice)(request(app).put("/api/v1/devices")).send({
      label: "Homelab", tailscaleStableId: "peer-1", vncPort: 5900,
    });
    expect(created.status).toBe(200);
    await auth(alice)(request(app).put(`/api/v1/devices/${created.body.device.id}/credential`)).send({
      password: "s3cret-vnc!",
    });
    return created.body.device.id as string;
  }

  it("creates a key-passing grant, stores the key encrypted, and sends a Postal invite", async () => {
    const id = await makeDevice();
    const res = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test",
      tailnetAuthKey: "tskey-auth-abc123",
      keyExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.share).toMatchObject({
      deviceId: id, granteeEmail: "bob@example.test", permission: "connect", hasTailnetKey: true,
    });
    expect(res.body.share.keyExpiresInDays).toBe(7);
    expect(res.body.inviteSent).toBe(true);

    // Ciphertext at rest, never the raw key.
    expect(db.shareKeys).toHaveLength(1);
    expect(db.shareKeys[0]?.ciphertext.toString("utf8")).not.toContain("tskey-auth-abc123");

    // The share invite goes out through the injected mailer.
    expect(db.sent).toHaveLength(1);
    expect(db.sent[0]).toMatchObject({ to: "bob@example.test", tag: "share-invite" });
    expect(db.sent[0]?.html).toContain("Homelab");
  });

  it("creates a same-tailnet grant without a key (and on a keyless server)", async () => {
    const id = await makeDevice();
    const res = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test",
    });
    expect(res.status).toBe(201);
    expect(res.body.share).toMatchObject({ hasTailnetKey: false, keyExpiresInDays: null });

    const keyless = createApp({ config, db, mailer, keys: [] });
    const again = await auth(alice)(request(keyless).post(`/api/v1/devices/${id}/shares`)).send({
      email: "carol@example.test",
    });
    expect(again.status).toBe(201);
    expect(again.body.share.hasTailnetKey).toBe(false);
  });

  it("defaults the key expiry to 30 days", async () => {
    const id = await makeDevice();
    const res = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
    });
    expect(res.status).toBe(201);
    expect(res.body.share.keyExpiresInDays).toBe(30);
  });

  it("rejects bad grants: bad email, self-share, duplicates, strangers, past expiry", async () => {
    const id = await makeDevice();
    const bad = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "not-an-email",
    });
    expect(bad.status).toBe(400);

    const self = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "alice@example.test",
    });
    expect(self.status).toBe(400);

    const first = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
    });
    expect(first.status).toBe(201);
    const dup = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "BOB@example.test",
    });
    expect(dup.status).toBe(409);

    const past = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "carol@example.test", tailnetAuthKey: "tskey-auth-stale",
      keyExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.status).toBe(400);

    const stranger = await auth(carol)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test",
    });
    expect(stranger.status).toBe(404);

    const anon = await request(app).post(`/api/v1/devices/${id}/shares`).send({
      email: "bob@example.test",
    });
    expect(anon.status).toBe(401);

    const missing = await auth(alice)(request(app).post("/api/v1/devices/nope/shares")).send({
      email: "bob@example.test",
    });
    expect(missing.status).toBe(404);
  });

  it("lists grants with expiry warnings and hides revoked ones", async () => {
    const id = await makeDevice();
    const a = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
      keyExpiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "carol@example.test",
    });
    const list = await auth(alice)(request(app).get(`/api/v1/devices/${id}/shares`));
    expect(list.status).toBe(200);
    expect(list.body.shares).toHaveLength(2);
    expect(list.body.shares[0]).toMatchObject({ granteeEmail: "bob@example.test", keyExpiresInDays: 3 });
    expect(list.body.shares[1]).toMatchObject({ granteeEmail: "carol@example.test", keyExpiresInDays: null });

    const revoked = await auth(alice)(
      request(app).delete(`/api/v1/devices/${id}/shares/${a.body.share.id}`),
    );
    expect(revoked.status).toBe(204);
    // Revocation drops the sealed key with the grant.
    expect(db.shareKeys).toHaveLength(0);
    const after = await auth(alice)(request(app).get(`/api/v1/devices/${id}/shares`));
    expect(after.body.shares).toHaveLength(1);

    const strangerList = await auth(carol)(request(app).get(`/api/v1/devices/${id}/shares`));
    expect(strangerList.status).toBe(404);
  });

  it("re-pastes the key without a re-invite, and clears it on null", async () => {
    const id = await makeDevice();
    const created = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-old",
      keyExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const shareId = created.body.share.id as string;
    expect(db.sent).toHaveLength(1);

    const rekeyed = await auth(alice)(request(app).put(`/api/v1/devices/${id}/shares/${shareId}`)).send({
      tailnetAuthKey: "tskey-auth-fresh",
      keyExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.body.share).toMatchObject({ hasTailnetKey: true, keyExpiresInDays: 30 });
    expect(db.sent).toHaveLength(1); // no re-invite

    const released = await auth(bob)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(released.body.tailnetAuthKey).toBe("tskey-auth-fresh");

    const cleared = await auth(alice)(request(app).put(`/api/v1/devices/${id}/shares/${shareId}`)).send({
      tailnetAuthKey: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.share).toMatchObject({ hasTailnetKey: false, keyExpiresInDays: null });

    const unknown = await auth(alice)(request(app).put(`/api/v1/devices/${id}/shares/nope`)).send({
      tailnetAuthKey: "tskey-auth-x",
    });
    expect(unknown.status).toBe(404);
  });

  it("releases password + tailnet key to the grantee, password-only to the owner", async () => {
    const id = await makeDevice();
    await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
      keyExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    // Bob's mixed-case JWT email still matches the lowercased grant.
    const released = await auth(bob)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({
      password: "s3cret-vnc!", tailnetAuthKey: "tskey-auth-abc123", keyExpiresInDays: 7,
    });

    const owner = await auth(alice)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(owner.body.password).toBe("s3cret-vnc!");
    expect(owner.body).not.toHaveProperty("tailnetAuthKey");

    const stranger = await auth(carol)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(stranger.status).toBe(404);
  });

  it("releases a null key for same-tailnet grants and 404s before the owner stores a password", async () => {
    const created = await auth(alice)(request(app).put("/api/v1/devices")).send({
      label: "Bare", tailscaleStableId: "peer-9", vncPort: 5900,
    });
    const id = created.body.device.id as string;
    await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test",
    });

    const empty = await auth(bob)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(empty.status).toBe(404);

    await auth(alice)(request(app).put(`/api/v1/devices/${id}/credential`)).send({ password: "pw" });
    const released = await auth(bob)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(released.body).toMatchObject({ password: "pw", tailnetAuthKey: null, keyExpiresInDays: null });
  });

  it("stops releases on revoke, but allows a fresh grant afterwards", async () => {
    const id = await makeDevice();
    const created = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
    });
    const shareId = created.body.share.id as string;
    await auth(alice)(request(app).delete(`/api/v1/devices/${id}/shares/${shareId}`));

    const cut = await auth(bob)(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(cut.status).toBe(404);
    const shared = await auth(bob)(request(app).get("/api/v1/devices/shared"));
    expect(shared.body.devices).toEqual([]);

    const again = await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test",
    });
    expect(again.status).toBe(201);
    expect(db.sent).toHaveLength(2);

    const missing = await auth(alice)(request(app).delete(`/api/v1/devices/${id}/shares/nope`));
    expect(missing.status).toBe(404);
  });

  it("lists shared devices as metadata only, never secrets", async () => {
    const id = await makeDevice();
    await auth(alice)(request(app).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
    });

    const shared = await auth(bob)(request(app).get("/api/v1/devices/shared"));
    expect(shared.status).toBe(200);
    expect(shared.body.devices).toHaveLength(1);
    expect(shared.body.devices[0]).toMatchObject({
      id, label: "Homelab", vncPort: 5900, sharedBy: "alice@example.test",
      permission: "connect", hasTailnetKey: true,
    });
    expect(shared.body.devices[0].grantedAt).toBeTruthy();
    expect(shared.body.devices[0]).not.toHaveProperty("password");
    expect(shared.body.devices[0]).not.toHaveProperty("tailnetAuthKey");

    const stranger = await auth(carol)(request(app).get("/api/v1/devices/shared"));
    expect(stranger.body.devices).toEqual([]);

    const own = await auth(alice)(request(app).get("/api/v1/devices/shared"));
    expect(own.body.devices).toEqual([]);
  });

  it("answers 503 for key storage and grantee release when no data key is configured", async () => {
    const id = await makeDevice();
    const keyless = createApp({ config, db, mailer, keys: [] });

    const withKey = await auth(alice)(request(keyless).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test", tailnetAuthKey: "tskey-auth-abc123",
    });
    expect(withKey.status).toBe(503);

    const plain = await auth(alice)(request(keyless).post(`/api/v1/devices/${id}/shares`)).send({
      email: "bob@example.test",
    });
    expect(plain.status).toBe(201);
    const released = await auth(bob)(request(keyless).get(`/api/v1/devices/${id}/credential`));
    expect(released.status).toBe(503);
  });

  it("still reports invite failure honestly without failing the grant", async () => {
    const failing: Mailer = { sendMail: async () => ({ ok: false as const, error: "Postal down" }) };
    const failingApp = createApp({ config, db, mailer: failing, keys: testKeys() });
    const created = await auth(alice)(request(failingApp).put("/api/v1/devices")).send({
      label: "Lab", tailscaleStableId: "peer-1", vncPort: 5900,
    });
    const res = await auth(alice)(request(failingApp).post(`/api/v1/devices/${created.body.device.id}/shares`)).send({
      email: "bob@example.test",
    });
    expect(res.status).toBe(201);
    expect(res.body.inviteSent).toBe(false);
  });
});
