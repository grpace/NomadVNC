import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import type { PeerPathInfo } from "@nomadvnc/platform-contracts";
import { App } from "./App";
import { persistSavedMachines } from "./localMachines";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createMachine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: "machine-1",
    ownerMode: "guest",
    label: "Lab Desktop",
    tailscaleStableId: "peer-1",
    dnsName: "lab.tail.ts.net",
    lastKnownTailnetIp: "100.64.0.10",
    vncPort: 5900,
    credentialMode: "localSecure",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
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

function installNativeStub(getPeerPath: (host: string) => Promise<PeerPathInfo | null>) {
  const startVncSession = vi.fn(async () => ({
    sessionId: "session-1",
    wsUrl: "ws://127.0.0.1:49101",
  }));
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetState: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetPeers: async () => PEERS,
    startVncSession,
    stopVncSession: async () => {},
    getSecureStorageStatus: async () => ({ available: false, platform: "linux" }),
    getMachinePassword: async () => "s3cret",
    setMachinePassword: async () => {},
    deleteMachinePassword: async () => {},
    getPeerPath: vi.fn(getPeerPath),
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
  return { startVncSession };
}

function buttonByTitle(container: ParentNode, title: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("title") === title,
  );
  if (!button) {
    throw new Error(`No button with title "${title}"`);
  }
  return button as HTMLButtonElement;
}

describe("App connection-path polling", () => {
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

  async function connectSeededMachine(): Promise<void> {
    const button = buttonByTitle(container, "Connect");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
  }

  it("samples the tailnet path on connect and shows the chip", async () => {
    const getPeerPath = vi.fn(async (host: string): Promise<PeerPathInfo> => ({
      host,
      found: true,
      path: "direct",
      latencyMs: 32,
    }));
    installNativeStub(getPeerPath);
    persistSavedMachines([createMachine()]);
    await renderApp();
    await connectSeededMachine();

    expect(getPeerPath).toHaveBeenCalledWith("lab.tail.ts.net");
    expect(container.querySelector(".connection-path")?.textContent).toBe("Direct · 32ms");
  });

  it("hides the chip when diagnostics fail but keeps the session", async () => {
    installNativeStub(async () => {
      throw new Error("sidecar busy");
    });
    persistSavedMachines([createMachine()]);
    await renderApp();
    await connectSeededMachine();

    expect(container.querySelector(".viewer-frame")).not.toBeNull();
    expect(container.querySelector(".connection-path")).toBeNull();
  });
});
