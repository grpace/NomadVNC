import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { App } from "./App";

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

function installNativeStub(): void {
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetState: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetPeers: async () => PEERS,
    startVncSession: async () => ({ sessionId: "session-1", wsUrl: "ws://127.0.0.1:49101" }),
    stopVncSession: async () => {},
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
  };
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

function setSelectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function loadSavedMachines(): SavedMachine[] {
  return JSON.parse(window.localStorage.getItem("nomadvnc.desktop.savedMachines.v1") ?? "[]") as SavedMachine[];
}

describe("App groups", () => {
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

  it("saves a new machine into the selected group", async () => {
    installNativeStub();
    window.localStorage.setItem(
      "nomadvnc.desktop.collections.v1",
      JSON.stringify([
        { id: "group-1", ownerMode: "guest", name: "Homelab", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    await act(async () => {});

    act(() => {
      buttonByText(container, "+ New").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    setSelectValue(container.querySelector("#peer-select") as HTMLSelectElement, "peer-1");
    setSelectValue(container.querySelector("#machine-group") as HTMLSelectElement, "group-1");

    await act(async () => {
      buttonByText(container, "Save Machine").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const saved = loadSavedMachines();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.collectionId).toBe("group-1");
    expect(container.textContent).toContain("Saved Lab locally");
  });

  it("filters the machine list by group", async () => {
    installNativeStub();
    window.localStorage.setItem(
      "nomadvnc.desktop.collections.v1",
      JSON.stringify([
        { id: "group-1", ownerMode: "guest", name: "Homelab", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    window.localStorage.setItem(
      "nomadvnc.desktop.savedMachines.v1",
      JSON.stringify([
        { id: "a", ownerMode: "guest", label: "Lab Desktop", tailscaleStableId: "peer-1", dnsName: "lab.tail.ts.net", vncPort: 5900, credentialMode: "prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", collectionId: "group-1" },
        { id: "b", ownerMode: "guest", label: "Other Box", tailscaleStableId: "peer-1", dnsName: "lab.tail.ts.net", vncPort: 5901, credentialMode: "prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    await act(async () => {});

    expect(container.textContent).toContain("Lab Desktop");
    expect(container.textContent).toContain("Other Box");

    setSelectValue(
      container.querySelector('select[aria-label="Filter by group"]') as HTMLSelectElement,
      "group-1",
    );

    expect(container.textContent).toContain("Lab Desktop");
    expect(container.textContent).not.toContain("Other Box");
  });
});
