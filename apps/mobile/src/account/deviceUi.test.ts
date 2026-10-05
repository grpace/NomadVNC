import { describe, expect, it } from "vitest";
import {
  buildSavedDeviceInput,
  groupDevicesByCollection,
  isTailnetHost,
  isValidEmail,
  savedDeviceHost,
  type SavedDeviceLike,
} from "./deviceUi";

function device(overrides: Partial<SavedDeviceLike> = {}): SavedDeviceLike {
  return {
    id: "d1",
    label: "Bay 1",
    tailscaleStableId: "node-abc",
    vncPort: 5900,
    ...overrides,
  };
}

describe("savedDeviceHost", () => {
  it("prefers the DNS name, then the last known IP", () => {
    expect(
      savedDeviceHost(device({ dnsName: "bay-1.ts.net", lastKnownIp: "100.64.0.2" })),
    ).toBe("bay-1.ts.net");
    expect(savedDeviceHost(device({ lastKnownIp: "100.64.0.2" }))).toBe("100.64.0.2");
  });

  it("falls back to the stable id", () => {
    expect(savedDeviceHost(device())).toBe("node-abc");
  });
});

describe("isTailnetHost", () => {
  it("matches the 100.64.0.0/10 CGNAT range", () => {
    expect(isTailnetHost("100.64.0.1")).toBe(true);
    expect(isTailnetHost("100.127.255.255")).toBe(true);
    expect(isTailnetHost("100.63.255.255")).toBe(false);
    expect(isTailnetHost("100.128.0.1")).toBe(false);
    expect(isTailnetHost("192.168.1.10")).toBe(false);
  });

  it("matches MagicDNS names but not lookalikes", () => {
    expect(isTailnetHost("bay-1.tail12345.ts.net")).toBe(true);
    expect(isTailnetHost("BAY-1.TAIL12345.TS.NET")).toBe(true);
    expect(isTailnetHost("ts.net.evil.com")).toBe(false);
    expect(isTailnetHost("example.com")).toBe(false);
  });

  it("treats LAN hostnames as direct", () => {
    expect(isTailnetHost("macbook.local")).toBe(false);
    expect(isTailnetHost("192.168.1.10")).toBe(false);
  });
});

describe("buildSavedDeviceInput", () => {
  it("routes tailnet hosts through the tailnet (no direct flag)", () => {
    const result = buildSavedDeviceInput(
      device({ dnsName: "bay-1.tail12345.ts.net" }),
      "tok",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.host).toBe("bay-1.tail12345.ts.net");
      expect(result.input.direct).toBeUndefined();
    }
  });

  it("marks LAN hosts as direct", () => {
    const result = buildSavedDeviceInput(device({ dnsName: "192.168.1.10" }), "tok");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.direct).toBe(true);
    }
  });

  it("rejects invalid ports and missing hosts", () => {
    expect(buildSavedDeviceInput(device({ vncPort: 0 }), "tok").ok).toBe(false);
    expect(
      buildSavedDeviceInput(device({ tailscaleStableId: "  " }), "tok").ok,
    ).toBe(false);
  });
});

describe("groupDevicesByCollection", () => {
  it("groups by collection and puts Ungrouped last, sorted", () => {
    const devices = [
      device({ id: "1", label: "Bay 2", collectionName: "Bays" }),
      device({ id: "2", label: "Bay 1", collectionName: "Bays" }),
      device({ id: "3", label: "Office", collectionName: "  " }),
      device({ id: "4", label: "Lobby" }),
      device({ id: "5", label: "Sim", collectionName: "Bays" }),
    ];
    const groups = groupDevicesByCollection(devices);
    expect(groups.map((g) => g.name)).toEqual(["Bays", "Ungrouped"]);
    expect(groups[0]?.devices.map((d) => d.label)).toEqual(["Bay 1", "Bay 2", "Sim"]);
    expect(groups[1]?.devices.map((d) => d.label)).toEqual(["Lobby", "Office"]);
  });

  it("returns an empty list for no devices", () => {
    expect(groupDevicesByCollection([])).toEqual([]);
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses and rejects junk", () => {
    expect(isValidEmail("user@example.test")).toBe(true);
    expect(isValidEmail("  user@example.test  ")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("missing@domain")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});
