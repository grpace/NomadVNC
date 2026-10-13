import { describe, expect, it, vi } from "vitest";

vi.mock("../native/NomadNativeModule", () => ({ NomadNativeModule: {} }));

import { saveAccountDevice, type AccountDeviceFields } from "./deviceEdit";
import type { BackendDeviceUpsert } from "./accountClient";

function fakeClient(options: { shares?: number; saved?: string | null } = {}) {
  const calls: string[] = [];
  const upserts: BackendDeviceUpsert[] = [];
  const client = {
    async listShares() {
      calls.push("listShares");
      return Array.from({ length: options.shares ?? 0 }, () => ({}) as never);
    },
    async upsertDevice(input: BackendDeviceUpsert) {
      calls.push("upsert");
      upserts.push(input);
      return { id: "new-id" } as never;
    },
    async setDeviceCredential(id: string, password: string) {
      calls.push(`setCredential:${id}:${password}`);
    },
    async getDeviceCredential(id: string) {
      calls.push(`getCredential:${id}`);
      return options.saved === undefined ? "old-secret" : options.saved;
    },
    async deleteDevice(id: string) {
      calls.push(`delete:${id}`);
    },
  };
  return { client, calls, upserts };
}

const MAC = {
  id: "mac-1",
  label: "Studio",
  tailscaleStableId: "nStable123",
  dnsName: "studio.tail1234.ts.net",
  lastKnownIp: "100.64.0.7",
  vncPort: 5900,
  hasCredential: true,
};

function fields(overrides: Partial<AccountDeviceFields> = {}): AccountDeviceFields {
  return {
    label: "Studio Mac",
    host: "studio.tail1234.ts.net",
    port: 5900,
    collectionName: "",
    vncUsername: "greg",
    password: "",
    ...overrides,
  };
}

describe("saveAccountDevice", () => {
  it("edits in place, keeping the tailnet identity and the saved password", async () => {
    const { client, calls, upserts } = fakeClient();
    await saveAccountDevice(client, MAC, fields());
    expect(upserts[0]).toMatchObject({
      label: "Studio Mac",
      tailscaleStableId: "nStable123",
      dnsName: "studio.tail1234.ts.net",
      lastKnownIp: "100.64.0.7",
      vncUsername: "greg",
    });
    expect(calls).toEqual(["upsert"]);
  });

  it("moves the password to the new record when the address changes, then drops the old one", async () => {
    const { client, calls, upserts } = fakeClient();
    await saveAccountDevice(client, MAC, fields({ host: "192.168.1.30" }));
    expect(upserts[0]).toMatchObject({ tailscaleStableId: "manual:192.168.1.30", lastKnownIp: "192.168.1.30" });
    expect(calls).toEqual([
      "listShares",
      "upsert",
      "getCredential:mac-1",
      "setCredential:new-id:old-secret",
      "delete:mac-1",
    ]);
  });

  it("refuses to move a shared computer", async () => {
    const { client, calls } = fakeClient({ shares: 2 });
    await expect(saveAccountDevice(client, MAC, fields({ port: 5901 }))).rejects.toThrow(/shared/);
    expect(calls).toEqual(["listShares"]);
  });

  it("adds a new device with an optional password and clears an empty username", async () => {
    const { client, calls, upserts } = fakeClient();
    await saveAccountDevice(client, null, fields({ host: "office.local", vncUsername: " ", password: "pw" }));
    expect(upserts[0]).toMatchObject({ tailscaleStableId: "manual:office.local", vncUsername: "" });
    expect(calls).toEqual(["upsert", "setCredential:new-id:pw"]);
  });
});
