import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerPathInfo } from "@nomadvnc/platform-contracts";
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

async function dispatch(data: Record<string, unknown>): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

describe("ViewerPanel link health", () => {
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

  function renderPanel(overrides: Record<string, unknown> = {}): void {
    act(() => {
      if (!root) {
        root = createRoot(container);
      }
      root.render(<ViewerPanel {...baseProps(overrides)} />);
    });
  }

  function badge(): string | null | undefined {
    return container.querySelector(".viewer-toolbar-label .live-badge:not(.connection-path)")?.textContent;
  }

  it("shows Live, then Slow with latency, then back to Live", async () => {
    renderPanel({ connectionPath: null });
    await dispatch({ type: "viewerState", state: "connected" });
    expect(badge()).toBe("Live");
    await dispatch({ type: "viewerHealth", state: "slow", latencyMs: 820 });
    expect(badge()).toBe("Slow · 820ms");
    await dispatch({ type: "viewerHealth", state: "good", latencyMs: 30 });
    expect(badge()).toBe("Live");
  });

  it("explains a stall, re-samples the path once, and offers a reconnect", async () => {
    const onLinkStalled = vi.fn();
    const onReconnect = vi.fn();
    const path: PeerPathInfo = { host: "lab.tail.ts.net", found: true, path: "direct", latencyMs: 12 };
    renderPanel({ connectionPath: path, onLinkStalled, onReconnect });
    await dispatch({ type: "viewerState", state: "connected" });
    await dispatch({ type: "viewerHealth", state: "stalled" });
    await dispatch({ type: "viewerHealth", state: "stalled" });
    expect(onLinkStalled).toHaveBeenCalledTimes(1);
    expect(badge()).toBe("Not Responding");
    const banner = container.querySelector(".viewer-stall-banner");
    expect(banner?.textContent).toContain("The network reaches Lab Desktop (12 ms), but its VNC server isn't answering");
    act(() => {
      (banner?.querySelector("button") as HTMLButtonElement).click();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("clears the stall when the session drops", async () => {
    renderPanel({ connectionPath: null });
    await dispatch({ type: "viewerState", state: "connected" });
    await dispatch({ type: "viewerHealth", state: "stalled" });
    await dispatch({ type: "viewerState", state: "disconnected", reason: "stalled" });
    expect(container.querySelector(".viewer-stall-banner")).toBeNull();
  });
});
