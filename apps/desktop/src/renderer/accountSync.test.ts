import { beforeEach, describe, expect, it } from "vitest";
import type { Collection, SavedMachine } from "@nomadvnc/domain";
import type { BackendDeviceView } from "./accountClient";
import {
  applyServerLibrary,
  downloadAccountLibrary,
  fromDeviceView,
  loadSyncState,
  machineMatchKey,
  persistSyncState,
  pushSavedMachine,
  tailnetGateMessage,
  toDeviceUpsert,
  uploadLocalLibrary,
  type SyncClient,
} from "./accountSync";

const COLLECTIONS: Collection[] = [
  { id: "g-1", ownerMode: "guest", name: "Homelab", sortOrder: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];

function machine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: "local-1",
    ownerMode: "guest",
    label: "Lab",
    tailscaleStableId: "peer-1",
    dnsName: "lab.tail.ts.net",
    lastKnownTailnetIp: "100.64.0.10",
    vncPort: 5900,
    credentialMode: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function view(overrides: Partial<BackendDeviceView> = {}): BackendDeviceView {
  return {
    id: "server-1",
    tailscaleStableId: "peer-1",
    dnsName: "lab.tail.ts.net",
    lastKnownIp: "100.64.0.10",
    vncPort: 5900,
    label: "Lab",
    hasCredential: false,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-02T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(overrides: Partial<SyncClient> = {}): SyncClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listDevices: async () => [],
    upsertDevice: async (input) => {
      calls.push(`upsert ${input.label}`);
      return view({ label: input.label });
    },
    setDeviceCredential: async (deviceId) => {
      calls.push(`credential ${deviceId}`);
    },
    getDeviceCredential: async () => null,
    deleteDevice: async () => {},
    ...overrides,
  };
}

describe("accountSync mapping", () => {
  it("maps local machines to upserts with resolved group names", () => {
    expect(toDeviceUpsert(machine({ collectionId: "g-1" }), COLLECTIONS)).toMatchObject({
      label: "Lab",
      tailscaleStableId: "peer-1",
      vncPort: 5900,
      collectionName: "Homelab",
    });
    expect(toDeviceUpsert(machine(), COLLECTIONS).collectionName).toBeUndefined();
    expect(toDeviceUpsert(machine({ collectionId: "missing" }), COLLECTIONS).collectionName).toBeUndefined();
  });

  it("maps server views to account machines with group matching", () => {
    expect(fromDeviceView(view({ hasCredential: true, collectionName: "Homelab" }), COLLECTIONS))
      .toMatchObject({
        id: "server-1",
        ownerMode: "account",
        collectionId: "g-1",
        credentialMode: "cloudSecure",
      });
    expect(fromDeviceView(view(), COLLECTIONS)).toMatchObject({
      credentialMode: "prompt",
      collectionId: undefined,
    });
    expect(fromDeviceView(view({ collectionName: "Unknown" }), COLLECTIONS).collectionId).toBeUndefined();
  });

  it("replaces the library on download, keeping local-only overlays", () => {
    const locals = [
      machine({ id: "old-id", label: "Lab", vncUsername: "ops", lastConnectedAt: "2026-03-01T00:00:00.000Z" }),
      machine({ id: "gone", label: "Retired", tailscaleStableId: "peer-9", vncPort: 5900 }),
    ];
    const next = applyServerLibrary(locals, [view({ label: "Lab Renamed" })], COLLECTIONS);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "server-1",
      label: "Lab Renamed",
      ownerMode: "account",
      vncUsername: "ops",
      lastConnectedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("keys matches on stable id + port", () => {
    expect(machineMatchKey(machine())).toBe("peer-1:5900");
  });
});

describe("accountSync engine", () => {
  it("downloads the server library", async () => {
    const client = fakeClient({ listDevices: async () => [view({ label: "Cloud Box" })] });
    const next = await downloadAccountLibrary(client, [machine()], COLLECTIONS);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ label: "Cloud Box", ownerMode: "account" });
  });

  it("uploads locals with keyring passwords pushed alongside", async () => {
    const client = fakeClient();
    const locals = [
      machine({ id: "a", label: "A", credentialMode: "localSecure" }),
      machine({ id: "b", label: "B", credentialMode: "localSecure" }),
      machine({ id: "c", label: "C" }),
    ];
    const result = await uploadLocalLibrary(client, locals, COLLECTIONS, async (id) =>
      id === "a" ? "pw-a" : null,
    );
    expect(result).toMatchObject({ uploaded: 3, failed: [] });
    expect(result.metadataOnly).toEqual(["B"]);
    expect(client.calls).toContain("upsert A");
    expect(client.calls.filter((call) => call.startsWith("credential"))).toHaveLength(1);
  });

  it("collects per-machine upload failures without aborting", async () => {
    const client = fakeClient({
      upsertDevice: async (input) => {
        if (input.label === "Bad") {
          throw new Error("rejected");
        }
        return view({ label: input.label });
      },
    });
    const result = await uploadLocalLibrary(
      client,
      [machine({ id: "a", label: "Bad" }), machine({ id: "b", label: "Good" })],
      COLLECTIONS,
      async () => null,
    );
    expect(result.uploaded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ label: "Bad", error: "rejected" });
  });

  it("pushes one save with its password", async () => {
    const client = fakeClient();
    const pushed = await pushSavedMachine(client, machine({ label: "New" }), COLLECTIONS, "pw");
    expect(pushed.label).toBe("New");
    expect(client.calls).toEqual(["upsert New", "credential server-1"]);
  });
});

describe("accountSync state", () => {  beforeEach(() => {
    window.localStorage.clear();
  });

  it("tracks first-upload per account email", () => {
    expect(loadSyncState()).toEqual({ uploadedForEmail: null, lastAccountEmail: null });
    persistSyncState({ uploadedForEmail: "alice@example.test", lastAccountEmail: "alice@example.test" });
    expect(loadSyncState()).toEqual({
      uploadedForEmail: "alice@example.test",
      lastAccountEmail: "alice@example.test",
    });
    window.localStorage.setItem("nomadvnc.desktop.accountSync.v1", "junk");
    expect(loadSyncState()).toEqual({ uploadedForEmail: null, lastAccountEmail: null });
  });

  it("keeps lastAccountEmail across sign-out while clearing the upload marker", () => {
    persistSyncState({ uploadedForEmail: "alice@example.test", lastAccountEmail: "alice@example.test" });
    // Sign-out path: clear the marker, keep the email.
    persistSyncState({ uploadedForEmail: null, lastAccountEmail: loadSyncState().lastAccountEmail });
    expect(loadSyncState()).toEqual({ uploadedForEmail: null, lastAccountEmail: "alice@example.test" });
  });

  it("drops a non-string lastAccountEmail", () => {
    window.localStorage.setItem(
      "nomadvnc.desktop.accountSync.v1",
      JSON.stringify({ uploadedForEmail: null, lastAccountEmail: 42 }),
    );
    expect(loadSyncState()).toEqual({ uploadedForEmail: null, lastAccountEmail: null });
  });
});

describe("tailnet gate", () => {
  it("blocks only a known logged-out tailnet", () => {
    expect(tailnetGateMessage(null, "before syncing")).toBeNull();
    expect(tailnetGateMessage(undefined, "before syncing")).toBeNull();
    expect(tailnetGateMessage({ loggedIn: true }, "before syncing")).toBeNull();
    const message = tailnetGateMessage({ loggedIn: false }, "before syncing");
    expect(message).toContain("Sign in to Tailscale");
    expect(message).toContain("before syncing");
  });
});
