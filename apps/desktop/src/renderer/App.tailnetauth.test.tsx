import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { App } from "./App";
import { persistSavedMachines } from "./localMachines";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const PEERS: PeerDevice[] = [
  {
    stableId: "peer-1",
    displayName: "Lab",
    dnsName: "lab.tail.ts.net",
    tailnetIps: ["100.64.0.10"],
    online: true,
  },
];

function createMachine(): SavedMachine {
  return {
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
}

function installNativeStub(options: { loggedIn: boolean; logoutResult?: boolean }) {
  const ensureTailnetReady = vi.fn(async () => ({ loggedIn: options.loggedIn, inMapPoll: true }));
  const logoutTailnet = vi.fn(async () => ({
    loggedIn: options.logoutResult ?? false,
    inMapPoll: true,
  }));
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady,
    getTailnetState: async () => ({ loggedIn: options.loggedIn, inMapPoll: true }),
    getTailnetPeers: async () => PEERS,
    startVncSession: async () => ({ sessionId: "session-1", wsUrl: "ws://127.0.0.1:49101" }),
    stopVncSession: async () => {},
    getSecureStorageStatus: async () => ({ available: false, platform: "linux" }),
    getMachinePassword: async () => null,
    setMachinePassword: async () => {},
    deleteMachinePassword: async () => {},
    logoutTailnet,
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
  return { ensureTailnetReady, logoutTailnet };
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

describe("App Tailscale sign-in experience", () => {
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

  async function renderApp(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    await act(async () => {});
  }

  it("offers an explicit sign-in CTA when logged out, retrying on click", async () => {
    const native = installNativeStub({ loggedIn: false });
    await renderApp();

    // Step 1 is shown initially; user chooses their mode to reveal Step 2
    click(buttonByText(container, "Continue as Local User"));
    await act(async () => {});

    const cta = buttonByText(container, "Sign In with Tailscale");
    expect(container.textContent).toContain("Sign In with Tailscale");
    // Sign-in is voluntary: launching never starts a Tailscale login (no
    // browser hand-off, no "waiting for sign-in" toast).
    expect(native.ensureTailnetReady).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Waiting for Tailscale sign-in");

    click(cta);
    await act(async () => {});

    // The explicit CTA starts it (and re-opens the browser via authUrl).
    expect(native.ensureTailnetReady).toHaveBeenCalledTimes(1);
  });

  it("signs out with confirmation and returns to the sign-in CTA", async () => {
    const native = installNativeStub({ loggedIn: true });
    persistSavedMachines([createMachine()]);
    await renderApp();

    expect(container.querySelector(".machine-card")).not.toBeNull();

    click(buttonByText(container, "Sign Out"));
    click(buttonByText(container, "Out?"));
    await act(async () => {});

    expect(native.logoutTailnet).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Signed out of Tailscale");
    expect(buttonByText(container, "Sign In with Tailscale")).not.toBeNull();
  });
});
