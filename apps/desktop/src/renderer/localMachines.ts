import { manualStableId, type PeerDevice, type SavedMachine } from "@nomadvnc/domain";

const STORAGE_KEY = "nomadvnc.desktop.savedMachines.v1";

function sortSavedMachines(machines: SavedMachine[]): SavedMachine[] {
  return [...machines].sort((left, right) => left.label.localeCompare(right.label));
}

function isSavedMachine(value: unknown): value is SavedMachine {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SavedMachine>;
  return typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.tailscaleStableId === "string"
    && typeof candidate.vncPort === "number";
}

export function loadSavedMachines(): SavedMachine[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return sortSavedMachines(parsed.filter(isSavedMachine));
  } catch {
    return [];
  }
}

export function persistSavedMachines(machines: SavedMachine[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(machines));
}

export function createGuestMachineFromPeer(input: {
  existingMachine?: SavedMachine;
  peer: PeerDevice;
  label: string;
  vncPort: number;
  credentialMode?: SavedMachine["credentialMode"];
  /** When provided (including empty string), replaces stored username; omit to keep existing. */
  vncUsername?: string;
  /**
   * Group assignment: a string id sets the group, `null` clears it,
   * `undefined` keeps the existing machine's group.
   */
  collectionId?: string | null;
}): SavedMachine {
  const now = new Date().toISOString();
  const vncUsername =
    input.vncUsername !== undefined
      ? input.vncUsername.trim() || undefined
      : input.existingMachine?.vncUsername;

  return {
    id: input.existingMachine?.id ?? crypto.randomUUID(),
    ownerMode: "guest",
    collectionId: input.collectionId !== undefined
      ? input.collectionId ?? undefined
      : input.existingMachine?.collectionId,
    label: input.label,
    tailscaleStableId: input.peer.stableId,
    dnsName: input.peer.dnsName ?? input.existingMachine?.dnsName,
    lastKnownTailnetIp: input.peer.tailnetIps[0] ?? input.existingMachine?.lastKnownTailnetIp,
    vncPort: input.vncPort,
    vncUsername,
    credentialMode: input.credentialMode ?? input.existingMachine?.credentialMode ?? "prompt",
    createdAt: input.existingMachine?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: input.existingMachine?.lastConnectedAt,
  };
}

/**
 * A machine saved by typed address (local-first: no tailnet device). It is
 * keyed `manual:<host>` and always dials directly on the OS network.
 */
export function createManualMachine(input: {
  existingMachine?: SavedMachine;
  host: string;
  label: string;
  vncPort: number;
  credentialMode?: SavedMachine["credentialMode"];
  vncUsername?: string;
  collectionId?: string | null;
}): SavedMachine {
  const now = new Date().toISOString();
  const host = input.host.trim();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  const vncUsername =
    input.vncUsername !== undefined
      ? input.vncUsername.trim() || undefined
      : input.existingMachine?.vncUsername;

  return {
    id: input.existingMachine?.id ?? crypto.randomUUID(),
    ownerMode: input.existingMachine?.ownerMode ?? "guest",
    collectionId: input.collectionId !== undefined
      ? input.collectionId ?? undefined
      : input.existingMachine?.collectionId,
    label: input.label,
    tailscaleStableId: manualStableId(host),
    dnsName: isIp ? undefined : host,
    lastKnownTailnetIp: isIp ? host : undefined,
    vncPort: input.vncPort,
    vncUsername,
    credentialMode: input.credentialMode ?? input.existingMachine?.credentialMode ?? "prompt",
    createdAt: input.existingMachine?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: input.existingMachine?.lastConnectedAt,
  };
}

export function upsertSavedMachine(machines: SavedMachine[], machine: SavedMachine): SavedMachine[] {
  const existingIndex = machines.findIndex((entry) => entry.id === machine.id);

  if (existingIndex === -1) {
    return sortSavedMachines([...machines, machine]);
  }

  const nextMachines = [...machines];
  nextMachines[existingIndex] = machine;
  return sortSavedMachines(nextMachines);
}

export function reconcileSavedMachines(machines: SavedMachine[], peers: PeerDevice[]): SavedMachine[] {
  const peerLookup = new Map(peers.map((peer) => [peer.stableId, peer]));
  let changed = false;

  const nextMachines = machines.map((machine) => {
    const peer = peerLookup.get(machine.tailscaleStableId);
    if (!peer) {
      return machine;
    }

    const nextDnsName = peer.dnsName ?? machine.dnsName;
    const nextIp = peer.tailnetIps[0] ?? machine.lastKnownTailnetIp;

    if (nextDnsName === machine.dnsName && nextIp === machine.lastKnownTailnetIp) {
      return machine;
    }

    changed = true;
    return {
      ...machine,
      dnsName: nextDnsName,
      lastKnownTailnetIp: nextIp,
      updatedAt: new Date().toISOString(),
    };
  });

  return changed ? sortSavedMachines(nextMachines) : machines;
}

export function touchSavedMachineConnection(machines: SavedMachine[], machineId: string): SavedMachine[] {
  let changed = false;
  const now = new Date().toISOString();

  const nextMachines = machines.map((machine) => {
    if (machine.id !== machineId) {
      return machine;
    }

    changed = true;
    return {
      ...machine,
      lastConnectedAt: now,
      updatedAt: now,
    };
  });

  return changed ? sortSavedMachines(nextMachines) : machines;
}

/** Moves a machine into a group (`undefined` removes it). No-op for unknown ids. */
export function setMachineCollection(
  machines: SavedMachine[],
  machineId: string,
  collectionId: string | undefined,
): SavedMachine[] {
  let changed = false;
  const nextMachines = machines.map((machine) => {
    if (machine.id !== machineId || machine.collectionId === collectionId) {
      return machine;
    }
    changed = true;
    return {
      ...machine,
      collectionId,
      updatedAt: new Date().toISOString(),
    };
  });

  return changed ? sortSavedMachines(nextMachines) : machines;
}
