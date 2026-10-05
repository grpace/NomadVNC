import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { App } from "./App";
import { loadSavedMachines, persistSavedMachines } from "./localMachines";

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

interface NativeStub {
  ensureTailnetReady: ReturnType<typeof vi.fn>;
  startVncSession: ReturnType<typeof vi.fn>;
  stopVncSession: ReturnType<typeof vi.fn>;
}

function installNativeStub(): NativeStub {
  let sessionCounter = 0;
  const ensureTailnetReady = vi.fn(async () => ({ loggedIn: true, inMapPoll: true }));
  const startVncSession = vi.fn(async () => {
    sessionCounter += 1;
    return {
      sessionId: `session-${sessionCounter}`,
      wsUrl: `ws://127.0.0.1:${49100 + sessionCounter}`,
    };
  });
  const stopVncSession = vi.fn(async () => {});
  (window as unknown as Record<string, unknown>).nomadNative = {
    ensureTailnetReady,
    getTailnetState: async () => ({ loggedIn: true, inMapPoll: true }),
    getTailnetPeers: async () => PEERS,
    getSidecarStatus: async () => ({ running: true }),
    startVncSession,
    stopVncSession,
    canUseSecureStorage: async () => false,
    getSecureStorageStatus: async () => ({ available: false, platform: "linux" }),
    getMachinePassword: async () => null,
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
  return { ensureTailnetReady, startVncSession, stopVncSession };
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

async function clickAsync(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
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

async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("App session flows", () => {
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
  }

  /** Connects the seeded prompt-mode machine through the password modal. */
  async function connectSeededMachine(native: NativeStub, password: string): Promise<void> {
    click(buttonByTitle(container, "Connect"));

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("h2")?.textContent).toBe("VNC Password");

    const input = container.querySelector(".password-modal__input") as HTMLInputElement;
    const form = container.querySelector(".password-modal__form") as HTMLFormElement;
    setInputValue(input, password);
    await submitForm(form);

    expect(native.startVncSession).toHaveBeenCalledTimes(1);
    expect(native.startVncSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "lab.tail.ts.net", port: 5900 }),
    );
    expect(container.querySelector(".viewer-frame")).not.toBeNull();
    // The viewer completes its handshake: the session has been live.
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "connected" } }));
    });
  }

  it("connects a prompt-mode saved machine through the password modal", async () => {
    const native = installNativeStub();
    persistSavedMachines([createMachine()]);
    await renderApp();

    expect(container.querySelector(".machine-card")).not.toBeNull();
    expect(container.querySelector(".viewer-frame")).toBeNull();

    await connectSeededMachine(native, "s3cret");

    // Saved password is untouched for prompt-mode machines.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("auto-reconnects after the viewer reports a dropped session", async () => {
    vi.useFakeTimers();
    try {
      const native = installNativeStub();
      persistSavedMachines([createMachine()]);
      await renderApp();
      await connectSeededMachine(native, "s3cret");

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
        );
      });
      // No blocking overlay while retries are in flight; the status line
      // carries the progress instead.
      expect(container.querySelector(".viewer-reconnect-overlay")).toBeNull();
      expect(container.textContent).toContain("Retrying (1/5)");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Fresh proxy session started; dead session cleaned up best-effort.
      expect(native.startVncSession).toHaveBeenCalledTimes(2);
      expect(native.stopVncSession).toHaveBeenCalledWith("session-1");

      // The replacement's viewer reports its own failure: the SAME budget
      // continues (not a fresh one).
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
        );
      });
      expect(container.querySelector(".viewer-reconnect-overlay")).toBeNull();
      expect(container.textContent).toContain("Retrying (2/5)");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(native.startVncSession).toHaveBeenCalledTimes(3);

      // The replacement finally completes its RFB handshake: retries stop.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "viewerState", state: "connected" } }),
        );
      });
      expect(container.querySelector(".viewer-reconnect-overlay")).toBeNull();

      // A recovered session schedules no further retries.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(native.startVncSession).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a new password instead of retrying when the server rejects it", async () => {
    vi.useFakeTimers();
    try {
      const native = installNativeStub();
      persistSavedMachines([createMachine()]);
      await renderApp();
      await connectSeededMachine(native, "wrong");

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "viewerState", state: "authFailed" } }),
        );
      });
      const dialog = container.querySelector('[role="dialog"]');
      expect(dialog?.querySelector("h2")?.textContent).toBe("Wrong Password");
      expect(container.textContent).not.toContain("retrying");

      // No blind retries with the rejected password.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(native.startVncSession).toHaveBeenCalledTimes(1);

      setInputValue(container.querySelector(".password-modal__input") as HTMLInputElement, "right");
      await submitForm(container.querySelector(".password-modal__form") as HTMLFormElement);

      expect(native.startVncSession).toHaveBeenCalledTimes(2);
      const iframe = container.querySelector(".viewer-frame iframe") as HTMLIFrameElement | null;
      expect(iframe?.getAttribute("srcdoc") ?? "").toContain('"password":"right"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the session when the wrong-password prompt is cancelled", async () => {
    const native = installNativeStub();
    persistSavedMachines([createMachine()]);
    await renderApp();
    await connectSeededMachine(native, "wrong");

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "authFailed" } }));
    });
    const cancel = Array.from(container.querySelectorAll('[role="dialog"] button')).find(
      (button) => button.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;
    await clickAsync(cancel);

    expect(native.stopVncSession).toHaveBeenCalledWith("session-1");
    expect(container.querySelector(".viewer-frame")).toBeNull();
  });

  it("updates a keyring-saved password once the re-entered one connects", async () => {
    const native = installNativeStub();
    const setMachinePassword = vi.fn(async () => {});
    Object.assign((window as unknown as { nomadNative: Record<string, unknown> }).nomadNative, {
      getMachinePassword: async () => "stale",
      setMachinePassword,
    });
    persistSavedMachines([createMachine({ credentialMode: "localSecure" })]);
    await renderApp();

    await clickAsync(buttonByTitle(container, "Connect"));
    expect(native.startVncSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "authFailed" } }));
    });
    setInputValue(container.querySelector(".password-modal__input") as HTMLInputElement, "fresh");
    await submitForm(container.querySelector(".password-modal__form") as HTMLFormElement);
    expect(setMachinePassword).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "connected" } }));
    });
    expect(setMachinePassword).toHaveBeenCalledWith("machine-1", "fresh");
    expect(container.textContent).toContain("Updated the saved password");
  });

  it("shows the manual reconnect overlay after auto-reconnect retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      // The default stub resolves every proxy start (the sidecar dials the
      // VNC target lazily), so each failed retry surfaces as another viewer
      // "disconnected" event — the realistic dead-server path.
      const native = installNativeStub();
      persistSavedMachines([createMachine()]);
      await renderApp();
      await connectSeededMachine(native, "s3cret");

      const dispatchViewerDisconnected = async (): Promise<void> => {
        await act(async () => {
          window.dispatchEvent(
            new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
          );
        });
      };

      await dispatchViewerDisconnected();
      expect(container.querySelector(".viewer-reconnect-overlay")).toBeNull();

      // Five attempts with exponential backoff: 1s, 2s, 4s, 8s, 15s. Each
      // attempt's viewer reports its own failure until the budget is spent.
      for (const delay of [1000, 2000, 4000, 8000, 15000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        await dispatchViewerDisconnected();
      }

      expect(native.startVncSession).toHaveBeenCalledTimes(6);
      expect(container.querySelector(".viewer-reconnect-overlay")).not.toBeNull();
      expect(container.textContent).toContain("Couldn't reconnect to");

      // The manual Reconnect button still works after exhaustion.
      const reconnectButton = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === "Reconnect",
      ) as HTMLButtonElement;
      await clickAsync(reconnectButton);
      expect(native.startVncSession).toHaveBeenCalledTimes(7);
      expect(container.querySelector(".viewer-reconnect-overlay")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips auto-reconnect when the tailnet peer is offline", async () => {
    vi.useFakeTimers();
    try {
      const native = installNativeStub();
      persistSavedMachines([createMachine()]);
      await renderApp();
      await connectSeededMachine(native, "s3cret");

      // The peer drops off the tailnet after the session was established.
      Object.assign((window as unknown as Record<string, unknown>).nomadNative as object, {
        getTailnetPeers: async () => [{ ...PEERS[0], online: false }],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
        );
      });

      // Retrying is pointless: the manual overlay appears immediately and no
      // retry is ever scheduled.
      expect(container.querySelector(".viewer-reconnect-overlay")).not.toBeNull();
      expect(container.textContent).toContain("looks offline now");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(native.startVncSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a saved machine after confirmation", async () => {
    installNativeStub();
    persistSavedMachines([createMachine()]);
    await renderApp();

    expect(container.querySelector(".machine-card")).not.toBeNull();

    click(buttonByTitle(container, "Delete Machine"));
    click(buttonByTitle(container, "Confirm Delete"));

    expect(container.querySelector(".machine-card")).toBeNull();
    expect(container.textContent).toContain("No Saved Machines Yet");
  });

  it("exits fullscreen when disconnecting a fullscreen session", async () => {
    const native = installNativeStub();
    const getFullscreen = vi.fn(async () => true);
    const toggleFullscreen = vi.fn(async () => false);
    Object.assign((window as unknown as Record<string, unknown>).nomadNative as object, {
      getFullscreen,
      toggleFullscreen,
    });
    persistSavedMachines([createMachine()]);
    await renderApp();
    await connectSeededMachine(native, "s3cret");

    await clickAsync(buttonByTitle(container, "Disconnect Session"));

    expect(getFullscreen).toHaveBeenCalled();
    expect(toggleFullscreen).toHaveBeenCalledTimes(1);
    expect(native.stopVncSession).toHaveBeenCalledWith("session-1");
  });

  it("leaves fullscreen alone when disconnecting outside fullscreen", async () => {
    const native = installNativeStub();
    const toggleFullscreen = vi.fn(async () => false);
    Object.assign((window as unknown as Record<string, unknown>).nomadNative as object, {
      toggleFullscreen,
    });
    persistSavedMachines([createMachine()]);
    await renderApp();
    await connectSeededMachine(native, "s3cret");

    await clickAsync(buttonByTitle(container, "Disconnect Session"));

    // Stubbed getFullscreen reports false, so no toggle should happen.
    expect(toggleFullscreen).not.toHaveBeenCalled();
    expect(native.stopVncSession).toHaveBeenCalledWith("session-1");
  });

  it("connects with a manual host when no peer is selected", async () => {
    const native = installNativeStub();
    await renderApp();

    const newButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "+ New",
    ) as HTMLButtonElement;
    click(newButton);

    const hostInput = container.querySelector("#manual-host") as HTMLInputElement;
    expect(hostInput).not.toBeNull();
    setInputValue(hostInput, "100.64.0.10");

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Connect" && candidate.classList.contains("btn--full"),
    ) as HTMLButtonElement;
    await clickAsync(connectButton);

    expect(native.startVncSession).toHaveBeenCalledTimes(1);
    expect(native.startVncSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "100.64.0.10", port: 5900 }),
    );
    expect(container.querySelector(".viewer-frame")).not.toBeNull();
  });

  it("shows no sidecar banner when the backend is healthy", async () => {
    installNativeStub();
    await renderApp();
    expect(container.querySelector(".sidecar-banner")).toBeNull();
  });

  it("shows a remediation banner with retry when the sidecar failed to start", async () => {
    const native = installNativeStub();
    Object.assign((window as unknown as Record<string, unknown>).nomadNative as object, {
      getSidecarStatus: async () => ({
        running: false,
        message: "NomadVNC sidecar binary not found at /tmp/fake-sidecar",
      }),
    });
    await renderApp();

    const banner = container.querySelector(".sidecar-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("NomadVNC Backend Isn't Running");
    expect(banner?.textContent).toContain("binary not found");

    const retry = Array.from(banner?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent === "Retry",
    ) as HTMLButtonElement;
    const callsBefore = native.ensureTailnetReady.mock.calls.length;
    await clickAsync(retry);
    // Retry re-runs the interactive tailnet bring-up, which retries the sidecar.
    expect(native.ensureTailnetReady.mock.calls.length).toBe(callsBefore + 1);
  });
});

describe("App local-first direct connect", () => {
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
    vi.useRealTimers();
  });

  /** Tailnet never logs in: the local-first user with no Tailscale at all. */
  function installLoggedOutStub(): NativeStub {
    const loggedOut = { loggedIn: false, inMapPoll: false };
    const ensureTailnetReady = vi.fn(async () => loggedOut);
    const startVncSession = vi.fn(async () => ({ sessionId: "session-1", wsUrl: "ws://127.0.0.1:49101" }));
    const stopVncSession = vi.fn(async () => {});
    (window as unknown as Record<string, unknown>).nomadNative = {
      ensureTailnetReady,
      getTailnetState: async () => loggedOut,
      getTailnetPeers: async () => [],
      getSidecarStatus: async () => ({ running: true }),
      startVncSession,
      stopVncSession,
      canUseSecureStorage: async () => false,
      getSecureStorageStatus: async () => ({ available: false, platform: "linux" }),
      getMachinePassword: async () => null,
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
    return { ensureTailnetReady, startVncSession, stopVncSession };
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!button) {
      throw new Error(`No button with text "${text}"`);
    }
    return button as HTMLButtonElement;
  }

  /** Walks onboarding (Local mode -> skip Tailscale) to the connection form. */
  async function openConnectionForm(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    click(buttonByText("Continue as Local User"));
    click(buttonByText("Enter an Address"));
    expect(container.querySelector("#manual-host")).not.toBeNull();
  }

  function fillManualHost(host: string): void {
    setInputValue(container.querySelector("#manual-host") as HTMLInputElement, host);
    setInputValue(container.querySelector("#vnc-port") as HTMLInputElement, "5901");
    setInputValue(container.querySelector("#vnc-password") as HTMLInputElement, "s3cret");
  }

  it("keeps Connect disabled until a manual host is typed while the tailnet is down", async () => {
    installLoggedOutStub();
    await openConnectionForm();

    const connectButton = buttonByText("Connect");
    expect(connectButton.disabled).toBe(true);

    fillManualHost("127.0.0.1");
    expect(buttonByText("Connect").disabled).toBe(false);
  });

  it("connects to a manual host while the tailnet is down and stays direct across reconnects", async () => {
    const native = installLoggedOutStub();
    await openConnectionForm();
    fillManualHost("127.0.0.1");

    await clickAsync(buttonByText("Connect"));

    expect(native.startVncSession).toHaveBeenCalledTimes(1);
    expect(native.startVncSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 5901, direct: true }),
    );
    expect(container.querySelector(".viewer-frame")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "connected" } }));
    });

    // A dropped direct session retries on the direct path too.
    vi.useFakeTimers();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(native.startVncSession).toHaveBeenCalledTimes(2);
    expect(native.startVncSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 5901, direct: true }),
    );
  });

  it("saves an address-only machine while signed out and reconnects to it directly", async () => {
    const native = installLoggedOutStub();
    await openConnectionForm();
    fillManualHost("192.168.1.20");
    setInputValue(container.querySelector("#machine-label") as HTMLInputElement, "Office PC");

    await clickAsync(buttonByText("Save Machine"));

    const saved = loadSavedMachines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      label: "Office PC",
      tailscaleStableId: "manual:192.168.1.20",
      lastKnownTailnetIp: "192.168.1.20",
      vncPort: 5901,
    });
    expect(container.textContent).toContain("Office PC");
    expect(container.textContent).not.toContain("Not on tailnet");

    // One-click connect from the card dials directly, with no tailnet
    // (the password still in the form is reused, so no prompt).
    await clickAsync(buttonByTitle(container, "Connect"));

    expect(native.startVncSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "192.168.1.20", port: 5901, direct: true }),
    );
  });

  it("reports a first-attempt failure as 'couldn't connect' without retrying", async () => {
    vi.useFakeTimers();
    try {
      const native = installLoggedOutStub();
      await openConnectionForm();
      fillManualHost("127.0.0.1");
      await clickAsync(buttonByText("Connect"));

      // The viewer never completes a handshake (e.g. wrong port).
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }));
      });
      expect(container.textContent).toContain("Couldn't Connect");
      expect(container.textContent).toContain("Nothing answered at 127.0.0.1:5901");
      expect(container.textContent).toContain("Not connected to");
      expect(container.textContent).not.toContain("retrying");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(native.startVncSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks tailnet device sessions as non-direct", async () => {
    const native = installNativeStub();
    persistSavedMachines([createMachine()]);
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    click(buttonByTitle(container, "Connect"));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const input = container.querySelector(".password-modal__input") as HTMLInputElement;
    const form = container.querySelector(".password-modal__form") as HTMLFormElement;
    setInputValue(input, "s3cret");
    await submitForm(form);

    expect(native.startVncSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "lab.tail.ts.net", port: 5900, direct: false }),
    );
  });
});
