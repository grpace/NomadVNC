import { describe, expect, it } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { DEFAULT_MACHINE_LIST_QUERY, filterMachines } from "./machineList";

function createMachine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: overrides.id ?? "machine-1",
    ownerMode: "guest",
    collectionId: overrides.collectionId,
    label: overrides.label ?? "Lab Desktop",
    tailscaleStableId: overrides.tailscaleStableId ?? "peer-1",
    dnsName: overrides.dnsName ?? "lab.tail.ts.net",
    lastKnownTailnetIp: overrides.lastKnownTailnetIp ?? "100.64.0.10",
    vncPort: overrides.vncPort ?? 5900,
    credentialMode: overrides.credentialMode ?? "prompt",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-02T00:00:00.000Z",
    lastConnectedAt: overrides.lastConnectedAt,
  };
}

function createPeer(overrides: Partial<PeerDevice> = {}): PeerDevice {
  return {
    stableId: overrides.stableId ?? "peer-1",
    displayName: overrides.displayName ?? "Lab",
    dnsName: overrides.dnsName ?? "lab.tail.ts.net",
    tailnetIps: overrides.tailnetIps ?? ["100.64.0.10"],
    online: overrides.online ?? true,
  };
}

const PEERS: PeerDevice[] = [
  createPeer({ stableId: "peer-1", online: true }),
  createPeer({ stableId: "peer-2", displayName: "Office", online: false }),
];

describe("filterMachines", () => {
  it("matches search text across label, host, ip, and port", () => {
    const machines = [
      createMachine({ id: "a", label: "Lab Desktop", tailscaleStableId: "peer-1" }),
      createMachine({ id: "b", label: "Office Mac", tailscaleStableId: "peer-2", dnsName: "office.tail.ts.net", lastKnownTailnetIp: "100.64.0.20" }),
    ];

    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, search: "lab" }).map((m) => m.id)).toEqual(["a"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, search: "100.64.0.20" }).map((m) => m.id)).toEqual(["b"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, search: "5900" })).toHaveLength(2);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, search: "lab 5900" }).map((m) => m.id)).toEqual(["a"]);
  });

  it("filters by online status", () => {
    const machines = [
      createMachine({ id: "a", label: "Online Box", tailscaleStableId: "peer-1" }),
      createMachine({ id: "b", label: "Offline Box", tailscaleStableId: "peer-2" }),
    ];

    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, status: "online" }).map((m) => m.id)).toEqual(["a"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, status: "offline" }).map((m) => m.id)).toEqual(["b"]);
  });

  it("filters by credential mode", () => {
    const machines = [
      createMachine({ id: "a", label: "Alpha", credentialMode: "localSecure" }),
      createMachine({ id: "b", label: "Beta", credentialMode: "prompt" }),
      createMachine({ id: "c", label: "Gamma", credentialMode: "cloudSecure" }),
    ];

    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, credential: "localSecure" }).map((m) => m.id)).toEqual(["a", "c"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, credential: "prompt" }).map((m) => m.id)).toEqual(["b"]);
  });

  it("sorts by name, recent connection, and online-first", () => {
    const machines = [
      createMachine({ id: "a", label: "Zulu", tailscaleStableId: "peer-2", lastConnectedAt: "2026-01-03T00:00:00.000Z" }),
      createMachine({ id: "b", label: "Alpha", tailscaleStableId: "peer-1", lastConnectedAt: "2026-01-01T00:00:00.000Z" }),
      createMachine({ id: "c", label: "Mid", tailscaleStableId: "peer-1" }),
    ];

    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, sort: "name" }).map((m) => m.id)).toEqual(["b", "c", "a"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, sort: "recent" }).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, sort: "online-first" }).map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("filters by group and ungrouped", () => {
    const machines = [
      createMachine({ id: "a", label: "Alpha", collectionId: "group-1" }),
      createMachine({ id: "b", label: "Beta" }),
      createMachine({ id: "c", label: "Gamma", collectionId: "group-2" }),
    ];

    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, collection: "group-1" }).map((m) => m.id)).toEqual(["a"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, collection: "ungrouped" }).map((m) => m.id)).toEqual(["b"]);
    expect(filterMachines(machines, PEERS, { ...DEFAULT_MACHINE_LIST_QUERY, collection: "all" })).toHaveLength(3);
  });
});
