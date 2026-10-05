import { isManualMachine, type PeerDevice, type SavedMachine } from "@nomadvnc/domain";

export type MachineStatusFilter = "all" | "online" | "offline";
export type MachineCredentialFilter = "all" | "localSecure" | "prompt";
export type MachineSortKey = "name" | "recent" | "online-first";

export interface MachineListQuery {
  search: string;
  status: MachineStatusFilter;
  credential: MachineCredentialFilter;
  sort: MachineSortKey;
  /** "all" | "ungrouped" | a collection id. */
  collection: string;
}

export const DEFAULT_MACHINE_LIST_QUERY: MachineListQuery = {
  search: "",
  status: "all",
  credential: "all",
  sort: "name",
  collection: "all",
};

function isMachineOnline(machine: SavedMachine, peers: PeerDevice[]): boolean {
  return peers.some((peer) => peer.stableId === machine.tailscaleStableId && peer.online);
}

function matchesSearch(machine: SavedMachine, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = [
    machine.label,
    machine.dnsName ?? "",
    machine.lastKnownTailnetIp ?? "",
    String(machine.vncPort),
  ]
    .join(" ")
    .toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function compareByName(left: SavedMachine, right: SavedMachine): number {
  return left.label.localeCompare(right.label);
}

function compareByRecent(left: SavedMachine, right: SavedMachine): number {
  if (!left.lastConnectedAt && !right.lastConnectedAt) {
    return compareByName(left, right);
  }
  if (!left.lastConnectedAt) {
    return 1;
  }
  if (!right.lastConnectedAt) {
    return -1;
  }
  const diff = right.lastConnectedAt.localeCompare(left.lastConnectedAt);
  return diff !== 0 ? diff : compareByName(left, right);
}

/**
 * Filters + sorts the saved-machine library for the QuickConnect list.
 * Pure helper so the UI stays thin and the behavior is unit-testable.
 */
export function filterMachines(
  machines: SavedMachine[],
  peers: PeerDevice[],
  query: MachineListQuery,
): SavedMachine[] {
  const onlineLookup = new Map<string, boolean>();
  for (const machine of machines) {
    if (!onlineLookup.has(machine.tailscaleStableId)) {
      onlineLookup.set(machine.tailscaleStableId, isMachineOnline(machine, peers));
    }
  }

  const filtered = machines.filter((machine) => {
    if (!matchesSearch(machine, query.search)) {
      return false;
    }
    if (query.status !== "all") {
      // Address-only machines have no presence signal: they are neither
      // "online" nor "offline", so status filters leave them out.
      if (isManualMachine(machine)) {
        return false;
      }
      const online = onlineLookup.get(machine.tailscaleStableId) ?? false;
      if (query.status === "online" && !online) {
        return false;
      }
      if (query.status === "offline" && online) {
        return false;
      }
    }
    // The "Secured" filter covers any stored password, local or synced.
    if (query.credential === "localSecure" && machine.credentialMode === "prompt") {
      return false;
    }
    if (query.credential === "prompt" && machine.credentialMode !== "prompt") {
      return false;
    }
    if (query.collection === "ungrouped" && machine.collectionId !== undefined) {
      return false;
    }
    if (query.collection !== "all" && query.collection !== "ungrouped"
      && machine.collectionId !== query.collection) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered];
  if (query.sort === "recent") {
    sorted.sort(compareByRecent);
  } else if (query.sort === "online-first") {
    sorted.sort((left, right) => {
      const leftOnline = onlineLookup.get(left.tailscaleStableId) ?? false;
      const rightOnline = onlineLookup.get(right.tailscaleStableId) ?? false;
      if (leftOnline !== rightOnline) {
        return leftOnline ? -1 : 1;
      }
      return compareByName(left, right);
    });
  } else {
    sorted.sort(compareByName);
  }
  return sorted;
}
