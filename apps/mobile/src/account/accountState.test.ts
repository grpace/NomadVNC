import { describe, expect, it, vi } from "vitest";

// react-native-keychain is a native module; stub it so the accountSession
// import resolves under vitest. These tests inject an in-memory SecureStore
// and never touch the real Keychain.
vi.mock("react-native-keychain", () => ({
  getGenericPassword: vi.fn(async () => false),
  setGenericPassword: vi.fn(async () => true),
  resetGenericPassword: vi.fn(async () => true),
}));

import { AccountStateManager } from "./accountState";
import { AccountApiError, AccountClient } from "./accountClient";
import type { SecureStore } from "./accountSession";
import { DEFAULT_ACCOUNT_BASE_URL } from "./accountConfig";

function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
  };
}

function fakeJwt(email: string): string {
  const b64url = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `header.${b64url(JSON.stringify({ email }))}.sig`;
}

interface FakeClientOptions {
  devices?: Array<{ id: string; label: string }>;
  shared?: Array<{ id: string; label: string }>;
  consume?: (token: string) => Promise<string>;
  failDevices?: Error;
  failDelete?: Error;
}

/** Minimal stub of the AccountClient surface the manager uses. */
function fakeClient(options: FakeClientOptions = {}) {
  const calls: string[] = [];
  const client = {
    async requestMagicLink() {
      calls.push("requestMagicLink");
    },
    async consumeMagicLink(token: string) {
      calls.push("consumeMagicLink");
      if (options.consume) return options.consume(token);
      return fakeJwt("user@example.test");
    },
    async logout() {
      calls.push("logout");
    },
    async deleteAccount() {
      calls.push("deleteAccount");
      if (options.failDelete) throw options.failDelete;
    },
    async listDevices() {
      calls.push("listDevices");
      if (options.failDevices) throw options.failDevices;
      return (options.devices ?? []).map((d) => ({
        id: d.id,
        tailscaleStableId: d.id,
        vncPort: 5900,
        label: d.label,
        hasCredential: false,
        createdAt: "",
        updatedAt: "",
      }));
    },
    async listSharedDevices() {
      calls.push("listSharedDevices");
      if (options.failDevices) throw options.failDevices;
      return (options.shared ?? []).map((d) => ({
        id: d.id,
        tailscaleStableId: d.id,
        vncPort: 5900,
        label: d.label,
        sharedBy: "owner@example.test",
        permission: "connect",
        hasTailnetKey: false,
        grantedAt: "",
      }));
    },
  };
  return { client: client as unknown as AccountClient, calls };
}

function makeManager(store: SecureStore, options: FakeClientOptions = {}) {
  const { client, calls } = fakeClient(options);
  const seenBaseUrls: string[] = [];
  const manager = new AccountStateManager({
    store,
    createClient: (baseUrl, getToken) => {
      seenBaseUrls.push(baseUrl);
      void getToken;
      return client;
    },
  });
  return { manager, calls, seenBaseUrls };
}

describe("AccountStateManager.init", () => {
  it("starts signed out with defaults when storage is empty", async () => {
    const { manager } = makeManager(memoryStore());
    await manager.init();
    expect(manager.loading).toBe(false);
    expect(manager.session).toBeNull();
    expect(manager.devices).toEqual([]);
    expect(manager.config.baseUrl).toBe(DEFAULT_ACCOUNT_BASE_URL);
  });

  it("restores a persisted session and refreshes devices", async () => {
    const store = memoryStore();
    const { manager, calls } = makeManager(store, {
      devices: [{ id: "d1", label: "Bay 1" }],
      shared: [{ id: "s1", label: "Club PC" }],
    });
    // Seed a session the way saveSession would.
    await store.set(
      "nomadvnc.account.session.v1",
      JSON.stringify({ token: fakeJwt("user@example.test"), email: "user@example.test" }),
    );
    await manager.init();
    expect(manager.session?.email).toBe("user@example.test");
    expect(manager.devices.map((d) => d.label)).toEqual(["Bay 1"]);
    expect(manager.sharedDevices.map((d) => d.label)).toEqual(["Club PC"]);
    expect(calls).toContain("listDevices");
  });
});

describe("AccountStateManager.completeLogin", () => {
  it("rejects input with no token", async () => {
    const { manager } = makeManager(memoryStore());
    await manager.init();
    await expect(manager.completeLogin("hello world")).rejects.toThrow(/sign-in token/);
    expect(manager.session).toBeNull();
  });

  it("consumes the token, persists the session, and loads devices", async () => {
    const store = memoryStore();
    const { manager, calls } = makeManager(store, {
      devices: [{ id: "d1", label: "Bay 1" }],
    });
    await manager.init();
    await manager.completeLogin("https://api.example.test/verify?token=magic_123");
    expect(calls).toContain("consumeMagicLink");
    expect(manager.session?.email).toBe("user@example.test");
    expect(manager.session?.token).toContain(".");
    const raw = await store.get("nomadvnc.account.session.v1");
    expect(raw).toContain(manager.session?.token);
    expect(manager.devices.map((d) => d.label)).toEqual(["Bay 1"]);
    expect(manager.error).toBeNull();
  });

  it("leaves state untouched when the token is rejected", async () => {
    const { manager } = makeManager(memoryStore(), {
      consume: async () => {
        throw new AccountApiError(401, "Invalid or expired link");
      },
    });
    await manager.init();
    await expect(manager.completeLogin("magic_bad_token_12345678")).rejects.toThrow(
      /Invalid or expired/,
    );
    expect(manager.session).toBeNull();
    expect(manager.devices).toEqual([]);
  });
});

describe("AccountStateManager.logout", () => {
  it("clears the session, devices, and persisted storage", async () => {
    const store = memoryStore();
    const { manager, calls } = makeManager(store);
    await manager.init();
    await manager.completeLogin("https://api.example.test/verify?token=magic_123");
    expect(manager.session).not.toBeNull();
    await manager.logout();
    expect(calls).toContain("logout");
    expect(manager.session).toBeNull();
    expect(manager.devices).toEqual([]);
    expect(manager.sharedDevices).toEqual([]);
    expect(await store.get("nomadvnc.account.session.v1")).toBeNull();
  });
});

describe("AccountStateManager.deleteAccount", () => {
  it("deletes on the server, then clears the local session", async () => {
    const store = memoryStore();
    const { manager, calls } = makeManager(store, { devices: [{ id: "d1", label: "Lab" }] });
    await manager.init();
    await manager.completeLogin("https://api.example.test/verify?token=magic_123");
    await manager.deleteAccount();
    expect(calls).toContain("deleteAccount");
    expect(manager.session).toBeNull();
    expect(manager.devices).toEqual([]);
    expect(await store.get("nomadvnc.account.session.v1")).toBeNull();
  });

  it("keeps the user signed in when the server refuses", async () => {
    const store = memoryStore();
    const { manager } = makeManager(store, { failDelete: new Error("Server unreachable") });
    await manager.init();
    await manager.completeLogin("https://api.example.test/verify?token=magic_123");
    await expect(manager.deleteAccount()).rejects.toThrow("Server unreachable");
    expect(manager.session).not.toBeNull();
    expect(await store.get("nomadvnc.account.session.v1")).not.toBeNull();
  });
});

describe("AccountStateManager.refreshDevices", () => {
  it("signs out locally on 401 (stale token fails closed)", async () => {
    const store = memoryStore();
    const { manager } = makeManager(store, {
      failDevices: new AccountApiError(401, "Unauthorized"),
    });
    await manager.init();
    await manager.completeLogin("https://api.example.test/verify?token=magic_123");
    expect(manager.session).toBeNull();
    expect(manager.error).toMatch(/expired/);
    expect(await store.get("nomadvnc.account.session.v1")).toBeNull();
  });

  it("keeps the session and surfaces the error on other failures", async () => {
    const { manager } = makeManager(memoryStore(), {
      failDevices: new AccountApiError(0, "Account server unreachable: boom"),
    });
    await manager.init();
    await manager.completeLogin("https://api.example.test/verify?token=magic_123");
    expect(manager.session).not.toBeNull();
    expect(manager.error).toMatch(/unreachable/);
  });

  it("is a no-op when signed out", async () => {
    const { manager, calls } = makeManager(memoryStore());
    await manager.init();
    await manager.refreshDevices();
    expect(calls).not.toContain("listDevices");
  });
});

describe("AccountStateManager.saveConfig", () => {
  it("rejects invalid URLs", async () => {
    const { manager } = makeManager(memoryStore());
    await manager.init();
    await expect(manager.saveConfig("not a url")).rejects.toThrow(/valid server URL/);
    expect(manager.config.baseUrl).toBe(DEFAULT_ACCOUNT_BASE_URL);
  });

  it("persists and rebuilds the client on a valid URL", async () => {
    const store = memoryStore();
    const { manager, seenBaseUrls } = makeManager(store);
    await manager.init();
    await manager.saveConfig("https://selfhosted.example.test/");
    expect(manager.config.baseUrl).toBe("https://selfhosted.example.test");
    expect(seenBaseUrls.at(-1)).toBe("https://selfhosted.example.test");
    const raw = await store.get("nomadvnc.account.config.v1");
    expect(raw).toContain("selfhosted.example.test");
  });
});

describe("AccountStateManager.subscribe", () => {
  it("notifies listeners on state changes", async () => {
    const { manager } = makeManager(memoryStore());
    let notifications = 0;
    const unsubscribe = manager.subscribe(() => {
      notifications += 1;
    });
    await manager.init();
    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
    const before = notifications;
    await manager.refreshDevices(); // signed out → no-op, no notify
    expect(notifications).toBe(before);
  });
});
