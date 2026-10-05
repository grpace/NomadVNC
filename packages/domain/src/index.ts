export type OwnerMode = "guest" | "account";

export type CredentialMode = "prompt" | "localSecure" | "cloudSecure";

export type ConnectionState =
  | "idle"
  | "authorizing"
  | "discoveringPeers"
  | "startingProxy"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export interface TailnetState {
  loggedIn: boolean;
  inMapPoll: boolean;
  backendState?: string;
  authUrl?: string;
  selfDeviceName?: string;
  tailscaleIpv4?: string;
  tailscaleIpv6?: string;
  /**
   * RFC3339 timestamp of when the node key expired or will expire, surfaced
   * from the sidecar. Absent for non-expiring keys or unknown state.
   */
  keyExpiry?: string;
}

export interface PeerDevice {
  stableId: string;
  displayName: string;
  dnsName?: string;
  tailnetIps: string[];
  online: boolean;
  os?: string;
  lastSeen?: string;
}

export interface Collection {
  id: string;
  ownerMode: OwnerMode;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedMachine {
  id: string;
  ownerMode: OwnerMode;
  collectionId?: string;
  label: string;
  tailscaleStableId: string;
  dnsName?: string;
  lastKnownTailnetIp?: string;
  vncPort: number;
  /** macOS Screen Sharing (ARD) expects the Mac account short name, not only a VNC password. */
  vncUsername?: string;
  credentialMode: CredentialMode;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

/**
 * Machines saved by typed address (no tailnet device) still need a stable
 * key for the `tailscaleStableId` slot: `manual:<host>`. Older mobile
 * builds stored the bare host instead, so a stable id equal to the
 * machine's own address also counts as manual — a real Tailscale stable
 * node id never equals a hostname or IP.
 */
export const MANUAL_STABLE_ID_PREFIX = "manual:";

export function manualStableId(host: string): string {
  return `${MANUAL_STABLE_ID_PREFIX}${host.trim().toLowerCase()}`;
}

/**
 * True when a host is only reachable through the tailnet: MagicDNS names
 * (`*.ts.net`) and the Tailscale CGNAT range 100.64.0.0/10.
 */
export function isTailnetAddress(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.endsWith(".ts.net")) {
    return true;
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const second = Number(m[2]);
    return Number(m[1]) === 100 && second >= 64 && second < 128;
  }
  return false;
}

export function isManualStableId(stableId: string, ...addresses: Array<string | undefined>): boolean {
  if (stableId.startsWith(MANUAL_STABLE_ID_PREFIX)) {
    return true;
  }
  // Legacy rows keyed by their own address: manual unless that address is
  // tailnet-only (those must keep dialing through the tailnet).
  const id = stableId.trim().toLowerCase();
  return (
    id !== ""
    && !isTailnetAddress(id)
    && addresses.some((address) => address !== undefined && address.trim().toLowerCase() === id)
  );
}

/** True for machines saved by address: they always dial directly, never via the tailnet. */
export function isManualMachine(machine: Pick<SavedMachine, "tailscaleStableId" | "dnsName" | "lastKnownTailnetIp">): boolean {
  return isManualStableId(machine.tailscaleStableId, machine.dnsName, machine.lastKnownTailnetIp);
}

export function resolveMachineHost(
  machine: SavedMachine,
  peers: PeerDevice[],
): string {
  const matchingPeer = peers.find((peer) => peer.stableId === machine.tailscaleStableId);
  return matchingPeer?.dnsName ?? matchingPeer?.tailnetIps[0] ?? machine.dnsName ?? machine.lastKnownTailnetIp ?? "";
}
