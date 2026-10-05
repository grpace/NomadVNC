import { isManualStableId } from "@nomadvnc/domain";
import type { PeerDevice } from "@nomadvnc/platform-contracts";

/** `direct` = saved by address: no tailnet presence to report. */
export type DevicePresenceKind = "online" | "offline" | "unknown" | "direct";

export interface DevicePresence {
  kind: DevicePresenceKind;
  peer?: PeerDevice;
}

/**
 * Classifies a saved device against tailnet discovery (desktop parity:
 * apps/desktop/src/renderer/presence.ts). `unknown` means the peer is
 * absent from the tailnet list (signed out, removed, never seen).
 */
export function getDevicePresence(
  device: { tailscaleStableId?: string | null; dnsName?: string | null; lastKnownIp?: string | null },
  peers: PeerDevice[],
): DevicePresence {
  if (!device.tailscaleStableId) {
    return { kind: "unknown" };
  }
  if (isManualStableId(device.tailscaleStableId, device.dnsName ?? undefined, device.lastKnownIp ?? undefined)) {
    return { kind: "direct" };
  }
  const peer = peers.find((p) => p.stableId === device.tailscaleStableId);
  if (!peer) {
    return { kind: "unknown" };
  }
  return { kind: peer.online ? "online" : "offline", peer };
}

export function presenceColor(kind: DevicePresenceKind, muted: string): string {
  switch (kind) {
    case "online":
      return "#34c759";
    case "offline":
      return "#ff9f0a";
    case "unknown":
    case "direct":
      return muted;
  }
}

export function presenceLabel(kind: DevicePresenceKind): string {
  switch (kind) {
    case "online":
      return "Online";
    case "offline":
      return "Offline";
    case "unknown":
      return "Presence Unknown";
    case "direct":
      return "Saved by Address";
  }
}
