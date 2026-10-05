import { describe, expect, it } from "vitest";
import { getDevicePresence, presenceColor, presenceLabel } from "./presence";
import type { PeerDevice } from "@nomadvnc/platform-contracts";

function peer(overrides: Partial<PeerDevice>): PeerDevice {
  return {
    stableId: "abc",
    displayName: "bay-1",
    tailnetIps: ["100.64.0.1"],
    online: true,
    os: "windows",
    lastSeen: new Date().toISOString(),
    ...overrides,
  } as PeerDevice;
}

describe("getDevicePresence", () => {
  it("online when the peer is online", () => {
    const p = getDevicePresence({ tailscaleStableId: "abc" }, [peer({ stableId: "abc", online: true })]);
    expect(p.kind).toBe("online");
    expect(p.peer?.displayName).toBe("bay-1");
  });
  it("offline when the peer is offline", () => {
    const p = getDevicePresence({ tailscaleStableId: "abc" }, [peer({ stableId: "abc", online: false })]);
    expect(p.kind).toBe("offline");
  });
  it("unknown when the peer is absent", () => {
    expect(getDevicePresence({ tailscaleStableId: "abc" }, []).kind).toBe("unknown");
  });
  it("unknown when the device has no stable id", () => {
    expect(getDevicePresence({}, [peer({})]).kind).toBe("unknown");
    expect(getDevicePresence({ tailscaleStableId: null }, [peer({})]).kind).toBe("unknown");
  });
});

describe("presenceColor / presenceLabel", () => {
  it("maps kinds to colors and labels", () => {
    expect(presenceColor("online", "#999")).toBe("#34c759");
    expect(presenceColor("offline", "#999")).toBe("#ff9f0a");
    expect(presenceColor("unknown", "#999")).toBe("#999");
    expect(presenceLabel("online")).toBe("Online");
    expect(presenceLabel("offline")).toBe("Offline");
    expect(presenceLabel("unknown")).toBe("Presence Unknown");
  });
});

describe("address-only devices", () => {
  it("report 'direct' instead of an unknown tailnet presence", () => {
    expect(getDevicePresence({ tailscaleStableId: "manual:192.168.1.20" }, []).kind).toBe("direct");
    // Legacy rows keyed by their own LAN address count too.
    expect(getDevicePresence({ tailscaleStableId: "10.0.0.5", lastKnownIp: "10.0.0.5" }, []).kind).toBe("direct");
    // Tailnet names keep tailnet presence semantics.
    expect(getDevicePresence({ tailscaleStableId: "pc.tail1.ts.net", dnsName: "pc.tail1.ts.net" }, []).kind).toBe(
      "unknown",
    );
  });
});
