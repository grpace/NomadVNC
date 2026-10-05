import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerPanel } from "./ViewerPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      sessionId: "session-1",
      wsUrl: "ws://127.0.0.1:49001",
      label: "Lab Desktop",
      host: "lab.tail.ts.net",
      port: 5900,
    },
    viewerHtml: "<!doctype html><html><body>viewer</body></html>",
    isFullscreen: false,
    sessionKey: 0,
    onDisconnect: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onRefocusViewer: vi.fn(),
    ...overrides,
  };
}

describe("ViewerPanel reconnect", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).nomadNative = {
      readClipboard: async () => "",
      writeClipboard: async () => {},
    };
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
  });

  function renderPanel(props: ReturnType<typeof baseProps>): void {
    act(() => {
      root = createRoot(container);
      root.render(<ViewerPanel {...props} />);
    });
  }

  function reconnectButtons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Reconnect" || button.textContent === "Reconnecting…",
    ) as HTMLButtonElement[];
  }

  it("shows reconnect controls when the connection is lost", () => {
    const onReconnect = vi.fn();
    renderPanel(baseProps({ connectionLost: true, onReconnect }));

    const buttons = reconnectButtons();
    // Toolbar button + overlay card button.
    expect(buttons).toHaveLength(2);
    expect(container.querySelector(".viewer-reconnect-overlay")).not.toBeNull();

    act(() => {
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("hides reconnect controls while connected", () => {
    renderPanel(baseProps({ connectionLost: false, onReconnect: vi.fn() }));

    expect(reconnectButtons()).toHaveLength(0);
    expect(container.querySelector(".viewer-reconnect-overlay")).toBeNull();
  });

  it("disables reconnect while a reconnect attempt is in flight", () => {
    const onReconnect = vi.fn();
    renderPanel(baseProps({ connectionLost: true, isReconnecting: true, onReconnect }));

    const buttons = reconnectButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Reconnecting…");
    }

    act(() => {
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("forwards viewer connection-state transitions to the host", () => {
    const onViewerState = vi.fn();
    renderPanel(baseProps({ onViewerState }));

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "viewerState", state: "disconnected" } }),
      );
    });
    expect(onViewerState).toHaveBeenCalledWith("disconnected");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "viewerState", state: "connected" } }),
      );
    });
    expect(onViewerState).toHaveBeenCalledWith("connected");
  });
});
