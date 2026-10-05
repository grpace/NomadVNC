import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { isManualMachine, resolveMachineHost } from "@nomadvnc/domain";

/**
 * `direct` = saved by address (no tailnet device): reachability isn't
 * knowable without dialing, so it is neither online nor offline.
 */
export type MachinePresenceKind = "online" | "offline" | "unknown" | "direct";

export interface MachinePresence {
  kind: MachinePresenceKind;
  peer?: PeerDevice;
  /** Best host string: live peer data preferred, cached machine fallback. */
  host: string;
}

/**
 * Classifies a saved machine against the latest tailnet discovery.
 * `unknown` means the peer is entirely absent from the tailnet list
 * (signed out, removed, or never seen) — distinct from `offline`.
 */
export function getMachinePresence(machine: SavedMachine, peers: PeerDevice[]): MachinePresence {
  if (isManualMachine(machine)) {
    return { kind: "direct", host: resolveMachineHost(machine, []) };
  }
  const peer = peers.find((candidate) => candidate.stableId === machine.tailscaleStableId);
  if (!peer) {
    return { kind: "unknown", host: resolveMachineHost(machine, peers) };
  }
  return {
    kind: peer.online ? "online" : "offline",
    peer,
    host: resolveMachineHost(machine, peers),
  };
}

/**
 * Relative timestamp ("Just now", "5m ago", …) or `null` when there is
 * nothing meaningful to show. Never throws.
 */
export function formatRelativeTime(value?: string): string | null {
  if (!value) {
    return null;
  }
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) {
      return "Just now";
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  } catch {
    return null;
  }
}

/**
 * "last seen …" suffix for offline messaging, or `null` when the peer has
 * no usable last-seen timestamp.
 */
export function formatLastSeenSuffix(value?: string): string | null {
  const relative = formatRelativeTime(value);
  if (!relative) {
    return null;
  }
  if (relative === "Just now") {
    return "last seen just now";
  }
  return `last seen ${relative}`;
}
