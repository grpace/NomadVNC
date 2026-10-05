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

interface CredentialRow {
  device_id: string;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
}

const NOW = "2026-09-10T12:00:00.000Z";

/** Fake covering exactly the device/credential queries (auth faked by static JWTs). */
class FakeDeviceDb implements DbClient {
  devices: DeviceRow[] = [];
  credentials: CredentialRow[] = [];
  users = [
    { id: "owner-1", credential_version: 1 },
    { id: "owner-2", credential_version: 1 },
  ];

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
    if (sql.startsWith("SELECT c.device_id FROM device_credentials")) {
      const ids = new Set(
        this.credentials
          .filter((c) => this.devices.some((d) => d.id === c.device_id && d.owner_id === params[0]))
          .map((c) => c.device_id),
      );
      return { rows: [...ids].map((device_id) => ({ device_id })) as T[] };
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
    if (sql === "SELECT * FROM devices WHERE id = $1") {
      return { rows: this.devices.filter((d) => d.id === params[0]) as T[] };
    }
    if (sql.startsWith("SELECT * FROM devices WHERE id")) {
      return {
        rows: this.devices.filter((d) => d.id === params[0] && d.owner_id === params[1]) as T[],
      };
    }
    if (sql.startsWith("DELETE FROM devices")) {
      this.devices = this.devices.filter((d) => !(d.id === params[0] && d.owner_id === params[1]));
      this.credentials = this.credentials.filter((c) =>
        this.devices.some((d) => d.id === c.device_id),
      );
      return { rows: [] as T[] };
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
    if (sql.startsWith("DELETE FROM device_credentials")) {
      this.credentials = this.credentials.filter((c) => c.device_id !== params[0]);
      return { rows: [] as T[] };
    }
    if (sql.startsWith("SELECT * FROM shares WHERE device_id")) {
      return { rows: [] as T[] };
    }
    throw new Error(`FakeDeviceDb: unexpected query: ${sql}`);
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

const noMail: Mailer = {
  sendMail: async () => ({ ok: true as const }),
};

function testKeys(): DataKey[] {
  const key = crypto.createHash("sha256").update("test-data-key").digest();
  return [{ id: fingerprintKey(key), key }];
}

describe("devices sync", () => {
  let db: FakeDeviceDb;
  let token: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new FakeDeviceDb();
    app = createApp({ config, db, mailer: noMail, keys: testKeys() });
    token = signToken(config, { id: "owner-1", email: "owner@example.test", credential_version: 1 });
  });

  function auth(req: { set(h: string, v: string): unknown }) {
    return req.set("Authorization", `Bearer ${token}`);
  }

  it("upserts devices by stable id + port and lists metadata without secrets", async () => {
    const first = await auth(request(app).put("/api/v1/devices")).send({
      label: "Lab", tailscaleStableId: "peer-1", dnsName: "lab.tail.ts.net", vncPort: 5900,
    });
    expect(first.status).toBe(200);
    expect(first.body.device.hasCredential).toBe(false);
    expect(first.body.device).not.toHaveProperty("password");

    const second = await auth(request(app).put("/api/v1/devices")).send({
      label: "Lab Renamed", tailscaleStableId: "peer-1", vncPort: 5900, collectionName: "Homelab",
    });
    expect(second.body.device.id).toBe(first.body.device.id);
    expect(second.body.device.label).toBe("Lab Renamed");

    const list = await auth(request(app).get("/api/v1/devices"));
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].collectionName).toBe("Homelab");
  });

  it("rejects bad input and strangers", async () => {
    const bad = await auth(request(app).put("/api/v1/devices")).send({ label: "", vncPort: 99999 });
    expect(bad.status).toBe(400);

    const anon = await request(app).get("/api/v1/devices");
    expect(anon.status).toBe(401);

    const other = signToken(config, { id: "owner-2", email: "other@example.test", credential_version: 1 });
    const empty = await request(app).get("/api/v1/devices").set("Authorization", `Bearer ${other}`);
    expect(empty.body.devices).toEqual([]);
  });

  it("stores and returns the VNC password only to the owner", async () => {
    const created = await auth(request(app).put("/api/v1/devices")).send({
      label: "Lab", tailscaleStableId: "peer-1", vncPort: 5900,
    });
    const id = created.body.device.id as string;

    const stored = await auth(request(app).put(`/api/v1/devices/${id}/credential`)).send({
      password: "s3cret-vnc!",
    });
    expect(stored.status).toBe(200);

    const fetched = await auth(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(fetched.body.password).toBe("s3cret-vnc!");

    const list = await auth(request(app).get("/api/v1/devices"));
    expect(list.body.devices[0].hasCredential).toBe(true);

    const other = signToken(config, { id: "owner-2", email: "other@example.test", credential_version: 1 });
    const stranger = await request(app)
      .get(`/api/v1/devices/${id}/credential`)
      .set("Authorization", `Bearer ${other}`);
    expect(stranger.status).toBe(404);

    const missing = await auth(request(app).get("/api/v1/devices/nope/credential"));
    expect(missing.status).toBe(404);
    // Malformed ids never reach Postgres (a uuid cast error used to be an
    // unhandled rejection that killed the process).
    const malformedDelete = await auth(request(app).delete("/api/v1/devices/not-a-uuid"));
    expect(malformedDelete.status).toBe(404);

    const blank = await auth(request(app).put(`/api/v1/devices/${id}/credential`)).send({ password: "" });
    expect(blank.status).toBe(400);
  });

  it("deletes devices with their credentials", async () => {
    const created = await auth(request(app).put("/api/v1/devices")).send({
      label: "Lab", tailscaleStableId: "peer-1", vncPort: 5900,
    });
    const id = created.body.device.id as string;
    await auth(request(app).put(`/api/v1/devices/${id}/credential`)).send({ password: "x" });

    const deleted = await auth(request(app).delete(`/api/v1/devices/${id}`));
    expect(deleted.status).toBe(204);
    expect(db.devices).toHaveLength(0);
    expect(db.credentials).toHaveLength(0);
  });

  it("deletes a stored credential without deleting the device", async () => {
    const created = await auth(request(app).put("/api/v1/devices")).send({
      label: "Lab", tailscaleStableId: "peer-1", vncPort: 5900,
    });
    const id = created.body.device.id as string;
    await auth(request(app).put(`/api/v1/devices/${id}/credential`)).send({ password: "s3cret" });

    const deleted = await auth(request(app).delete(`/api/v1/devices/${id}/credential`));
    expect(deleted.status).toBe(204);
    expect(db.credentials).toHaveLength(0);

    const fetched = await auth(request(app).get(`/api/v1/devices/${id}/credential`));
    expect(fetched.status).toBe(404);

    const list = await auth(request(app).get("/api/v1/devices"));
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].hasCredential).toBe(false);

    // Deleting again is a no-op success; strangers and missing ids 404.
    const repeat = await auth(request(app).delete(`/api/v1/devices/${id}/credential`));
    expect(repeat.status).toBe(204);

    const other = signToken(config, { id: "owner-2", email: "other@example.test", credential_version: 1 });
    const stranger = await request(app)
      .delete(`/api/v1/devices/${id}/credential`)
      .set("Authorization", `Bearer ${other}`);
    expect(stranger.status).toBe(404);

    const missing = await auth(request(app).delete("/api/v1/devices/nope/credential"));
    expect(missing.status).toBe(404);
  });

  it("answers 503 for credentials when no data key is configured", async () => {
    const keyless = createApp({ config, db, mailer: noMail, keys: [] });
    const created = await auth(request(keyless).put("/api/v1/devices")).send({
      label: "Lab", tailscaleStableId: "peer-1", vncPort: 5900,
    });
    const id = created.body.device.id as string;
    const stored = await auth(request(keyless).put(`/api/v1/devices/${id}/credential`)).send({
      password: "x",
    });
    expect(stored.status).toBe(503);
  });
});
