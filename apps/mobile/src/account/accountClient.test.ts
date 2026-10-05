import { describe, expect, it, vi } from "vitest";
import { AccountApiError, AccountClient } from "./accountClient";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
}

describe("AccountClient (mobile)", () => {
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

  it("attaches the Bearer <redacted> and parses devices", async () => {
    const token = ["jwt", "123"].join("-");
    const fetchFn = mockFetch((url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
      return jsonResponse(200, { devices: [{ id: "d1", label: "Bay 1" }] });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt-123", fetchFn);
    expect(client.authenticated).toBe(true);
    await expect(client.listDevices()).resolves.toEqual([{ id: "d1", label: "Bay 1" }]);
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

  it("upserts a device and returns the view", async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(init?.method).toBe("PUT");
      expect(init?.body).toContain("Bay 2");
      return jsonResponse(200, { device: { id: "d2", label: "Bay 2" } });
    });
    const client = new AccountClient("https://api.example.test", () => "jwt", fetchFn);
    const device = await client.upsertDevice({
      label: "Bay 2",
      tailscaleStableId: "stable-2",
      vncPort: 5900,
      collectionName: "Bays",
    });
    expect(device).toEqual({ id: "d2", label: "Bay 2" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
