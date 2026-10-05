import { beforeEach, describe, expect, it } from "vitest";
import { isManualMachine, resolveMachineHost, type PeerDevice, type SavedMachine } from "@nomadvnc/domain";
import {
  createGuestMachineFromPeer,
  createManualMachine,
  loadSavedMachines,
  persistSavedMachines,
  reconcileSavedMachines,
  setMachineCollection,
  touchSavedMachineConnection,
  upsertSavedMachine,
} from "./localMachines";

function createMachine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: overrides.id ?? "machine-1",
    ownerMode: "guest",
    collectionId: overrides.collectionId,
    label: overrides.label ?? "Primary Desktop",
    tailscaleStableId: overrides.tailscaleStableId ?? "peer-1",
    dnsName: overrides.dnsName ?? "desktop.tail.ts.net",
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
    displayName: overrides.displayName ?? "Primary Desktop",
    dnsName: overrides.dnsName ?? "desktop.tail.ts.net",
    tailnetIps: overrides.tailnetIps ?? ["100.64.0.10"],
    online: overrides.online ?? true,
    os: overrides.os,
    lastSeen: overrides.lastSeen,
  };
}

describe("localMachines", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists and reloads saved machines in label order", () => {
    const savedMachines = [
      createMachine({ id: "machine-z", label: "Zulu" }),
      createMachine({ id: "machine-a", label: "Alpha", tailscaleStableId: "peer-2" }),
    ];

    persistSavedMachines(savedMachines);

    expect(loadSavedMachines().map((machine) => machine.label)).toEqual(["Alpha", "Zulu"]);
  });

  it("creates a guest machine from peer data while preserving stable record identity", () => {
    const existingMachine = createMachine({
      id: "machine-7",
      label: "Old Label",
      createdAt: "2025-12-24T00:00:00.000Z",
      lastConnectedAt: "2026-02-10T12:00:00.000Z",
      dnsName: "old.tail.ts.net",
      lastKnownTailnetIp: "100.64.0.5",
    });

    const peer = createPeer({
      displayName: "Updated Desktop",
      dnsName: "updated.tail.ts.net",
      tailnetIps: ["100.64.0.77"],
    });

    const machine = createGuestMachineFromPeer({
      existingMachine,
      peer,
      label: "Updated Desktop",
      vncPort: 5901,
      credentialMode: "localSecure",
    });

    expect(machine.id).toBe("machine-7");
    expect(machine.createdAt).toBe(existingMachine.createdAt);
    expect(machine.label).toBe("Updated Desktop");
    expect(machine.vncPort).toBe(5901);
    expect(machine.dnsName).toBe("updated.tail.ts.net");
    expect(machine.lastKnownTailnetIp).toBe("100.64.0.77");
    expect(machine.credentialMode).toBe("localSecure");
    expect(machine.lastConnectedAt).toBe(existingMachine.lastConnectedAt);
  });

  it("reconciles saved machines with the latest peer metadata", () => {
    const machine = createMachine({
      dnsName: "old.tail.ts.net",
      lastKnownTailnetIp: "100.64.0.5",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const [reconciled] = reconcileSavedMachines([machine], [
      createPeer({
        dnsName: "new.tail.ts.net",
        tailnetIps: ["100.64.0.99"],
      }),
    ]);

    expect(reconciled.dnsName).toBe("new.tail.ts.net");
    expect(reconciled.lastKnownTailnetIp).toBe("100.64.0.99");
    expect(reconciled.updatedAt).not.toBe(machine.updatedAt);
  });

  it("updates the last-connected timestamp for the target machine only", () => {
    const first = createMachine({ id: "machine-1", label: "Alpha" });
    const second = createMachine({ id: "machine-2", label: "Beta", tailscaleStableId: "peer-2" });

    const touched = touchSavedMachineConnection([first, second], "machine-2");

    expect(touched.find((machine) => machine.id === "machine-1")?.lastConnectedAt).toBeUndefined();
    expect(touched.find((machine) => machine.id === "machine-2")?.lastConnectedAt).toBeDefined();
  });

  it("upserts by machine id instead of duplicating entries", () => {
    const original = createMachine({ id: "machine-1", label: "Alpha" });
    const replacement = createMachine({ id: "machine-1", label: "Alpha Updated", vncPort: 5901 });

    const result = upsertSavedMachine([original], replacement);

    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("Alpha Updated");
    expect(result[0]?.vncPort).toBe(5901);
  });

  it("sets, keeps, and clears the group on create", () => {
    const peer = createPeer();
    const existing = createMachine({ id: "machine-1", collectionId: "group-1" });

    expect(
      createGuestMachineFromPeer({ peer, label: "Box", vncPort: 5900, collectionId: "group-2" }).collectionId,
    ).toBe("group-2");
    expect(
      createGuestMachineFromPeer({ existingMachine: existing, peer, label: "Box", vncPort: 5900 }).collectionId,
    ).toBe("group-1");
    expect(
      createGuestMachineFromPeer({ existingMachine: existing, peer, label: "Box", vncPort: 5900, collectionId: null }).collectionId,
    ).toBeUndefined();
  });

  it("moves a machine between groups", () => {
    const machines = [
      createMachine({ id: "machine-1", label: "Alpha", collectionId: "group-1" }),
      createMachine({ id: "machine-2", label: "Beta", tailscaleStableId: "peer-2" }),
    ];

    const moved = setMachineCollection(machines, "machine-2", "group-1");
    expect(moved.find((machine) => machine.id === "machine-2")?.collectionId).toBe("group-1");

    const cleared = setMachineCollection(moved, "machine-1", undefined);
    expect(cleared.find((machine) => machine.id === "machine-1")?.collectionId).toBeUndefined();

    expect(setMachineCollection(machines, "missing", "group-1")).toBe(machines);
  });
});

describe("createManualMachine (address-only, local-first)", () => {
  it("keys the machine on its address and caches it as host or IP", () => {
    const byIp = createManualMachine({ host: " 192.168.1.20 ", label: "Office PC", vncPort: 5900 });
    expect(byIp.tailscaleStableId).toBe("manual:192.168.1.20");
    expect(byIp.lastKnownTailnetIp).toBe("192.168.1.20");
    expect(byIp.dnsName).toBeUndefined();
    expect(isManualMachine(byIp)).toBe(true);
    expect(resolveMachineHost(byIp, [])).toBe("192.168.1.20");

    const byName = createManualMachine({ host: "Office-PC.local", label: "Office", vncPort: 5901 });
    expect(byName.tailscaleStableId).toBe("manual:office-pc.local");
    expect(byName.dnsName).toBe("Office-PC.local");
  });

  it("keeps id, creation time, and credential mode when re-saving", () => {
    const first = createManualMachine({ host: "10.0.0.5", label: "Lab", vncPort: 5900, credentialMode: "localSecure" });
    const again = createManualMachine({ existingMachine: first, host: "10.0.0.5", label: "Lab 2", vncPort: 5900 });
    expect(again.id).toBe(first.id);
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.credentialMode).toBe("localSecure");
    expect(again.label).toBe("Lab 2");
  });

  it("recognizes legacy mobile rows whose stable id is the bare host", () => {
    expect(isManualMachine({ tailscaleStableId: "192.168.1.9", lastKnownTailnetIp: "192.168.1.9" })).toBe(true);
    expect(isManualMachine({ tailscaleStableId: "nAbC123CNTRL", dnsName: "box.tail.ts.net" })).toBe(false);
    // A legacy row keyed by a tailnet-only name still routes via the tailnet.
    expect(isManualMachine({ tailscaleStableId: "box.tail.ts.net", dnsName: "box.tail.ts.net" })).toBe(false);
    expect(isManualMachine({ tailscaleStableId: "100.101.1.2", lastKnownTailnetIp: "100.101.1.2" })).toBe(false);
  });
});
