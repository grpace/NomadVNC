import { describe, expect, it, vi } from "vitest";
import { AccountApiError, AccountClient, createAccountFetch } from "./accountClient";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
}

describe("AccountClient", () => {
  it("sends the magic-link request without auth", async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(url).toBe("https://api.example.test/api/v1/auth/magic-link");
      expect(init?.headers).not.toHaveProperty("Authorization");
      expect(init?.body).toContain("a@example.test");
      return jsonResponse(200, { ok: true });
    });
    const client = new AccountClient("https://api.example.test/", () => null, fetchFn);
    expect(client.authenticated).toBe(false);
    await client.requestMagicLink("a@example.test");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("consumes a link and surfaces the token", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, { token: "jwt-123" }));
    const client = new AccountClient("https://api.example.test", () => null, fetchFn);
    await expect(client.consumeMagicLink("raw-token")).resolves.toBe("jwt-123");
  });

  it("attaches the bearer token and parses devices", async () => {
    const fetchFn = mockFetch((url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123");
      return jsonResponse(200, { devices: [{ id: "d1", label: "Lab" }] });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt-123", fetchFn);
    expect(client.authenticated).toBe(true);
    await expect(client.listDevices()).resolves.toEqual([{ id: "d1", label: "Lab" }]);
  });

  it("refuses authenticated calls without a token", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, {}));
    const client = new AccountClient("https://api.example.test", () => null, fetchFn);
    await expect(client.listDevices()).rejects.toMatchObject({ status: 401 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps server errors and network failures", async () => {
    const failing = new AccountClient(
      "https://api.example.test",
      () => "jwt",
      mockFetch(() => jsonResponse(404, { error: "Device not found" })),
    );
    await expect(failing.getDeviceCredential("nope")).resolves.toBeNull();

    const down = new AccountClient(
      "https://api.example.test",
      () => "jwt",
      mockFetch(() => {
        throw new Error("connection refused");
      }),
    );
    await expect(down.listDevices()).rejects.toMatchObject({
      status: 0,
      name: "AccountApiError",
    });
    const err = await down.listDevices().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AccountApiError);
  });

  it("round-trips credential storage", async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/credential") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, { password: "s3cret" });
      }
      return jsonResponse(200, { ok: true });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt", fetchFn);
    await client.setDeviceCredential("d1", "s3cret");
    await expect(client.getDeviceCredential("d1")).resolves.toBe("s3cret");
    expect(calls).toEqual([
      "PUT https://api.example.test/api/v1/devices/d1/credential",
      "GET https://api.example.test/api/v1/devices/d1/credential",
    ]);
  });

  it("deletes credentials, treating already-gone as success", async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/devices/gone/credential")) {
        return jsonResponse(404, { error: "Device not found" });
      }
      return new Response(null, { status: 204 });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt", fetchFn);
    await expect(client.deleteDeviceCredential("d1")).resolves.toBeUndefined();
    await expect(client.deleteDeviceCredential("gone")).resolves.toBeUndefined();
    expect(calls).toEqual([
      "DELETE https://api.example.test/api/v1/devices/d1/credential",
      "DELETE https://api.example.test/api/v1/devices/gone/credential",
    ]);
  });

  it("deletes devices, treating already-gone as success", async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/gone")) {
        return jsonResponse(404, { error: "Device not found" });
      }
      return new Response(null, { status: 204 });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt", fetchFn);
    await expect(client.deleteDevice("d1")).resolves.toBeUndefined();
    await expect(client.deleteDevice("gone")).resolves.toBeUndefined();
    expect(calls).toEqual([
      "DELETE https://api.example.test/api/v1/devices/d1",
      "DELETE https://api.example.test/api/v1/devices/gone",
    ]);
  });

  it("manages shares and lists shared devices", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    const fetchFn = mockFetch((url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? "") });
      if (url.endsWith("/devices/shared")) {
        return jsonResponse(200, { devices: [{ id: "s1", label: "Shared Box" }] });
      }
      if (url.endsWith("/shares") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, { shares: [{ id: "g1" }] });
      }
      if (url.endsWith("/shares") && init?.method === "POST") {
        return jsonResponse(201, { share: { id: "g2" }, inviteSent: true });
      }
      if (url.endsWith("/shares/g1") && init?.method === "PUT") {
        return jsonResponse(200, { share: { id: "g1", keyExpiresInDays: 30 } });
      }
      if (url.endsWith("/shares/g1") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, { error: "unexpected" });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt", fetchFn);
    await expect(client.listSharedDevices()).resolves.toEqual([{ id: "s1", label: "Shared Box" }]);
    await expect(client.listShares("d1")).resolves.toEqual([{ id: "g1" }]);
    const created = await client.createShare("d1", {
      email: "bob@example.test",
      tailnetAuthKey: "tskey-auth-x",
      keyExpiresAt: "2026-10-01T00:00:00.000Z",
    });
    expect(created).toEqual({ share: { id: "g2" }, inviteSent: true });
    expect(calls.find((call) => call.method === "POST")?.body).toContain("bob@example.test");
    const updated = await client.updateShareKey("d1", "g1", { tailnetAuthKey: "tskey-new" });
    expect(updated).toEqual({ id: "g1", keyExpiresInDays: 30 });
    await expect(client.deleteShare("d1", "g1")).resolves.toBeUndefined();
    await expect(client.deleteShare("d1", "missing")).resolves.toBeUndefined();
  });
});

describe("createAccountFetch", () => {
  it("routes requests through the main-process bridge and rebuilds the Response", async () => {
    const accountRequest = vi.fn(async () => ({ status: 200, body: JSON.stringify({ token: "jwt-bridge" }) }));
    const client = new AccountClient("https://api.example.test", () => null, createAccountFetch({ accountRequest }));
    await expect(client.consumeMagicLink("magic")).resolves.toBe("jwt-bridge");
    expect(accountRequest).toHaveBeenCalledWith({
      url: "https://api.example.test/api/v1/auth/consume",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "magic" }),
    });
  });

  it("handles bodiless 204 replies and surfaces API errors", async () => {
    const accountRequest = vi
      .fn()
      .mockResolvedValueOnce({ status: 204, body: "" })
      .mockResolvedValueOnce({ status: 401, body: JSON.stringify({ error: "Token expired" }) });
    const client = new AccountClient("https://api.example.test", () => "jwt", createAccountFetch({ accountRequest }));
    await expect(client.deleteDevice("d1")).resolves.toBeUndefined();
    await expect(client.listDevices()).rejects.toMatchObject({ status: 401, message: "Token expired" });
  });

  it("reports an unreachable server when the bridge rejects", async () => {
    const accountRequest = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const client = new AccountClient("https://api.example.test", () => null, createAccountFetch({ accountRequest }));
    await expect(client.requestMagicLink("a@example.test")).rejects.toMatchObject({ status: 0 });
  });
});
