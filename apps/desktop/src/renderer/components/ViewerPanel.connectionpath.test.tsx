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

function connectionChip(container: ParentNode): Element | null {
  return container.querySelector(".connection-path");
}

describe("ViewerPanel connection-path chip", () => {
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

  function renderPanel(connectionPath?: PeerPathInfo | null): void {
    act(() => {
      if (!root) {
        root = createRoot(container);
      }
      root.render(<ViewerPanel {...baseProps({ connectionPath })} />);
    });
  }

  it("shows a checking pill while the first sample loads", () => {
    renderPanel(undefined);
    expect(connectionChip(container)?.textContent).toBe("Checking…");
    expect(connectionChip(container)?.className).toContain("live-badge--checking");
  });

  it("hides the chip when diagnostics are unavailable", () => {
    renderPanel(null);
    expect(connectionChip(container)).toBeNull();
  });

  it("shows direct paths with latency", () => {
    renderPanel({ host: "lab.tail.ts.net", found: true, path: "direct", latencyMs: 32, endpoint: "192.0.2.1:41641" });
    expect(connectionChip(container)?.textContent).toBe("Direct · 32ms");
    expect(connectionChip(container)?.className).not.toContain("live-badge--relay");
  });

  it("shows relayed paths with region and latency", () => {
    renderPanel({ host: "lab.tail.ts.net", found: true, path: "relay", latencyMs: 240, relayRegion: "sea" });
    expect(connectionChip(container)?.textContent).toBe("Relayed · sea · 240ms");
    expect(connectionChip(container)?.className).toContain("live-badge--relay");
  });

  it("shows bare relayed paths and missing peers honestly", () => {
    renderPanel({ host: "lab.tail.ts.net", found: true, path: "relay" });
    expect(connectionChip(container)?.textContent).toBe("Relayed");

    renderPanel({ host: "lab.tail.ts.net", found: false, path: "unknown" });
    expect(connectionChip(container)?.textContent).toBe("Not on Tailnet");
  });
});
