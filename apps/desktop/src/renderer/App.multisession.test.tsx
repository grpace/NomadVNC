import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedMachine } from "@nomadvnc/domain";
import { App } from "./App";
import { loadAppSettings } from "./appSettings";
import { persistSavedMachines } from "./localMachines";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Address-saved Macs on the LAN: they dial directly, no tailnet needed. */
function mac(index: number, overrides: Partial<SavedMachine> = {}): SavedMachine {
  const host = `10.0.0.${10 + index}`;
  return {
    id: `mac-${index}`,
    ownerMode: "guest",
    label: `Wall Mac ${index}`,
    tailscaleStableId: `manual:${host}`,
    dnsName: host,
    vncPort: 5900,
    credentialMode: "localSecure",
    collectionId: "wall",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function installNativeStub() {
  let sessionCounter = 0;
  const startVncSession = vi.fn(async () => {
    sessionCounter += 1;
    return { sessionId: `session-${sessionCounter}`, wsUrl: `ws://127.0.0.1:${49100 + sessionCounter}` };
  });
  const stopVncSession = vi.fn(async () => {});
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady: async () => ({ loggedIn: false, inMapPoll: false }),
    getTailnetState: async () => ({ loggedIn: false, inMapPoll: false }),
    getTailnetPeers: async () => [],
    getSidecarStatus: async () => ({ running: true }),
    startVncSession,
    stopVncSession,
    canUseSecureStorage: async () => true,
    getSecureStorageStatus: async () => ({ available: true, platform: "linux" }),
    getMachinePassword: async () => "pw",
    setMachinePassword: async () => {},
    deleteMachinePassword: async () => {},
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
  return { startVncSession, stopVncSession };
}

function cardFor(container: ParentNode, label: string): HTMLElement {
  const card = Array.from(container.querySelectorAll<HTMLElement>(".machine-card")).find(
    (candidate) => candidate.querySelector(".machine-name")?.textContent === label,
  );
  if (!card) {
    throw new Error(`No card for ${label}`);
  }
  return card;
}

function connectButton(card: HTMLElement): HTMLButtonElement {
  return card.querySelector(".btn--primary") as HTMLButtonElement;
}

async function clickAsync(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function tiles(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".session-tile"));
}

function tileFor(container: ParentNode, label: string): HTMLElement {
  const tile = tiles(container).find((candidate) => candidate.dataset.sessionLabel === label);
  if (!tile) {
    throw new Error(`No tile for ${label}`);
  }
  return tile;
}

/** A viewer event from one session's iframe only. */
async function viewerEvent(tile: HTMLElement, data: Record<string, unknown>): Promise<void> {
  const iframe = tile.querySelector("iframe") as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow }));
  });
}

describe("App with several sessions", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
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

  it("opens a second machine beside the first and tiles them", async () => {
    const native = installNativeStub();
    persistSavedMachines([mac(1), mac(2)]);
    await renderApp();

    await clickAsync(connectButton(cardFor(container, "Wall Mac 1")));
    // One session: no strip, the full toolbar.
    expect(container.querySelector(".session-strip")).toBeNull();
    expect(container.querySelector(".viewer-toolbar--compact")).toBeNull();

    await clickAsync(connectButton(cardFor(container, "Wall Mac 2")));

    expect(native.startVncSession).toHaveBeenCalledTimes(2);
    expect(native.stopVncSession).not.toHaveBeenCalled();
    expect(tiles(container)).toHaveLength(2);
    expect(container.querySelector(".session-grid")).not.toBeNull();
    expect(container.querySelectorAll(".viewer-toolbar--compact")).toHaveLength(2);
    expect(container.querySelectorAll('.session-strip [role="tab"]')).toHaveLength(2);
    expect(connectButton(cardFor(container, "Wall Mac 1")).textContent).toContain("Show");
  });

  it("shows an open machine instead of opening it twice", async () => {
    const native = installNativeStub();
    persistSavedMachines([mac(1), mac(2)]);
    await renderApp();
    await clickAsync(connectButton(cardFor(container, "Wall Mac 1")));
    await clickAsync(connectButton(cardFor(container, "Wall Mac 2")));
    expect(tileFor(container, "Wall Mac 2").classList).toContain("session-tile--focused");

    await clickAsync(connectButton(cardFor(container, "Wall Mac 1")));

    expect(native.startVncSession).toHaveBeenCalledTimes(2);
    expect(tileFor(container, "Wall Mac 1").classList).toContain("session-tile--focused");
  });

  it("keeps background sessions mounted in the one-at-a-time layout and remembers it", async () => {
    installNativeStub();
    persistSavedMachines([mac(1), mac(2)]);
    await renderApp();
    await clickAsync(connectButton(cardFor(container, "Wall Mac 1")));
    await clickAsync(connectButton(cardFor(container, "Wall Mac 2")));

    await clickAsync(container.querySelector('button[title="One at a Time"]') as HTMLButtonElement);

    expect(container.querySelector(".session-stack")).not.toBeNull();
    expect(tiles(container)).toHaveLength(2);
    expect(tileFor(container, "Wall Mac 1").classList).toContain("session-tile--hidden");
    expect(tileFor(container, "Wall Mac 2").classList).not.toContain("session-tile--hidden");
    expect(loadAppSettings().sessionLayout).toBe("tabs");

    // A tab brings its session forward.
    const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('.session-strip [role="tab"]'))
      .find((button) => button.textContent?.includes("Wall Mac 1")) as HTMLButtonElement;
    await clickAsync(tab);
    expect(tileFor(container, "Wall Mac 1").classList).not.toContain("session-tile--hidden");
    expect(tileFor(container, "Wall Mac 2").classList).toContain("session-tile--hidden");
  });

  it("disconnects one session and leaves the others running", async () => {
    const native = installNativeStub();
    persistSavedMachines([mac(1), mac(2)]);
    await renderApp();
    await clickAsync(connectButton(cardFor(container, "Wall Mac 1")));
    await clickAsync(connectButton(cardFor(container, "Wall Mac 2")));

    await clickAsync(container.querySelector('button[title="Disconnect Wall Mac 1"]') as HTMLButtonElement);

    expect(native.stopVncSession).toHaveBeenCalledTimes(1);
    expect(native.stopVncSession).toHaveBeenCalledWith("session-1");
    expect(tiles(container)).toHaveLength(1);
    expect(tiles(container)[0]?.dataset.sessionLabel).toBe("Wall Mac 2");
    // Back to a single session: full toolbar, no strip.
    expect(container.querySelector(".session-strip")).toBeNull();
    expect(container.querySelector(".viewer-toolbar--compact")).toBeNull();
  });

  it("reports a failure on the session it happened to", async () => {
    installNativeStub();
    persistSavedMachines([mac(1), mac(2)]);
    await renderApp();
    await clickAsync(connectButton(cardFor(container, "Wall Mac 1")));
    await clickAsync(connectButton(cardFor(container, "Wall Mac 2")));
    await viewerEvent(tileFor(container, "Wall Mac 2"), { type: "viewerState", state: "connected" });

    await viewerEvent(tileFor(container, "Wall Mac 1"), { type: "viewerState", state: "disconnected" });

    expect(tileFor(container, "Wall Mac 1").querySelector(".viewer-reconnect-overlay")).not.toBeNull();
    expect(tileFor(container, "Wall Mac 2").querySelector(".viewer-reconnect-overlay")).toBeNull();
    expect(container.querySelector(".session-tab__dot--down")).not.toBeNull();
    expect(container.querySelector(".session-tab__dot--live")).not.toBeNull();
  });

  it("connects every machine in a group and asks for passwords one at a time", async () => {
    const native = installNativeStub();
    window.localStorage.setItem(
      "nomadvnc.desktop.collections.v1",
      JSON.stringify([
        { id: "wall", ownerMode: "guest", name: "Display Wall", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    persistSavedMachines([
      mac(1),
      mac(2, { credentialMode: "prompt" }),
      mac(3),
      mac(4),
      mac(5, { collectionId: undefined, label: "Elsewhere" }),
    ]);
    await renderApp();

    const groupSelect = container.querySelector('select[aria-label="Filter by group"]') as HTMLSelectElement;
    await act(async () => {
      groupSelect.value = "wall";
      groupSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await clickAsync(container.querySelector('button[title^="Connect to Every Machine"]') as HTMLButtonElement);

    // Mac 2 asks for its password; the rest wait their turn.
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Wall Mac 2");
    expect(native.startVncSession).toHaveBeenCalledTimes(1);

    const input = container.querySelector(".password-modal__input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector(".password-modal__form") as HTMLFormElement)
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    expect(native.startVncSession).toHaveBeenCalledTimes(4);
    expect(tiles(container).map((tile) => tile.dataset.sessionLabel)).toEqual([
      "Wall Mac 1",
      "Wall Mac 2",
      "Wall Mac 3",
      "Wall Mac 4",
    ]);
    expect(container.querySelector(".session-grid")).not.toBeNull();
  });
});
