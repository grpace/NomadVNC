import { describe, expect, it } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import {
  formatLastSeenSuffix,
  formatRelativeTime,
  getMachinePresence,
} from "./presence";

function createMachine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: "machine-1",
    ownerMode: "guest",
    label: "Lab Desktop",
    tailscaleStableId: "peer-1",
    dnsName: "cached.tail.ts.net",
    lastKnownTailnetIp: "100.64.0.10",
    vncPort: 5900,
    credentialMode: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function createPeer(overrides: Partial<PeerDevice> = {}): PeerDevice {
  return {
    stableId: "peer-1",
    displayName: "Lab",
    dnsName: "live.tail.ts.net",
    tailnetIps: ["100.64.0.99"],
    online: true,
    ...overrides,
  };
}

describe("getMachinePresence", () => {
  it("reports online with the live peer host", () => {
    const presence = getMachinePresence(createMachine(), [createPeer({ online: true })]);
    expect(presence.kind).toBe("online");
    expect(presence.peer?.stableId).toBe("peer-1");
    expect(presence.host).toBe("live.tail.ts.net");
  });

  it("reports offline but keeps resolving the cached host", () => {
    const presence = getMachinePresence(createMachine(), [createPeer({ online: false })]);
    expect(presence.kind).toBe("offline");
    expect(presence.host).toBe("live.tail.ts.net");
  });

  it("reports unknown with the cached host when the peer is absent", () => {
    const presence = getMachinePresence(createMachine(), []);
    expect(presence.kind).toBe("unknown");
    expect(presence.peer).toBeUndefined();
    expect(presence.host).toBe("cached.tail.ts.net");
  });
});

describe("formatRelativeTime", () => {
  it("returns null for missing or invalid input", () => {
    expect(formatRelativeTime(undefined)).toBeNull();
    expect(formatRelativeTime("")).toBeNull();
    expect(formatRelativeTime("not-a-date")).toBeNull();
  });

  it("buckets recent timestamps", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 10_000).toISOString())).toBe("Just now");
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });

  it("builds last-seen suffixes with natural casing", () => {
    const now = Date.now();
    expect(formatLastSeenSuffix(new Date(now - 10_000).toISOString())).toBe("last seen just now");
    expect(formatLastSeenSuffix(new Date(now - 5 * 60_000).toISOString())).toBe("last seen 5m ago");
    expect(formatLastSeenSuffix(undefined)).toBeNull();
  });
});
