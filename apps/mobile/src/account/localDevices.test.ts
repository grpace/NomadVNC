import { describe, expect, it, vi } from "vitest";

vi.mock("../native/NomadNativeModule", () => ({ NomadNativeModule: {} }));

import {
  deviceIdentityForAddress,
  sanitizeLocalDevices,
  setLocalCredentialFlag,
  upsertLocalDevice,
  type LocalDevice,
} from "./localDevices";

let counter = 0;
const nextId = () => `id-${++counter}`;

describe("local devices", () => {
  it("keys LAN hosts as manual and tailnet names by host", () => {
    expect(deviceIdentityForAddress("192.168.1.20")).toBe("manual:192.168.1.20");
    expect(deviceIdentityForAddress("Office-PC.local")).toBe("manual:office-pc.local");
    expect(deviceIdentityForAddress("pc.tail1234.ts.net")).toBe("pc.tail1234.ts.net");
  });

  it("adds, then updates the same address and port in place", () => {
    const first = upsertLocalDevice([], { label: "Office", host: "192.168.1.20", port: 5900 }, nextId);
    expect(first.device).toMatchObject({ label: "Office", lastKnownIp: "192.168.1.20", hasCredential: false });

    const flagged = setLocalCredentialFlag(first.devices, first.device.id, true);
    const second = upsertLocalDevice(flagged, { label: "Office PC", host: "192.168.1.20", port: 5900 }, nextId);
    expect(second.devices).toHaveLength(1);
    expect(second.device.id).toBe(first.device.id);
    expect(second.device.label).toBe("Office PC");
    expect(second.device.hasCredential).toBe(true);

    const other = upsertLocalDevice(second.devices, { label: "Lab", host: "lab.local", port: 5901 }, nextId);
    expect(other.devices).toHaveLength(2);
    expect(other.device.dnsName).toBe("lab.local");
  });

  it("drops malformed stored rows and never keeps unknown fields", () => {
    const stored = [
      { id: "a", label: "A", tailscaleStableId: "manual:a", vncPort: 5900, password: "leak" },
      { id: "b", label: "B", tailscaleStableId: "manual:b", vncPort: 99999 },
      "junk",
    ];
    const devices: LocalDevice[] = sanitizeLocalDevices(stored);
    expect(devices).toHaveLength(1);
    expect(devices[0]).not.toHaveProperty("password");
    expect(sanitizeLocalDevices(null)).toEqual([]);
  });
});
