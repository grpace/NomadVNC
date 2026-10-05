import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedMachine, TailnetState } from "@nomadvnc/domain";
import { App } from "./App";
import { persistSavedMachines } from "./localMachines";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 86_400_000;

function iso(offsetMs: number): string {
  // Buffer keeps whole-day expectations stable against clock skew between
  // stub install and render (describeKeyExpiry floors to whole days).
  return new Date(Date.now() + offsetMs + 60_000).toISOString();
}

function installNativeStub(tailnetState: TailnetState) {
  const ensureTailnetReady = vi.fn(async () => ({ ...tailnetState }));
  const resetTailnetIdentity = vi.fn(async () => ({ loggedIn: false, inMapPoll: false }));
  const reauthenticateTailnet = vi.fn(async () => ({ ...tailnetState, authUrl: "https://login.example.test/a/1" }));
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady,
    getTailnetState: async () => ({ ...tailnetState }),
    getTailnetPeers: async () => [],
    getSidecarStatus: async () => ({ running: true }),
    startVncSession: async () => ({ sessionId: "session-1", wsUrl: "ws://127.0.0.1:49101" }),
    stopVncSession: async () => {},
    getSecureStorageStatus: async () => ({ available: false, platform: "linux" }),
    getMachinePassword: async () => null,
    setMachinePassword: async () => {},
    deleteMachinePassword: async () => {},
    logoutTailnet: async () => ({ loggedIn: false, inMapPoll: false }),
    resetTailnetIdentity,
    reauthenticateTailnet,
    toggleFullscreen: async () => false,
    getWindowState: async () => ({ isFullScreen: false, isMaximized: false }),
    minimizeWindow: async () => {},
    toggleMaximizeWindow: async () => false,
    closeWindow: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => {},
    subscribe: () => () => {},
    subscribeWindowState: () => () => {},
  };
  return { ensureTailnetReady, resetTailnetIdentity, reauthenticateTailnet };
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`No button with text "${text}"`);
  }
  return button as HTMLButtonElement;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function mountApp(container: HTMLDivElement): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  return root;
}

describe("App tailnet key-expiry nudge", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

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
  });

  it("stays quiet for a key with distant expiry", async () => {
    installNativeStub({ loggedIn: true, inMapPoll: true, keyExpiry: iso(90 * DAY_MS) });
    root = await mountApp(container);

    expect(container.querySelector(".tailnet-banner")).toBeNull();
    expect(container.textContent).toContain("Tailnet online");
  });

  it("warns about an expiring key and re-authenticates on demand", async () => {
    const { ensureTailnetReady, reauthenticateTailnet } = installNativeStub({
      loggedIn: true,
      inMapPoll: true,
      keyExpiry: iso(3 * DAY_MS),
    });
    root = await mountApp(container);

    const banner = container.querySelector(".tailnet-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Tailscale Key Expiring Soon");
    expect(banner?.textContent).toContain("3 days");
    expect(container.textContent).toContain("key expires in 3 days");

    // Launch is passive: no interactive login until the user asks.
    expect(ensureTailnetReady).not.toHaveBeenCalled();
    click(buttonByText(container, "Re-authenticate"));
    await act(async () => {});
    expect(reauthenticateTailnet).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Continue Tailscale sign-in in your browser");
  });

  it("offers sign-in and identity reset when the key has expired", async () => {
    const { ensureTailnetReady, resetTailnetIdentity } = installNativeStub({
      loggedIn: true,
      inMapPoll: true,
      keyExpiry: iso(-2 * DAY_MS),
    });
    root = await mountApp(container);

    const banner = container.querySelector(".tailnet-banner--expired");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Tailscale Sign-In Expired");
    expect(container.textContent).toContain("Tailscale key expired");

    click(buttonByText(container, "Reset Device Identity"));
    await act(async () => {});
    expect(resetTailnetIdentity).toHaveBeenCalledTimes(1);
    // After a reset the app starts the login flow again (and only then —
    // launch itself never starts one).
    expect(ensureTailnetReady).toHaveBeenCalledTimes(1);
  });

  it("drives the sidebar identity-reset confirmation flow", async () => {
    const { resetTailnetIdentity } = installNativeStub({ loggedIn: true, inMapPoll: true });
    const machine: SavedMachine = {
      id: "machine-1",
      ownerMode: "guest",
      label: "Lab Desktop",
      tailscaleStableId: "peer-1",
      dnsName: "lab.tail.ts.net",
      lastKnownTailnetIp: "100.64.0.10",
      vncPort: 5900,
      credentialMode: "prompt",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    persistSavedMachines([machine]);
    root = await mountApp(container);

    click(buttonByText(container, "Sign Out"));
    click(buttonByText(container, "Reset…"));
    expect(container.textContent).toContain("New identity?");
    click(buttonByText(container, "Reset"));
    await act(async () => {});
    expect(resetTailnetIdentity).toHaveBeenCalledTimes(1);
  });
});
