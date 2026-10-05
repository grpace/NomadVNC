import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDevice } from "@nomadvnc/domain";
import { App } from "./App";
import { DEFAULT_ACCOUNT_BASE_URL } from "./accountConfig";
import { loadSavedMachines, persistSavedMachines } from "./localMachines";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function fakeJwt(email: string): string {
  const encode = (value: string): string =>
    btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode('{"alg":"HS256"}')}.${encode(JSON.stringify({ sub: "u-1", email }))}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface AccountKeyring {
  stored: string | null;
  setAccountToken: ReturnType<typeof vi.fn>;
  deleteAccountToken: ReturnType<typeof vi.fn>;
}

const PEERS: PeerDevice[] = [
  {
    stableId: "peer-1",
    displayName: "Lab",
    dnsName: "lab.tail.ts.net",
    tailnetIps: ["100.64.0.10"],
    online: true,
  },
];

interface NativeOptions {
  peers?: PeerDevice[];
  machinePassword?: string | null;
  secureStorageAvailable?: boolean;
  tailnetLoggedIn?: boolean;
}

function installNativeStub(
  keyring: AccountKeyring,
  options: NativeOptions = {},
): {
  startVncSession: ReturnType<typeof vi.fn>;
  fireAuthCallback: (token: string) => void;
} {
  const startVncSession = vi.fn(async () => ({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:1" }));
  const tailnetState = { loggedIn: options.tailnetLoggedIn ?? true, inMapPoll: true };
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady: async () => tailnetState,
    getTailnetState: async () => tailnetState,
    getTailnetPeers: async () => (tailnetState.loggedIn ? (options.peers ?? []) : []),
    startVncSession,
    stopVncSession: vi.fn(async () => {}),
    canUseSecureStorage: async () => options.secureStorageAvailable ?? false,
    getSecureStorageStatus: async () => ({
      available: options.secureStorageAvailable ?? false,
      platform: "linux",
    }),
    getMachinePassword: async () => options.machinePassword ?? null,
    setMachinePassword: async () => {},
    deleteMachinePassword: async () => {},
    getAccountToken: async () => keyring.stored,
    setAccountToken: keyring.setAccountToken,
    deleteAccountToken: keyring.deleteAccountToken,
    getPeerPath: async () => null,
    logoutTailnet: async () => ({ loggedIn: true, inMapPoll: true }),
    toggleFullscreen: async () => false,
    getFullscreen: async () => false,
    getWindowState: async () => ({ isFullScreen: false, isMaximized: false }),
    minimizeWindow: async () => {},
    toggleMaximizeWindow: async () => false,
    closeWindow: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => {},
    subscribe: () => () => {},
    subscribeWindowState: () => () => {},
  };
  const authCallbackListeners: ((token: string) => void)[] = [];
  (
    (window as unknown as Record<string, unknown>).nomadNative as Record<string, unknown>
  ).onAuthCallback = (listener: (token: string) => void) => {
    authCallbackListeners.push(listener);
    return () => {
      const index = authCallbackListeners.indexOf(listener);
      if (index >= 0) {
        authCallbackListeners.splice(index, 1);
      }
    };
  };
  return {
    startVncSession,
    fireAuthCallback: (token: string) => {
      for (const listener of [...authCallbackListeners]) {
        listener(token);
      }
    },
  };
}

// `fixedKeyring` below keeps the stored token in sync like the real keyring.
function fixedKeyring(stored: string | null = null): AccountKeyring {
  const keyring: AccountKeyring = {
    stored,
    setAccountToken: vi.fn(),
    deleteAccountToken: vi.fn(),
  };
  keyring.setAccountToken.mockImplementation(async (token: string) => {
    keyring.stored = token;
  });
  keyring.deleteAccountToken.mockImplementation(async () => {
    keyring.stored = null;
  });
  return keyring;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickAsync(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) {
    throw new Error(`No button "${text}"`);
  }
  return button as HTMLButtonElement;
}

describe("App account tab", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchFn);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function renderApp(
    keyring: AccountKeyring,
    options: NativeOptions = {},
  ): Promise<{ fireAuthCallback: (token: string) => void }> {
    const controls = installNativeStub(keyring, options);
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    return controls;
  }

  async function openAccountTab(): Promise<void> {
    // Signed-in tabs read "Account ✓"; match the prefix either way.
    const tab = Array.from(container.querySelectorAll(".sidebar-tab")).find((candidate) =>
      candidate.textContent?.startsWith("Account"),
    ) as HTMLButtonElement | undefined;
    if (!tab) {
      throw new Error("No Account tab");
    }
    await clickAsync(tab);
  }

  it("requests a magic link through the account tab", async () => {
    await renderApp(fixedKeyring());
    await openAccountTab();
    expect(container.querySelector("#account-email")).not.toBeNull();

    setInputValue(
      container.querySelector("#account-email") as HTMLInputElement,
      "alice@example.test",
    );
    await clickAsync(buttonByText(container, "Email Me a Sign-In Link"));
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_ACCOUNT_BASE_URL}/api/v1/auth/magic-link`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("signs in with a pasted link and persists the token to the keyring", async () => {
    const keyring = fixedKeyring();
    fetchFn.mockImplementation(async () => jsonResponse(200, { token: fakeJwt("alice@example.test") }));
    await renderApp(keyring);
    await openAccountTab();

    setInputValue(
      container.querySelector("#account-link") as HTMLInputElement,
      "https://app.example.test/auth/verify?token=tok1234567890abcd",
    );
    await clickAsync(buttonByText(container, "Sign In with This Link"));

    expect(keyring.setAccountToken).toHaveBeenCalledWith(fakeJwt("alice@example.test"));
    expect(container.textContent).toContain("alice@example.test");
    expect(buttonByText(container, "Account ✓")).toBeTruthy();
  });

  it("signs in automatically from an OS deep link", async () => {
    const keyring = fixedKeyring();
    fetchFn.mockImplementation(async () => jsonResponse(200, { token: fakeJwt("carol@example.test") }));
    const { fireAuthCallback } = await renderApp(keyring);

    await act(async () => {
      fireAuthCallback("deep-link-token-1234567890");
    });

    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_ACCOUNT_BASE_URL}/api/v1/auth/consume`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(keyring.setAccountToken).toHaveBeenCalledWith(fakeJwt("carol@example.test"));
    expect(container.textContent).toContain("carol@example.test");
    expect(buttonByText(container, "Account ✓")).toBeTruthy();
  });

  it("restores a stored session on boot and signs out cleanly", async () => {
    const keyring = fixedKeyring(fakeJwt("bob@example.test"));
    fetchFn.mockImplementation(async () => jsonResponse(200, { ok: true }));
    await renderApp(keyring);
    await openAccountTab();
    expect(container.textContent).toContain("bob@example.test");

    await clickAsync(buttonByText(container, "Sign Out of Nomad Account"));
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_ACCOUNT_BASE_URL}/api/v1/auth/logout`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(keyring.deleteAccountToken).toHaveBeenCalled();
    expect(container.querySelector("#account-email")).not.toBeNull();
  });
});

describe("App account sync", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchFn: ReturnType<typeof vi.fn>;

  const ISO = "2026-02-01T00:00:00.000Z";

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchFn);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function renderApp(keyring: AccountKeyring, options: NativeOptions = {}): Promise<void> {
    installNativeStub(keyring, options);
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
  }

  async function openAccountTab(): Promise<void> {
    const tab = Array.from(container.querySelectorAll(".sidebar-tab")).find((candidate) =>
      candidate.textContent?.startsWith("Account"),
    ) as HTMLButtonElement | undefined;
    if (!tab) {
      throw new Error("No Account tab");
    }
    await clickAsync(tab);
  }

  function seedGuestMachine(): void {
    persistSavedMachines([
      {
        id: "local-1",
        ownerMode: "guest",
        label: "Lab",
        tailscaleStableId: "peer-1",
        dnsName: "lab.tail.ts.net",
        lastKnownTailnetIp: "100.64.0.10",
        vncPort: 5900,
        credentialMode: "localSecure",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  }

  it("uploads locals on first sign-in, then adopts the server library", async () => {
    seedGuestMachine();
    const keyring = fixedKeyring();
    const seen: string[] = [];
    fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/consume")) {
        return jsonResponse(200, { token: fakeJwt("alice@example.test") });
      }
      if (url.endsWith("/api/v1/devices") && init?.method === "PUT") {
        return jsonResponse(200, {
          device: {
            id: "server-9", tailscaleStableId: "peer-1", vncPort: 5900, label: "Lab",
            hasCredential: false, createdAt: ISO, updatedAt: ISO,
          },
        });
      }
      if (url.endsWith("/api/v1/devices")) {
        return jsonResponse(200, {
          devices: [{
            id: "server-9", tailscaleStableId: "peer-1", dnsName: "lab.tail.ts.net",
            vncPort: 5900, label: "Lab", hasCredential: true,
            createdAt: ISO, updatedAt: ISO,
          }],
        });
      }
      return jsonResponse(200, { ok: true });
    });
    await renderApp(keyring, { machinePassword: "local-pw" });
    await openAccountTab();
    setInputValue(
      container.querySelector("#account-link") as HTMLInputElement,
      "https://app.example.test/auth/verify?token=tok1234567890abcd",
    );
    await clickAsync(buttonByText(container, "Sign In with This Link"));

    // Metadata upserted, keyring password pushed, then library downloaded.
    expect(seen).toContain(`PUT ${DEFAULT_ACCOUNT_BASE_URL}/api/v1/devices`);
    expect(seen).toContain(`PUT ${DEFAULT_ACCOUNT_BASE_URL}/api/v1/devices/server-9/credential`);
    const credentialCall = fetchFn.mock.calls.find(([url, init]) =>
      String(url).endsWith("/credential") && (init as RequestInit)?.method === "PUT",
    );
    expect(String((credentialCall?.[1] as RequestInit)?.body)).toContain("local-pw");

    const stored = loadSavedMachines();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "server-9",
      ownerMode: "account",
      credentialMode: "cloudSecure",
    });
    expect(container.textContent).toContain("Synced");
  });

  it("pushes saves through the server while signed in", async () => {
    const keyring = fixedKeyring(fakeJwt("alice@example.test"));
    fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v1/devices") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, { devices: [] });
      }
      if (url.endsWith("/api/v1/devices") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return jsonResponse(200, {
          device: {
            id: "server-7", tailscaleStableId: "peer-1", vncPort: 5900, label: body.label,
            hasCredential: true, createdAt: ISO, updatedAt: ISO,
          },
        });
      }
      return jsonResponse(200, { ok: true });
    });
    await renderApp(keyring, { peers: PEERS, secureStorageAvailable: true });

    await clickAsync(buttonByText(container, "+ New"));
    const select = container.querySelector("#peer-select") as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "peer-1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    setInputValue(container.querySelector("#machine-label") as HTMLInputElement, "New Box");
    setInputValue(container.querySelector("#vnc-password") as HTMLInputElement, "pw");
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    await act(async () => {});
    await clickAsync(buttonByText(container, "Save Machine"));

    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_ACCOUNT_BASE_URL}/api/v1/devices`,
      expect.objectContaining({ method: "PUT" }),
    );
    const stored = loadSavedMachines();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "server-7", ownerMode: "account", credentialMode: "cloudSecure" });
  });

  it("signs out locally when the server rejects the token", async () => {
    const keyring = fixedKeyring(fakeJwt("bob@example.test"));
    fetchFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/devices")) {
        return jsonResponse(401, { error: "Authentication required" });
      }
      return jsonResponse(200, { ok: true });
    });
    await renderApp(keyring);
    await openAccountTab();
    expect(container.querySelector("#account-email")).not.toBeNull();
    expect(keyring.stored).toBeNull();
  });
});

describe("App cloudSecure connect", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchFn);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  function seedCloudMachine(): void {
    persistSavedMachines([
      {
        id: "server-9",
        ownerMode: "account",
        label: "Cloud Box",
        tailscaleStableId: "peer-1",
        dnsName: "lab.tail.ts.net",
        lastKnownTailnetIp: "100.64.0.10",
        vncPort: 5900,
        credentialMode: "cloudSecure",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
    ]);
  }

  async function renderApp(keyring: AccountKeyring): Promise<ReturnType<typeof vi.fn>> {
    const { startVncSession } = installNativeStub(keyring, { peers: PEERS });
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    return startVncSession;
  }

  function connectButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.getAttribute("title") === "Connect",
    );
    if (!button) {
      throw new Error("No Connect button");
    }
    return button as HTMLButtonElement;
  }

  it("fetches the synced password while signed in", async () => {
    seedCloudMachine();
    const iso = "2026-02-01T00:00:00.000Z";
    fetchFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/devices")) {
        return jsonResponse(200, {
          devices: [{
            id: "server-9", tailscaleStableId: "peer-1", dnsName: "lab.tail.ts.net",
            vncPort: 5900, label: "Cloud Box", hasCredential: true,
            createdAt: iso, updatedAt: iso,
          }],
        });
      }
      if (url.endsWith("/devices/server-9/credential")) {
        return jsonResponse(200, { password: "synced-pw" });
      }
      return jsonResponse(200, { ok: true });
    });
    const startVncSession = await renderApp(fixedKeyring(fakeJwt("alice@example.test")));
    await clickAsync(connectButton());
    expect(startVncSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const credentialCall = fetchFn.mock.calls.find(([url]) =>
      String(url).endsWith("/devices/server-9/credential"),
    );
    expect(credentialCall).toBeTruthy();
  });

  it("prompts with guidance while signed out", async () => {
    seedCloudMachine();
    const startVncSession = await renderApp(fixedKeyring());
    await clickAsync(connectButton());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("signed out");
    expect(startVncSession).not.toHaveBeenCalled();

    setInputValue(
      container.querySelector(".password-modal__input") as HTMLInputElement,
      "typed-pw",
    );
    const form = container.querySelector(".password-modal__form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(startVncSession).toHaveBeenCalledTimes(1);
  });
});

describe("App sharing", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchFn: ReturnType<typeof vi.fn>;

  const ISO = "2026-02-01T00:00:00.000Z";

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchFn);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  const GRANT = {
    id: "s-1", deviceId: "server-9", granteeEmail: "bob@example.test",
    permission: "connect", hasTailnetKey: true, keyExpiresInDays: 12, createdAt: ISO,
  };

  function seedAccountMachine(): void {
    persistSavedMachines([
      {
        id: "server-9",
        ownerMode: "account",
        label: "Cloud Box",
        tailscaleStableId: "peer-1",
        dnsName: "lab.tail.ts.net",
        lastKnownTailnetIp: "100.64.0.10",
        vncPort: 5900,
        credentialMode: "cloudSecure",
        createdAt: ISO,
        updatedAt: ISO,
      },
    ]);
  }

  function routeSharing(): void {
    fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/v1/devices") && method === "PUT") {
        return jsonResponse(200, {
          device: {
            id: "server-9", tailscaleStableId: "peer-1", vncPort: 5900, label: "Cloud Box",
            hasCredential: true, createdAt: ISO, updatedAt: ISO,
          },
        });
      }
      if (url.endsWith("/api/v1/devices")) {
        return jsonResponse(200, {
          devices: [{
            id: "server-9", tailscaleStableId: "peer-1", dnsName: "lab.tail.ts.net",
            vncPort: 5900, label: "Cloud Box", hasCredential: true,
            createdAt: ISO, updatedAt: ISO,
          }],
        });
      }
      if (url.endsWith("/api/v1/devices/shared")) {
        return jsonResponse(200, {
          devices: [{
            id: "share-dev-1", tailscaleStableId: "peer-9", vncPort: 5900,
            label: "Friend Box", sharedBy: "friend@example.test",
            permission: "connect", hasTailnetKey: false, grantedAt: ISO,
          }],
        });
      }
      if (url.endsWith("/devices/server-9/shares") && method === "GET") {
        return jsonResponse(200, { shares: [GRANT] });
      }
      if (url.endsWith("/devices/server-9/shares") && method === "POST") {
        return jsonResponse(201, { share: { ...GRANT, id: "s-2" }, inviteSent: true });
      }
      if (url.endsWith("/devices/server-9/shares/s-1") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(200, { ok: true });
    });
  }

  async function renderApp(keyring: AccountKeyring): Promise<void> {
    installNativeStub(keyring, { peers: PEERS });
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
  }

  function shareButton(): HTMLButtonElement {
    const button = container.querySelector('button[title="Share Machine"]') as HTMLButtonElement | null;
    if (!button) {
      throw new Error("No Share button");
    }
    return button;
  }

  function dialogButton(text: string): HTMLButtonElement {
    const dialog = container.querySelector('[role="dialog"]');
    const button = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent === text,
    ) as HTMLButtonElement | undefined;
    if (!button) {
      throw new Error(`No dialog button "${text}"`);
    }
    return button;
  }

  it("opens the share dialog with grants and lists shared devices", async () => {
    seedAccountMachine();
    routeSharing();
    await renderApp(fixedKeyring(fakeJwt("alice@example.test")));

    expect(container.textContent).toContain("Shared With Me");
    expect(container.textContent).toContain("Friend Box");
    expect(container.textContent).toContain("friend@example.test");

    await clickAsync(shareButton());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("bob@example.test");
    expect(container.textContent).toContain("expires in 12d");
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_ACCOUNT_BASE_URL}/api/v1/devices/server-9/shares`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("grants and revokes through the dialog", async () => {
    seedAccountMachine();
    routeSharing();
    await renderApp(fixedKeyring(fakeJwt("alice@example.test")));
    await clickAsync(shareButton());

    setInputValue(
      container.querySelector("#share-email") as HTMLInputElement,
      "carol@example.test",
    );
    setInputValue(
      container.querySelector("#share-key") as HTMLInputElement,
      "tskey-auth-new",
    );
    await clickAsync(dialogButton("Share"));
    const post = fetchFn.mock.calls.find(([url, init]) =>
      String(url).endsWith("/devices/server-9/shares") && (init as RequestInit)?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(String((post?.[1] as RequestInit)?.body)).toContain("carol@example.test");

    await clickAsync(dialogButton("Revoke"));
    await clickAsync(dialogButton("Confirm"));
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_ACCOUNT_BASE_URL}/api/v1/devices/server-9/shares/s-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("App tailnet gate (sharing only)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchFn: ReturnType<typeof vi.fn>;

  const ISO = "2026-02-01T00:00:00.000Z";

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchFn);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function renderApp(keyring: AccountKeyring): Promise<void> {
    installNativeStub(keyring, { tailnetLoggedIn: false });
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
  }

  function seedAccountMachine(): void {
    persistSavedMachines([
      {
        id: "server-9",
        ownerMode: "account",
        label: "Cloud Box",
        tailscaleStableId: "peer-1",
        dnsName: "lab.tail.ts.net",
        lastKnownTailnetIp: "100.64.0.10",
        vncPort: 5900,
        credentialMode: "cloudSecure",
        createdAt: ISO,
        updatedAt: ISO,
      },
    ]);
  }

  function deviceCalls(): Array<readonly [string, RequestInit | undefined]> {
    return (fetchFn.mock.calls as Array<[string, RequestInit | undefined]>).filter(([url]) =>
      String(url).includes("/api/v1/devices"),
    );
  }

  it("syncs without the tailnet but keeps sharing gated while logged out", async () => {
    seedAccountMachine();
    await renderApp(fixedKeyring(fakeJwt("alice@example.test")));
    // Boot sync runs over plain HTTPS — no tailnet needed.
    expect(deviceCalls().length).toBeGreaterThan(0);
    // Sharing stays behind the tailnet gate.
    expect(container.textContent).not.toContain("Shared With Me");
    expect(container.querySelector('button[title="Share Machine"]')).toBeNull();

    const tab = Array.from(container.querySelectorAll(".sidebar-tab")).find((candidate) =>
      candidate.textContent?.startsWith("Account"),
    ) as HTMLButtonElement;
    await clickAsync(tab);
    await clickAsync(buttonByText(container, "Sync Now"));
    expect(container.textContent).not.toContain("Sign in to Tailscale");
  });

  it("syncs the library on sign-in without the tailnet", async () => {
    fetchFn.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/auth/consume")) {
        return jsonResponse(200, { token: fakeJwt("alice@example.test") });
      }
      return jsonResponse(200, { ok: true });
    });
    await renderApp(fixedKeyring());
    const tab = Array.from(container.querySelectorAll(".sidebar-tab")).find((candidate) =>
      candidate.textContent?.startsWith("Account"),
    ) as HTMLButtonElement;
    await clickAsync(tab);
    setInputValue(
      container.querySelector("#account-link") as HTMLInputElement,
      "https://app.example.test/auth/verify?token=tok1234567890abcd",
    );
    await clickAsync(buttonByText(container, "Sign In with This Link"));

    expect(container.textContent).toContain("alice@example.test");
    // First sign-in downloads the library over plain HTTPS — no tailnet needed.
    expect(deviceCalls().length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Sign in to Tailscale");
  });

  it("fetches the synced password and connects without the tailnet", async () => {
    seedAccountMachine();
    fetchFn.mockImplementation(async (url: string) =>
      String(url).includes("/credential")
        ? jsonResponse(200, { password: "s3cret" })
        : jsonResponse(200, { ok: true }),
    );
    const { startVncSession } = installNativeStub(fixedKeyring(fakeJwt("alice@example.test")), {
      tailnetLoggedIn: false,
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    const connect = container.querySelector('button[title="Connect"]') as HTMLButtonElement;
    await clickAsync(connect);
    expect(startVncSession).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Sign in to Tailscale");
  });
});
