import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
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
    credentialMode: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function createPeer(overrides: Partial<PeerDevice> = {}): PeerDevice {
  return {
    stableId: "peer-1",
    displayName: "Lab",
    dnsName: "lab.tail.ts.net",
    tailnetIps: ["100.64.0.10"],
    online: true,
    ...overrides,
  };
}

interface NativeStubs {
  startVncSession: ReturnType<typeof vi.fn>;
  stopVncSession: ReturnType<typeof vi.fn>;
}

function installNativeStub(peers: PeerDevice[], overrides: Record<string, unknown> = {}): NativeStubs {
  const startVncSession = vi.fn(async () => ({ sessionId: "session-1", wsUrl: "ws://127.0.0.1:49101" }));
  const stopVncSession = vi.fn(async () => {});
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetState: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetPeers: async () => peers,
    startVncSession,
    stopVncSession,
    getSecureStorageStatus: async () => ({ available: false, platform: "linux" }),
    getMachinePassword: async () => null,
    setMachinePassword: async () => {},
    deleteMachinePassword: async () => {},
    toggleFullscreen: async () => false,
    getWindowState: async () => ({ isFullScreen: false, isMaximized: false }),
    minimizeWindow: async () => {},
    toggleMaximizeWindow: async () => false,
    closeWindow: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => {},
    subscribe: () => () => {},
    subscribeWindowState: () => () => {},
    ...overrides,
  };
  return { startVncSession, stopVncSession };
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

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("App honest presence errors", () => {
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
    // Let the boot tailnet refresh land so peer state is current.
    await act(async () => {});
  }

  it("blocks connect with a last-seen note when the peer is offline", async () => {
    const native = installNativeStub([
      createPeer({ online: false, lastSeen: new Date(Date.now() - 5 * 60_000).toISOString() }),
    ]);
    persistSavedMachines([createMachine()]);
    await renderApp();

    click(buttonByTitle(container, "Connect"));

    expect(native.startVncSession).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('"Lab Desktop" looks offline (last seen 5m ago)');
  });

  it("reports a tailnet-path failure when the proxy cannot start", async () => {
    const startVncSession = vi.fn(async () => {
      throw new Error("tailnet login incomplete");
    });
    installNativeStub([createPeer({ online: true })], {
      startVncSession,
      getMachinePassword: async () => "s3cret",
    });
    persistSavedMachines([createMachine({ credentialMode: "localSecure" })]);
    await renderApp();

    click(buttonByTitle(container, "Connect"));
    await act(async () => {});

    expect(startVncSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Couldn't open a VNC path to lab.tail.ts.net:5900 through the tailnet",
    );
  });

  it("distinguishes a dead VNC server from an offline host on viewer drop", async () => {
    vi.useFakeTimers();
    try {
      const { startVncSession } = installNativeStub([createPeer({ online: true })], {
        getMachinePassword: async () => "s3cret",
      });
      // The VNC server is dead: every proxy starts fine (the sidecar dials
      // lazily), so each failed retry surfaces as another viewer
      // "disconnected" event — the realistic dead-server path.
      persistSavedMachines([createMachine({ credentialMode: "localSecure" })]);
      await renderApp();

      click(buttonByTitle(container, "Connect"));
      await act(async () => {});
      expect(container.querySelector(".viewer-frame")).not.toBeNull();
      // The session was live before the server died.
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "connected" } }));
      });

      const dispatchViewerDisconnected = async (): Promise<void> => {
        await act(async () => {
          window.dispatchEvent(
            new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
          );
        });
      };

      await dispatchViewerDisconnected();
      // Retries go first; the honest diagnosis lands after the budget is spent.
      expect(container.textContent).toContain("Retrying (1/5)");
      expect(container.querySelector(".viewer-reconnect-overlay")).toBeNull();
      for (const delay of [1000, 2000, 4000, 8000, 15000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        await dispatchViewerDisconnected();
      }
      expect(startVncSession).toHaveBeenCalledTimes(6);
      expect(container.querySelector(".viewer-reconnect-overlay")).not.toBeNull();
      expect(container.textContent).toContain(
        'Its VNC server at lab.tail.ts.net:5900 may have stopped',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
